const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createPeopleCounter } = require('./people-counter');

const flush = () => new Promise(setImmediate);
const box = (x, score = 0.9) => ({ x, y: 0.2, width: 0.1, height: 0.4, score });
function mask(x = 0, y = 0, width = 0, height = 0) {
  const data = new Uint8Array(160 * 90);
  for (let row = y; row < y + height; row++) data.fill(1, row * 160 + x, row * 160 + x + width);
  return { data, width: 160, height: 90 };
}

async function harness(t, overrides = {}) {
  const observations = [], motions = [], statuses = [], errors = [], updates = [], order = [];
  const controls = { result: { detections: [], weakDetections: [], elapsedMs: 20 }, closed: 0,
    nextCapture: { key: 'camera', image: {} } };
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, 'vision-review.js'), 'utf8'), {
    module, Uint8Array, Date, Error,
    require(name) {
      if (name === './motion') return { createMotionWatcher(options) {
        controls.watcher = options;
        return { start() { controls.started = true; }, stop() { controls.stopped = true; } };
      } };
      if (name === './person-detector') return { async createPersonDetector(options) {
        controls.modelOptions = options;
        return {
          async detect(image) {
            order.push('detect:start');
            controls.lastImage = image;
            const result = controls.result;
            if (controls.hold) await controls.hold;
            if (controls.detectError) throw controls.detectError;
            order.push('detect:end');
            return result;
          },
          async close() { order.push('model:close'); controls.closed++; }
        };
      } };
      if (name === './people-counter') return { createPeopleCounter(settings) {
        const tracker = createPeopleCounter(settings);
        return {
          update(detections, options) { updates.push({ detections, options }); return tracker.update(detections, options); },
          reset() { controls.resets = (controls.resets || 0) + 1; tracker.reset(); }
        };
      } };
      throw new Error(`Unexpected module ${name}`);
    }
  });
  const review = await module.exports.createVisionReview({
    capture: async () => controls.nextCapture,
    settings: { region: { x: 0, y: 0, width: 1, height: 1 }, sensitivity: 'normal',
      line: { axis: 'vertical', position: 0.5, invert: false }, confidence: 0.35,
      mapping: 'net', source: { key: 'camera' } },
    onObservation(value) { observations.push(value); }, onMotion(value) { motions.push(value); },
    onStatus(value) { statuses.push(value); }, onFatal(value) { errors.push(value); }, ...overrides
  });
  t.after(() => review.stop());
  review.start();
  async function frame(at, detections = [], options = {}) {
    controls.result = { detections, weakDetections: options.weak || [], elapsedMs: options.elapsedMs ?? 20 };
    const image = { at };
    await controls.watcher.onFrame({ at, image, key: 'camera', baseline: options.baseline || false,
      changedRatio: options.motionRatio ?? 0, changedMask: options.mask || mask() });
    return observations.at(-1);
  }
  return { review, controls, observations, motions, statuses, errors, updates, order, frame };
}

test('video crossings are reported independently of any PLC trigger and use the same captured ROI image', async t => {
  const h = await harness(t);
  await h.frame(1000, [box(0.25)], { baseline: true });
  await h.frame(1250, [box(0.4)]);
  const result = await h.frame(1500, [box(0.55)]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].direction, 'in');
  assert.equal(result.healthy, true);
  assert.equal(h.controls.lastImage.at, 1500);
  assert.equal(h.updates.length, 3);
  h.controls.watcher.onMotion({ at: 1500, changedRatio: 0.1 });
  assert.equal(h.motions.length, 1);
  assert.equal(h.errors.length, 0);
});

test('weak detections are passed to tracking and always leave uncertainty', async t => {
  const h = await harness(t);
  const result = await h.frame(1000, [box(0.1)], { baseline: true, weak: [box(0.4, 0.2)] });
  assert.equal(h.updates[0].detections.length, 2);
  assert(result.uncertain.some(reason => /신뢰도/.test(reason)));
  assert.equal(result.personCount, 1);
});

test('changed pixels outside both detected people and their previous boxes are uncertain', async t => {
  const h = await harness(t);
  await h.frame(1000, [box(0.1)], { baseline: true });
  const covered = await h.frame(1250, [box(0.2)], { motionRatio: 0.02, mask: mask(17, 20, 10, 20) });
  assert.equal(covered.unexplainedRatio, 0, 'the previous person box explains disappearance pixels');
  assert(!covered.uncertain.some(reason => /설명되지/.test(reason)));
  const unexplained = await h.frame(1500, [box(0.2)], { motionRatio: 0.02, mask: mask(120, 10, 12, 20) });
  assert(unexplained.unexplainedRatio > 0.01);
  assert(unexplained.uncertain.some(reason => /사람으로 설명되지/.test(reason)));
  assert.equal(h.updates.at(-1).options.unexplainedRatio, unexplained.unexplainedRatio);
});

test('camera loss resets tracking, reports unhealthy, and keeps the first resumed frame uncertain', async t => {
  const h = await harness(t);
  await h.frame(1000, [box(0.25)], { baseline: true });
  h.controls.watcher.onStatus({ state: 'waiting-camera', message: '카메라 영상 대기 중' });
  assert.equal(h.observations.at(-1).healthy, false);
  assert(h.observations.at(-1).uncertain.includes('카메라 영상 중단'));
  const resumed = await h.frame(3000, [box(0.55)], { baseline: true });
  assert.equal(resumed.events.length, 0, 'a person on the other side after loss is not a confident crossing');
  assert(resumed.uncertain.some(reason => /기준을 다시/.test(reason)));
  assert.equal(resumed.healthy, true);
});

test('slow inference and long camera frame gaps are uncertain', async t => {
  const h = await harness(t);
  await h.frame(1000, [box(0.1)], { baseline: true });
  const slow = await h.frame(1250, [box(0.1)], { elapsedMs: 801 });
  assert(slow.uncertain.some(reason => /분석이 느려/.test(reason)));
  const gap = await h.frame(3501, [box(0.55)]);
  assert(gap.uncertain.some(reason => /분석 간격/.test(reason)));
  assert.equal(gap.events.length, 0);
});

test('camera source changes stop analysis and require recalibration', async t => {
  const h = await harness(t);
  h.controls.nextCapture = { key: 'different-page', image: {} };
  const frame = await h.controls.watcher.capture();
  await h.review.stop();
  assert.equal(frame, null);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /다시 설정/);
  assert.equal(h.controls.stopped, true);
  assert.equal(h.controls.closed, 1);
  await h.frame(1000, [box(0.1)]);
  h.controls.watcher.onStatus({ state: 'armed' });
  h.controls.watcher.onMotion({ at: 1000, changedRatio: 0.1 });
  assert.equal(h.observations.length, 0);
  assert.equal(h.statuses.length, 0);
  assert.equal(h.motions.length, 0);
});

test('model failure is fatal and never falls back to PLC or a healthy observation', async t => {
  const h = await harness(t);
  h.controls.detectError = new Error('model unavailable');
  await h.frame(1000, [box(0.1)], { baseline: true });
  await h.review.stop();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /model unavailable/);
  assert.equal(h.observations.length, 0);
  assert.equal(h.controls.closed, 1);
});

test('stop waits for in-flight inference before closing and ignores all later callbacks', async t => {
  const h = await harness(t);
  let release;
  h.controls.hold = new Promise(resolve => { release = resolve; });
  const pending = h.frame(1000, [box(0.1)], { baseline: true });
  await flush();
  const stopped = h.review.stop();
  assert.strictEqual(stopped, h.review.stop(), 'stop is idempotent');
  assert.equal(h.controls.closed, 0);
  assert.equal(h.controls.stopped, true);
  release();
  await pending;
  await stopped;
  assert.deepEqual(h.order, ['detect:start', 'detect:end', 'model:close']);
  assert.equal(h.observations.length, 0);
  assert.equal(h.errors.length, 0);
  assert.throws(() => h.review.start(), /다시 시작/);
});
