const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

async function fixture(t, convert, filesystem = fs, options = {}) {
  const { autoWatermark = true, timers, ...managerOptions } = options;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'people-count-auto-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const conversions = [], statuses = [], errors = [];
  const module = { exports: {} };
  const source = fsSync.readFileSync(path.join(__dirname, 'auto-recording.js'), 'utf8');
  const converter = async (parts, destination) => {
    const contents = await Promise.all(parts.map(part => fs.readFile(part.path, 'utf8')));
    conversions.push({ parts: parts.map(part => ({ ...part })), contents, destination });
    if (convert) await convert(parts, destination, conversions.length);
    else await fs.writeFile(destination, 'complete MP4');
    return { path: destination, bytes: (await fs.stat(destination)).size };
  };
  vm.runInNewContext('(function(require,module){' + source + '\n})', { Buffer,
    setTimeout: timers?.setTimeout || setTimeout, clearTimeout: timers?.clearTimeout || clearTimeout })(
    name => name === './mp4' ? { concatToMP4: converter } : name === 'node:fs/promises' ? filesystem : require(name), module);
  let time = 1_000_000;
  const manager = await module.exports.createAutoRecording({ folder, ...managerOptions, now: () => time,
    onStatus: status => statuses.push(status), onError: error => errors.push(error) });
  const setTime = value => { time = 1_000_000 + value; };
  const segment = async (start, end) => {
    setTime(end);
    if (autoWatermark) manager.onObservation({ at: 1_000_000 + end, healthy: true });
    return manager.segment(Buffer.from(`${start}-${end}`), { start: 1_000_000 + start, end: 1_000_000 + end });
  };
  const feed = async (start, end) => { for (let i = start; i < end; i += 2000) await segment(i, i + 2000); };
  const plc = value => manager.onPLC({ state: 'ok', value });
  return { folder, manager, conversions, statuses, errors, setTime, segment, feed, plc };
}

test('first reading and reconnect establish a baseline; increases and decreases extend one pre/post-roll clip', async t => {
  const f = await fixture(t);
  await f.feed(0, 10000);
  f.plc(20); f.plc(20);
  f.manager.onPLC({ state: 'connecting' });
  f.plc(99);
  f.manager.onPLC({ state: 'error', value: 0 });
  f.plc(10);
  assert.equal(f.statuses.filter(value => value.state === 'recording').length, 0);
  f.plc(11);
  await f.feed(10000, 14000);
  f.plc(10);
  await f.feed(14000, 24000);
  const result = await f.manager.close();
  assert.equal(result.saved, 1);
  assert.equal(result.error, '');
  assert.equal(f.conversions.length, 1);
  assert.equal(f.conversions[0].contents[0], '4000-6000', 'pre-roll includes the segment crossing five seconds before the change');
  assert.equal(f.conversions[0].contents.at(-1), '22000-24000', 'decrease extends the tail through ten seconds after the last change');
  assert.equal(f.errors.length, 0);
  assert(f.statuses.some(value => value.state === 'saved'));
  assert.deepEqual((await fs.readdir(f.folder)).filter(name => !/\.(mp4|jsonl)$/.test(name)), []);
});

test('idle automatic recording keeps only a bounded rolling buffer and writes no MP4', async t => {
  const f = await fixture(t);
  f.plc(0);
  for (let start = 0; start < 120000; start += 2000) {
    await f.segment(start, start + 2000);
    const [working] = await fs.readdir(f.folder);
    assert((await fs.readdir(path.join(f.folder, working))).length <= 5);
  }
  const result = await f.manager.close();
  assert.equal(result.saved, 0);
  assert.equal(f.conversions.length, 0);
  assert.deepEqual(await fs.readdir(f.folder), []);
  assert.strictEqual(f.manager.close(), f.manager.close(), 'closing is idempotent');
});

test('continuous passages split at sixty seconds without missing or duplicating a segment', async t => {
  const f = await fixture(t);
  f.plc(0);
  await f.feed(0, 6000);
  f.plc(1);
  for (let start = 6000; start < 130000; start += 2000) {
    await f.segment(start, start + 2000);
    f.plc(start % 4000 === 0 ? 1 : 0);
  }
  const result = await f.manager.close();
  assert.equal(result.saved, 3);
  const segments = f.conversions.flatMap(value => value.contents);
  assert.deepEqual(segments, Array.from({ length: 65 }, (_, i) => `${i * 2000}-${(i + 1) * 2000}`));
  assert(f.conversions.every(value => value.parts.reduce((sum, part) => sum + part.duration, 0) <= 60));
});

test('a slow background conversion keeps shared pre-roll safe while collecting another passage', async t => {
  let release, markStarted;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  t.after(() => release());
  const f = await fixture(t, async (_parts, destination, index) => {
    if (index === 1) { markStarted(); await blocked; }
    await fs.writeFile(destination, 'complete MP4');
  });
  f.plc(0);
  await f.feed(0, 6000);
  f.plc(1);
  await f.feed(6000, 16000);
  await started;
  assert.equal(f.conversions.length, 1);
  f.setTime(17000); f.plc(0);
  await f.feed(16000, 28000);
  for (const part of f.conversions[0].parts) assert((await fs.stat(part.path)).size > 0, 'encoder-owned originals remain available');
  release();
  const result = await f.manager.close();
  assert.equal(result.saved, 2);
  assert.equal(f.conversions.length, 2);
  assert.equal(f.conversions[1].contents[0], '12000-14000');
  assert.equal(f.conversions[1].contents.at(-1), '26000-28000');
});

test('encoder failure stops automatic mode and preserves independently playable original segments for each pending clip', async t => {
  const f = await fixture(t, async () => { throw new Error('encoder unavailable'); });
  f.plc(0);
  await f.feed(0, 6000);
  f.plc(1);
  await f.feed(6000, 16000);
  const result = await f.manager.close();
  assert.equal(result.saved, 0);
  assert.match(result.error, /encoder unavailable/);
  assert.equal(f.errors.length, 1);
  assert.match(path.basename(result.path), /^People-Count-Recovery-/);
  const recovery = await fs.readdir(result.path);
  assert(recovery.includes('segments.ffconcat'));
  assert(recovery.some(name => name.endsWith('.webm')));
  assert.equal(await fs.readFile(path.join(result.path, 'segment-0001.webm'), 'utf8'), '0-2000');
  assert.deepEqual((await fs.readdir(f.folder)).filter(name => name.startsWith('.people-count-auto-')), []);
});

test('queue overload requests a stop and keeps every collected passage rather than dropping it', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (_parts, destination, index) => {
    if (index === 1) await blocked;
    await fs.writeFile(destination, 'complete MP4');
  });
  f.plc(0);
  for (let event = 0; event < 5; event++) {
    const start = event * 14000;
    f.setTime(start);
    f.plc((event + 1) % 2);
    await f.feed(start, start + 14000);
  }
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /속도를 따라가지 못해/);
  release();
  const result = await f.manager.close();
  assert.equal(result.saved, 5, 'all queued events survive overload');
  assert.equal(f.conversions.length, 5);
});

test('disk failure preserves the existing rolling originals and reports the storage error', async t => {
  const f = await fixture(t);
  await f.feed(0, 6000);
  f.plc(0); f.plc(1);
  const [directory] = await fs.readdir(f.folder);
  await fs.mkdir(path.join(f.folder, directory, 'segment-00000004.webm'));
  await assert.rejects(f.segment(6000, 8000), /EEXIST/);
  const result = await f.manager.close();
  assert.equal(f.errors.length, 1);
  assert.match(result.error, /원본을 저장하지 못했습니다/);
  assert((await fs.readdir(path.join(f.folder, directory))).includes('segment-00000001.webm'));
});

test('a PLC trigger cannot acquire a source whose deletion is already awaiting the disk', async t => {
  let releaseDelete, deletionStarted;
  const blocked = new Promise(resolve => { releaseDelete = resolve; });
  const started = new Promise(resolve => { deletionStarted = resolve; });
  let delayed = false, deletingPath;
  const filesystem = { ...fs, async unlink(filename) {
    if (!delayed && filename.endsWith('.webm')) {
      delayed = true;
      deletingPath = filename;
      deletionStarted();
      await blocked;
    }
    return fs.unlink(filename);
  } };
  const f = await fixture(t, undefined, filesystem);
  f.plc(0);
  await f.feed(0, 8000);
  const pendingSegment = f.segment(8000, 10000);
  await started;
  // Also exercise a clock adjustment during the pending deletion. Old code
  // left the part in the rolling array and let this callback reference it.
  f.setTime(6000); f.plc(1);
  releaseDelete();
  await pendingSegment;
  const result = await f.manager.close();
  assert.equal(result.error, '');
  assert.equal(result.saved, 1);
  assert(!f.conversions[0].parts.some(part => part.path === deletingPath));
});

test('encoder cleanup and incoming-segment cleanup do not remove each other\'s source records', async t => {
  let releaseEncoder, releaseDelete, deletionStarted;
  const encoderBlocked = new Promise(resolve => { releaseEncoder = resolve; });
  const deletionBlocked = new Promise(resolve => { releaseDelete = resolve; });
  const started = new Promise(resolve => { deletionStarted = resolve; });
  let enableGate = false, delayed = false;
  const filesystem = { ...fs, async unlink(filename) {
    if (enableGate && !delayed && filename.endsWith('.webm')) {
      delayed = true;
      deletionStarted();
      await deletionBlocked;
    }
    return fs.unlink(filename);
  } };
  const f = await fixture(t, async (_parts, destination, index) => {
    if (index === 1) await encoderBlocked;
    await fs.writeFile(destination, 'complete MP4');
  }, filesystem);
  f.plc(0);
  await f.feed(0, 6000);
  f.plc(1);
  await f.feed(6000, 24000);
  enableGate = true;
  releaseEncoder();
  await started;
  await f.segment(24000, 26000);
  f.plc(0);
  releaseDelete();
  await f.feed(26000, 36000);
  const result = await f.manager.close();
  assert.equal(result.error, '');
  assert.equal(result.saved, 2);
  assert.deepEqual(f.conversions[1].contents, ['20000-22000', '22000-24000', '24000-26000',
    '26000-28000', '28000-30000', '30000-32000', '32000-34000', '34000-36000']);
  assert.deepEqual((await fs.readdir(f.folder)).filter(name => !/\.(mp4|jsonl)$/.test(name)), []);
});

async function observedPassage(t, { values = time => time >= 10000 ? 6 : 5,
  events = [{ at: 10000, direction: 'in' }], uncertainty, motion = false, plcAvailable = true,
  observationFilter = () => true, beforeClose = () => {}, timers } = {}) {
  const f = await fixture(t, undefined, fs, { mapping: 'occupancy', autoWatermark: false, timers });
  for (let time = 0; time <= 20000; time += 500) {
    f.setTime(time);
    if (plcAvailable) f.plc(values(time));
    if (observationFilter(time)) f.manager.onObservation({ at: 1_000_000 + time,
      events: events.filter(event => event.at === time).map(event => ({ ...event, at: 1_000_000 + event.at })),
      uncertain: uncertainty && time === 11000 ? [uncertainty] : [], healthy: true });
    if (motion && time === 10000) f.manager.onMotion({ at: 1_000_000 + time });
    if (time && time % 2000 === 0) await f.segment(time - 2000, time);
  }
  await beforeClose(f);
  const result = await f.manager.close();
  const files = await fs.readdir(f.folder);
  const reviews = [];
  for (const filename of files.filter(name => name.endsWith('.jsonl'))) {
    for (const line of (await fs.readFile(path.join(f.folder, filename), 'utf8')).trim().split('\n')) reviews.push(JSON.parse(line));
  }
  return { ...f, result, files, reviews };
}

test('healthy matched camera and PLC passages keep the audit record without encoding a video', async t => {
  const f = await observedPassage(t);
  assert.equal(f.result.error, '');
  assert.equal(f.result.saved, 0, JSON.stringify(f.reviews));
  assert.equal(f.result.matched, 1);
  assert.equal(f.conversions.length, 0, 'matching events must never enter FFmpeg');
  assert.equal(f.files.length, 1, 'all rolling originals are cleaned up');
  assert.match(f.files[0], /\.jsonl$/);
  assert.equal(f.result.path, path.join(f.folder, f.files[0]));
  assert.equal(f.reviews.length, 1);
  assert.equal(f.reviews[0].status, 'matched');
  assert.equal(f.reviews[0].video, null);
  assert.deepEqual([f.reviews[0].videoIn, f.reviews[0].videoOut, f.reviews[0].plcIn, f.reviews[0].plcOut], [1, 0, 1, 0]);
  assert(f.statuses.some(value => value.state === 'matched' && value.matched === 1));
});

test('a camera crossing with an unchanged PLC value preserves a mismatch MP4 and its audit', async t => {
  const f = await observedPassage(t, { values: () => 5 });
  assert.equal(f.result.error, '');
  assert.equal(f.result.saved, 1);
  assert.equal(f.result.matched, 0);
  assert.equal(f.conversions.length, 1);
  assert.match(path.basename(f.result.path), /^People-Count-Mismatch-.*\.mp4$/);
  assert.deepEqual(f.files.map(name => path.extname(name)).sort(), ['.jsonl', '.mp4']);
  assert.equal(f.reviews[0].status, 'mismatch');
  assert.equal(f.reviews[0].videoIn, 1);
  assert.equal(f.reviews[0].plcIn, 0);
  assert.equal(f.reviews[0].video, f.result.path);
});

test('two independently observed entries and one PLC increment preserve the differing counts', async t => {
  const f = await observedPassage(t, { events: [{ at: 10000, direction: 'in' }, { at: 10000, direction: 'in' }] });
  assert.equal(f.result.error, '');
  assert.equal(f.result.saved, 1);
  assert.equal(f.result.matched, 0);
  assert.equal(f.reviews[0].status, 'mismatch');
  assert.deepEqual([f.reviews[0].videoIn, f.reviews[0].plcIn], [2, 1]);
  assert.match(path.basename(f.result.path), /^People-Count-Mismatch-/);
  assert.equal(f.files.filter(name => name.endsWith('.mp4')).length, 1);
  assert(!f.files.some(name => name.startsWith('.people-count-auto-')));
});

test('equal counts with an uncertain visual observation preserve a review MP4', async t => {
  const f = await observedPassage(t, { uncertainty: '사람이 겹쳐 통행 추적이 불확실합니다.' });
  assert.equal(f.result.error, '');
  assert.equal(f.result.saved, 1);
  assert.equal(f.result.matched, 0);
  assert.equal(f.reviews[0].status, 'uncertain');
  assert.deepEqual([f.reviews[0].videoIn, f.reviews[0].plcIn], [1, 1]);
  assert(f.reviews[0].reasons.includes('사람이 겹쳐 통행 추적이 불확실합니다.'));
  assert.match(path.basename(f.result.path), /^People-Count-Review-/);
  assert.equal(f.reviews[0].video, f.result.path);
});

test('camera motion without PLC readings retains an uncertain clip instead of declaring a match', async t => {
  const f = await observedPassage(t, { events: [], motion: true, plcAvailable: false });
  assert.equal(f.result.error, '');
  assert.equal(f.result.saved, 1);
  assert.equal(f.result.matched, 0);
  assert.equal(f.conversions.length, 1);
  assert.equal(f.reviews[0].status, 'uncertain');
  assert.equal(f.reviews[0].videoIn, 0);
  assert(f.reviews[0].reasons.some(reason => reason.includes('PLC')));
  assert(f.reviews[0].reasons.some(reason => reason.includes('움직임')));
  assert.match(path.basename(f.result.path), /^People-Count-Review-/);
});

test('matching counts with a long observation gap retain the video even when both ends were analyzed', async t => {
  const f = await observedPassage(t, { observationFilter: time => time <= 10500 || time >= 18000 });
  assert.equal(f.result.error, '');
  assert.equal(f.result.saved, 1);
  assert.equal(f.result.matched, 0);
  assert.deepEqual([f.reviews[0].videoIn, f.reviews[0].plcIn], [1, 1]);
  assert.equal(f.reviews[0].status, 'uncertain');
  assert(f.reviews[0].reasons.some(reason => /분석|영상/.test(reason)));
  assert.match(path.basename(f.result.path), /^People-Count-Review-/);
  assert.equal(f.conversions.length, 1);
});

function controlledTimers() {
  const pending = new Map();
  let sequence = 0;
  return {
    pending,
    setTimeout(callback, delay) { const id = ++sequence; pending.set(id, { callback, delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fire() { for (const [id, timer] of [...pending]) { pending.delete(id); timer.callback(); } }
  };
}

test('a sealed clip waits for late AI uncertainty before deciding whether its video can be removed', async t => {
  const f = await observedPassage(t, { observationFilter: time => time < 19500,
    beforeClose(f) {
      assert.equal(f.conversions.length, 0);
      assert(!f.statuses.some(value => value.state === 'matched'), 'segment end alone cannot certify the unfinished frame');
      f.manager.onObservation({ at: 1_019_500, events: [], uncertain: ['통행선 사람 추적이 불확실합니다.'], healthy: true });
      assert(!f.statuses.some(value => value.state === 'matched'));
      f.manager.onObservation({ at: 1_020_000, events: [], healthy: true });
    } });
  assert.equal(f.result.error, '');
  assert.equal(f.result.saved, 1);
  assert.equal(f.result.matched, 0);
  assert.equal(f.reviews[0].status, 'uncertain');
  assert(f.reviews[0].reasons.includes('통행선 사람 추적이 불확실합니다.'));
  assert.equal(f.reviews[0].video, f.result.path);
});

test('late healthy observations permit a match only after analysis reaches the clip end', async t => {
  const f = await observedPassage(t, { observationFilter: time => time < 19500,
    beforeClose(f) {
      assert(!f.statuses.some(value => value.state === 'matched'));
      f.manager.onObservation({ at: 1_019_500, events: [], healthy: true });
      assert(!f.statuses.some(value => value.state === 'matched'));
      f.manager.onObservation({ at: 1_020_000, events: [], healthy: true });
    } });
  assert.equal(f.result.saved, 0);
  assert.equal(f.result.matched, 1);
  assert.equal(f.conversions.length, 0);
  assert.equal(f.reviews[0].status, 'matched');
  assert.equal(f.files.length, 1);
  assert.match(f.files[0], /\.jsonl$/);
});

test('uncertainty in the first completed frame beyond the boundary also protects the preceding clip', async t => {
  const f = await observedPassage(t, { observationFilter: time => time < 20000,
    beforeClose(f) {
      f.manager.onObservation({ at: 1_020_250, events: [], uncertain: ['직전 프레임의 사람 추적이 끊겼습니다.'], healthy: true });
    } });
  assert.equal(f.result.saved, 1);
  assert.equal(f.result.matched, 0);
  assert.equal(f.reviews[0].status, 'uncertain');
  assert(f.reviews[0].reasons.includes('직전 프레임의 사람 추적이 끊겼습니다.'));
});

test('closing with an unfinished AI frame preserves the clip immediately and clears its deadline timer', async t => {
  const timers = controlledTimers();
  const f = await observedPassage(t, { observationFilter: time => time < 19500, timers,
    beforeClose() { assert.equal(timers.pending.size, 1); } });
  assert.equal(timers.pending.size, 0);
  assert.equal(f.result.saved, 1);
  assert.equal(f.result.matched, 0);
  assert.equal(f.reviews[0].status, 'uncertain');
  assert(f.reviews[0].reasons.some(reason => reason.includes('구간 끝까지 영상 분석')));
});

test('a two-second analysis deadline preserves the video instead of blocking capture indefinitely', async t => {
  const timers = controlledTimers();
  const f = await observedPassage(t, { observationFilter: time => time < 19500, timers,
    beforeClose() {
      assert.equal(timers.pending.size, 1);
      assert.equal([...timers.pending.values()][0].delay, 2000);
      timers.fire();
    } });
  assert.equal(timers.pending.size, 0);
  assert.equal(f.result.saved, 1);
  assert.equal(f.result.matched, 0);
  assert(f.reviews[0].reasons.some(reason => reason.includes('2초')));
  assert.equal(f.result.error, '', 'a slow AI result preserves evidence without stopping automatic recording');
});

test('pending review retains its history and source references while later segments continue arriving', async t => {
  const timers = controlledTimers();
  const f = await observedPassage(t, { observationFilter: time => time < 19500, timers,
    async beforeClose(f) {
      for (let time = 20500; time <= 50000; time += 500) {
        f.setTime(time); f.plc(6);
        if (time % 2000 === 0) await f.segment(time - 2000, time);
      }
      const [working] = (await fs.readdir(f.folder)).filter(name => name.startsWith('.people-count-auto-'));
      assert(await fs.stat(path.join(f.folder, working, 'segment-00000003.webm')), 'pending pre-roll must not be evicted');
      f.manager.onObservation({ at: 1_019_500, events: [], healthy: true });
      f.manager.onObservation({ at: 1_020_000, events: [], healthy: true });
    } });
  assert.equal(f.result.saved, 0);
  assert.equal(f.result.matched, 1);
  assert.deepEqual([f.reviews[0].videoIn, f.reviews[0].plcIn], [1, 1], 'pending review keeps the original comparison history');
  assert.equal(timers.pending.size, 0);
  assert(!f.files.some(name => name.startsWith('.people-count-auto-')));
});
