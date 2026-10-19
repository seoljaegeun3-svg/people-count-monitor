const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createComparisonSettings } = require('./comparison-config');

async function fixture(t, contents) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'comparison-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings', 'comparison.json');
  if (contents !== undefined) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }
  const source = { key: 'trusted-camera-url-and-view-bounds', width: 1280, height: 720 };
  let available = true;
  const capture = async options => available ? options?.identityOnly ? { ...source } : {
    key: source.key,
    image: { getSize: () => ({ width: source.width, height: source.height }), isEmpty: () => false, toDataURL: () => 'data:image/png;base64,fixture' }
  } : null;
  return { store: await createComparisonSettings({ filePath, capture }), source, filePath, capture, unavailable() { available = false; } };
}

test('comparison stays unconfigured for absent, corrupt, or untrusted persisted calibration', async t => {
  for (const contents of [undefined, '{bad json', JSON.stringify({ configured: true, region: { x: 0, y: 0, width: 1, height: 1 } })]) {
    const f = await fixture(t, contents);
    assert.equal(f.store.get().configured, false);
    assert.equal(f.store.get().mapping, 'unknown');
    const copied = f.store.get(); copied.region.x = .5; copied.line.invert = true;
    assert.equal(f.store.get().region.x, 0);
    assert.equal(f.store.get().line.invert, false);
  }
});

test('saving requires reviewed trusted camera identity and atomically preserves calibration across restarts', async t => {
  const f = await fixture(t);
  const config = { ...f.store.get(), configured: true, mapping: 'occupancy', region: { x: .1, y: .2, width: .5, height: .6 } };
  await assert.rejects(f.store.save(config), /미리보기/);
  assert.equal(f.store.get().configured, false);
  assert.deepEqual(await f.store.preview(), { image: 'data:image/png;base64,fixture', ...f.source });
  const saved = await f.store.save(config);
  assert.equal(saved.configured, true);
  assert.deepEqual(saved.source, f.source);
  saved.source.key = 'mutated'; saved.region.width = 1;
  assert.equal(f.store.get().source.key, f.source.key);
  const reopened = await createComparisonSettings({ filePath: f.filePath, capture: f.capture });
  assert.deepEqual(reopened.get(), f.store.get());
  assert.deepEqual(await fs.readdir(path.dirname(f.filePath)), ['comparison.json']);
});

test('forged sources and camera changes cannot authorize discarding clips', async t => {
  const f = await fixture(t);
  await f.store.preview();
  const input = { ...f.store.get(), configured: true };
  await assert.rejects(f.store.save({ ...input, source: f.source }), /미리보기/);
  await assert.rejects(f.store.save({ ...input, key: f.source.key }), /미리보기/);
  f.source.width = 1920;
  await assert.rejects(f.store.save(input), /바뀌었습니다/);
  assert.equal(f.store.get().configured, false);
  await assert.rejects(f.store.save(input), /미리보기/);
  await f.store.preview();
  f.source.key = 'different-camera';
  await assert.rejects(f.store.save(input), /바뀌었습니다/);
  await f.store.preview(); f.unavailable();
  await assert.rejects(f.store.save(input), /확인하지 못했습니다/);
  assert.equal(f.store.get().configured, false);
});

test('invalid ROI, direction, PLC mapping, and confidence never overwrite a valid configuration', async t => {
  const f = await fixture(t);
  await f.store.preview();
  const valid = { ...f.store.get(), configured: true };
  await f.store.save(valid);
  for (const change of [
    { region: { x: .8, y: 0, width: .3, height: 1 } },
    { region: { x: 0, y: 0, width: .04, height: 1 } },
    { region: { x: NaN, y: 0, width: .5, height: 1 } },
    { sensitivity: 'bogus' }, { line: { axis: 'diagonal', position: .5, invert: false } },
    { line: { axis: 'vertical', position: .05, invert: false } },
    { line: { axis: 'vertical', position: .5, invert: 'false' } },
    { mapping: 'trust-always' }, { confidence: .1 }, { confidence: .9 }, { confidence: Infinity }
  ]) {
    await assert.rejects(f.store.save({ ...valid, ...change }));
    assert.deepEqual(JSON.parse(await fs.readFile(f.filePath, 'utf8')), f.store.get());
  }
});

test('failed writes preserve previous settings and leave no temporary files', async t => {
  const f = await fixture(t);
  await f.store.preview();
  const config = { ...f.store.get(), configured: true };
  await fs.mkdir(f.filePath, { recursive: true });
  await assert.rejects(f.store.save(config));
  assert.equal(f.store.get().configured, false);
  assert.deepEqual(await fs.readdir(path.dirname(f.filePath)), ['comparison.json']);
});
