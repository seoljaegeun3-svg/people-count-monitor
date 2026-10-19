const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function fixture(overrides = {}) {
  const nodes = new Map(), events = [], saved = [], notices = [], ordering = [];
  const initial = { configured: false, line: { axis: 'vertical', position: .5, invert: false }, mapping: 'unknown', confidence: .45, sensitivity: 'normal', ...overrides.config };
  const context = { clearRect() {}, drawImage() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', dataset: {}, events: {}, disabled: false, open: false,
      addEventListener(name, handler) { this.events[name] = handler; },
      getContext: () => context,
      getBoundingClientRect: () => ({ left: 20, top: 30, width: 800, height: 400 }),
      setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {},
      showModal() { this.open = true; ordering.push('open'); },
      close() { this.open = false; this.events.close?.(); }
    });
    return nodes.get(id);
  }
  const api = {
    comparisonSettings: async () => initial,
    comparisonPreview: async () => { ordering.push('preview'); return { image: 'data:image/png;base64,test', width: 1600, height: 800 }; },
    comparisonSave: async config => { saved.push(config); if (overrides.failSave) throw new Error('write failed'); return config; }
  };
  class Image { async decode() { ordering.push('image-ready'); } }
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  const window = { monitor: api, dispatchEvent(event) { events.push(event); }, addEventListener(type, handler) { this[type] = handler; } };
  const document = { getElementById: node, dispatchEvent(event) { events.push(event); } };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, 'ui', 'comparison-settings.js'), 'utf8'), {
    window, document, CustomEvent, Image, toast: text => notices.push(text)
  });
  await new Promise(setImmediate);
  return { node, window, events, saved, notices, ordering, api };
}

test('comparison settings require an explicit video region before saving', async () => {
  const f = await fixture();
  assert.equal(f.node('comparison-status').textContent, '설정 필요');
  await f.node('comparison-settings').events.click();
  assert.deepEqual(f.ordering, ['preview', 'image-ready', 'open']);
  assert.equal(f.node('comparison-dialog').open, true);
  assert.equal(f.node('comparison-save').disabled, true);
  await f.node('comparison-form').events.submit({ preventDefault() {} });
  assert.equal(f.saved.length, 0);
  assert.equal(f.events.find(event => event.type === 'comparison-dialog').detail.open, true);
  f.node('comparison-cancel').events.click();
  assert.equal(f.saved.length, 0);
  assert.equal(f.events.at(-1).detail.open, false);
});

test('camera preview drag saves normalized ROI and selected line with conservative PLC mapping', async () => {
  const f = await fixture();
  await f.window['open-comparison-settings']();
  const canvas = f.node('comparison-canvas');
  const pointer = (x, y) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, preventDefault() {} });
  canvas.events.pointerdown(pointer(180, 70));
  canvas.events.pointermove(pointer(660, 350));
  canvas.events.pointerup(pointer(660, 350));
  assert.equal(f.node('comparison-save').disabled, false);
  f.node('comparison-axis').value = 'horizontal';
  f.node('comparison-line').value = '65';
  f.node('comparison-invert').checked = true;
  await f.node('comparison-form').events.submit({ preventDefault() {} });
  const result = JSON.parse(JSON.stringify(f.saved[0]));
  assert.deepEqual(result, {
    configured: true, region: { x: .2, y: .1, width: .6000000000000001, height: .7000000000000001 },
    sensitivity: 'normal', line: { axis: 'horizontal', position: .65, invert: true }, mapping: 'unknown', confidence: .45
  });
  assert.equal(f.node('comparison-dialog').open, false);
  assert.equal(f.node('comparison-status').textContent, '모든 통행 보관');
  assert.equal(f.events.findLast(event => event.type === 'comparison-settings-changed').detail.configured, true);
});

test('tiny or click-only selections stay unconfigured and numeric ROI remains inside the image', async () => {
  const f = await fixture();
  await f.node('comparison-settings').events.click();
  const canvas = f.node('comparison-canvas');
  const pointer = { clientX: 100, clientY: 100, button: 0, pointerId: 1, preventDefault() {} };
  canvas.events.pointerdown(pointer); canvas.events.pointerup(pointer);
  assert.equal(f.node('comparison-save').disabled, true);
  canvas.events.pointerdown(pointer);
  canvas.events.pointermove({ ...pointer, clientX: 101, clientY: 101 });
  canvas.events.pointerup(pointer);
  assert.equal(f.node('comparison-save').disabled, true);
  f.node('comparison-region-reset').events.click();
  f.node('comparison-region-x').value = '95';
  f.node('comparison-region-x').events.input();
  f.node('comparison-mapping').value = 'occupancy';
  await f.node('comparison-form').events.submit({ preventDefault() {} });
  assert.equal(f.saved[0].region.x, .95);
  assert.ok(Math.abs(f.saved[0].region.width - .05) < 1e-10);
  assert.ok(f.saved[0].region.x + f.saved[0].region.width <= 1);
});

test('save failures keep the editable dialog open and never publish new configuration', async () => {
  const f = await fixture({ failSave: true });
  await f.node('comparison-settings').events.click();
  f.node('comparison-region-reset').events.click();
  await f.node('comparison-form').events.submit({ preventDefault() {} });
  assert.equal(f.node('comparison-dialog').open, true);
  assert.equal(f.node('comparison-save').disabled, false);
  assert.match(f.node('comparison-error').textContent, /write failed/);
  assert.equal(f.events.filter(event => event.type === 'comparison-settings-changed').length, 1);
  assert.equal(f.node('comparison-status').textContent, '설정 필요');
});
