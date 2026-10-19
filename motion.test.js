const test = require('node:test');
const assert = require('node:assert/strict');
const { MOTION_DEFAULTS, validateMotionSettings, createMotionWatcher } = require('./motion');

class Image {
  constructor(width = 160, height = 90, data = Buffer.alloc(width * height * 4)) {
    Object.assign(this, { width, height, data });
  }
  getSize() { return { width: this.width, height: this.height }; }
  crop({ x, y, width, height }) {
    const result = new Image(width, height);
    for (let row = 0; row < height; row++) {
      this.data.copy(result.data, row * width * 4, ((y + row) * this.width + x) * 4,
        ((y + row) * this.width + x + width) * 4);
    }
    return result;
  }
  resize({ width, height }) {
    const result = new Image(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (Math.floor(y * this.height / height) * this.width + Math.floor(x * this.width / width)) * 4;
        this.data.copy(result.data, (y * width + x) * 4, index, index + 4);
      }
    }
    return result;
  }
  toBitmap() { return this.data; }
  rectangle(x, y, width, height, value = 255) {
    for (let row = y; row < y + height; row++) {
      for (let column = x; column < x + width; column++) {
        const index = (row * this.width + column) * 4;
        this.data.fill(value, index, index + 3);
        this.data[index + 3] = 255;
      }
    }
    return this;
  }
}

const flush = () => new Promise(setImmediate);

function harness(settings = {}, captureOverride) {
  let time = 0, nextFrame, timer, started = false;
  const events = [], statuses = [];
  const watcher = createMotionWatcher({ ...settings,
    capture: captureOverride || (async () => nextFrame),
    now: () => time,
    schedule(callback) { timer = callback; return callback; },
    cancel(handle) { if (timer === handle) timer = undefined; },
    onMotion: event => events.push(event), onStatus: status => statuses.push(status)
  });
  async function sample(image, { key = 'camera', elapsed = 250 } = {}) {
    time += elapsed;
    nextFrame = image === null ? null : { image, key };
    if (!started) { started = true; watcher.start(); }
    else {
      assert(timer, 'watcher schedules another frame');
      const callback = timer;
      timer = undefined;
      callback();
    }
    await flush();
  }
  return { watcher, sample, events, statuses, getTimer: () => timer };
}

test('motion settings have independent defaults and reject malformed regions and sensitivity', () => {
  const settings = validateMotionSettings();
  assert.deepEqual(settings, MOTION_DEFAULTS);
  settings.region.x = 0.2;
  assert.equal(MOTION_DEFAULTS.region.x, 0);
  assert.deepEqual(validateMotionSettings({ sensitivity: 'high' }).region, MOTION_DEFAULTS.region);
  for (const value of [null, [], false, 'normal']) assert.throws(() => validateMotionSettings(value));
  for (const region of [null, [], {}, { x: NaN, y: 0, width: 1, height: 1 },
    { x: -0.1, y: 0, width: 1, height: 1 }, { x: 0.5, y: 0, width: 0.6, height: 1 },
    { x: 0, y: 0, width: 1, height: 0.01 }, { x: '0', y: 0, width: 1, height: 1 }]) {
    assert.throws(() => validateMotionSettings({ region }));
  }
  for (const sensitivity of ['invalid', '__proto__', ['normal'], 1, null]) {
    assert.throws(() => validateMotionSettings({ sensitivity }));
  }
});

test('unchanged pictures and small clock-sized noise do not trigger or spam status', async () => {
  const h = harness({ sensitivity: 'high' });
  await h.sample(new Image());
  for (let index = 0; index < 12; index++) {
    await h.sample(new Image().rectangle(index, 2, 2, 2));
  }
  assert.equal(h.events.length, 0);
  assert.deepEqual(h.statuses.map(status => status.state), ['armed']);
  h.watcher.stop();
});

test('movement within the selected camera region triggers and keeps extending an event', async () => {
  const h = harness({ region: { x: 0, y: 0, width: 0.5, height: 1 } });
  await h.sample(new Image());
  await h.sample(new Image().rectangle(10, 10, 10, 20));
  assert.equal(h.events.length, 0, 'one changed frame alone does not trigger');
  await h.sample(new Image().rectangle(20, 10, 10, 20));
  await h.sample(new Image().rectangle(30, 10, 10, 20));
  assert.equal(h.events.length, 2);
  assert(h.events.every(event => event.changedRatio >= 0.01));
  assert(h.events[1].at > h.events[0].at);
  h.watcher.stop();
});

test('moving browser areas or camera pixels outside the region cannot trigger', async () => {
  const h = harness({ region: { x: 0, y: 0, width: 0.5, height: 1 } });
  await h.sample(new Image());
  for (let x = 90; x < 140; x += 10) await h.sample(new Image().rectangle(x, 10, 10, 20));
  assert.equal(h.events.length, 0);
  h.watcher.stop();
});

test('a single full-frame illumination jump is ignored', async () => {
  const h = harness();
  await h.sample(new Image());
  for (let index = 0; index < 8; index++) await h.sample(new Image().rectangle(0, 0, 160, 90, 40));
  assert.equal(h.events.length, 0);
  h.watcher.stop();
});

test('duplicate frames between 1 fps updates preserve the two-hit evidence for a brief passage', async () => {
  const h = harness();
  await h.sample(new Image());
  for (let index = 0; index < 4; index++) await h.sample(new Image().rectangle(20, 10, 10, 20));
  await h.sample(new Image());
  assert.equal(h.events.length, 1);
  h.watcher.stop();
});

test('a second change arriving after the evidence window starts a new candidate', async () => {
  const h = harness();
  await h.sample(new Image());
  await h.sample(new Image().rectangle(20, 10, 10, 20));
  await h.sample(new Image(), { elapsed: 1250 });
  assert.equal(h.events.length, 0);
  h.watcher.stop();
});

test('camera absence, source changes and resolution changes each discard the old baseline', async () => {
  const h = harness();
  await h.sample(new Image());
  await h.sample(new Image().rectangle(20, 10, 10, 20));
  await h.sample(null);
  await h.sample(new Image());
  await h.sample(new Image().rectangle(20, 10, 10, 20), { key: 'another-camera' });
  await h.sample(new Image(320, 180).rectangle(0, 0, 320, 180), { key: 'another-camera' });
  assert.equal(h.events.length, 0);
  assert.deepEqual(h.statuses.map(status => status.state), ['armed', 'waiting-camera', 'armed']);
  h.watcher.stop();
});

test('capture failures and invalid images wait for a fresh baseline', async () => {
  let image = new Image(), fail = false;
  const h = harness({}, async () => { if (fail) throw new Error('camera loading'); return { image, key: 'camera' }; });
  await h.sample(image);
  image = new Image().rectangle(10, 10, 20, 20);
  await h.sample(image);
  fail = true;
  await h.sample(image);
  fail = false;
  image = new Image();
  await h.sample(image);
  image = new Image(0, 0);
  await h.sample(image);
  image = new Image().rectangle(10, 10, 20, 20);
  await h.sample(image);
  assert.equal(h.events.length, 0);
  assert.deepEqual(h.statuses.map(status => status.state), ['armed', 'waiting-camera', 'armed', 'waiting-camera', 'armed']);
  h.watcher.stop();
});

test('sensitivity controls how much changed area is needed', async () => {
  for (const [sensitivity, expected] of [['low', 0], ['normal', 0], ['high', 1]]) {
    const h = harness({ sensitivity });
    await h.sample(new Image());
    await h.sample(new Image().rectangle(20, 10, 8, 8));
    await h.sample(new Image());
    assert.equal(h.events.length, expected, sensitivity);
    h.watcher.stop();
  }
});

test('stopping ignores an outstanding capture and restarting cannot overlap it', async () => {
  let resolve, calls = 0;
  const h = harness({}, () => {
    calls++;
    return new Promise(done => { resolve = done; });
  });
  h.watcher.start();
  h.watcher.stop();
  h.watcher.start();
  h.getTimer()();
  await flush();
  assert.equal(calls, 1, 'the old asynchronous capture is still the only request');
  resolve({ image: new Image(), key: 'camera' });
  await flush();
  assert.equal(h.statuses.length, 0, 'the prior generation cannot change status or baseline');
  assert.equal(h.events.length, 0);
  h.watcher.stop();
  assert.equal(h.getTimer(), undefined);
  assert.equal(calls, 1);
});

test('onFrame receives the full-resolution cropped image and a matching small change mask', async () => {
  const frames = [];
  const h = harness({ region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, onFrame: frame => frames.push(frame) });
  await h.sample(new Image(640, 360));
  await h.sample(new Image(640, 360).rectangle(160, 90, 16, 16));
  await h.sample(new Image(640, 360).rectangle(160, 90, 16, 16));
  await h.sample(new Image(640, 360), { key: 'new-source' });
  assert.equal(frames.length, 4, 'AI also receives baseline and unchanged frames');
  assert.deepEqual(frames[0].image.getSize(), { width: 320, height: 180 });
  assert.equal(frames[0].baseline, true);
  assert.equal(frames[0].changedRatio, 0);
  assert.equal(frames[0].changedMask.data.some(Boolean), false);
  const { changedMask, image } = frames[1];
  assert.equal(frames[1].baseline, false);
  assert.equal(frames[1].key, 'camera');
  assert.equal(image.toBitmap().length, 320 * 180 * 4);
  assert.equal(image.toBitmap()[0], 255, 'cropped image retains full source detail');
  assert.equal(changedMask.width, 160);
  assert.equal(changedMask.height, 90);
  assert(changedMask.data instanceof Uint8Array);
  assert.equal(changedMask.data.reduce((sum, value) => sum + value, 0), 64);
  assert.equal(changedMask.data[0], 1);
  assert.equal(changedMask.data[7 * 160 + 7], 1);
  assert.equal(changedMask.data[8], 0);
  assert.equal(frames[1].changedRatio, 64 / (160 * 90));
  assert.equal(frames[2].changedRatio, 0);
  assert.equal(frames[3].baseline, true);
  h.watcher.stop();
});

test('the asynchronous frame consumer finishes before another camera capture can start', async () => {
  let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = harness({ onFrame: () => blocked }, async () => {
    calls++;
    return { image: new Image(), key: 'camera' };
  });
  h.watcher.start();
  await flush();
  assert.equal(calls, 1);
  assert.equal(h.getTimer(), undefined, 'capture polling waits for inference');
  h.watcher.stop();
  h.watcher.start();
  h.getTimer()();
  await flush();
  assert.equal(calls, 1, 'restart also waits for the prior generation inference');
  release();
  await flush();
  assert.equal(h.statuses.length, 0, 'old inference completion cannot report the camera as armed');
  h.watcher.stop();
});

test('stopping while inference runs cannot deliver a later confirmed-motion event', async () => {
  let release, block = false;
  const h = harness({ onFrame: () => block ? new Promise(resolve => { release = resolve; }) : undefined });
  await h.sample(new Image());
  await h.sample(new Image().rectangle(20, 10, 10, 20));
  block = true;
  await h.sample(new Image());
  h.watcher.stop();
  release();
  await flush();
  assert.equal(h.events.length, 0);
  assert.equal(h.getTimer(), undefined);
});

test('frame-consumer failure waits without status spam and uses a fresh baseline on recovery', async () => {
  let fail = false;
  const frames = [];
  const h = harness({ onFrame(frame) {
    frames.push(frame);
    if (fail) throw new Error('inference unavailable');
  } });
  await h.sample(new Image());
  await h.sample(new Image().rectangle(20, 10, 10, 20));
  fail = true;
  await h.sample(new Image());
  await h.sample(new Image().rectangle(20, 10, 10, 20));
  await h.sample(new Image());
  fail = false;
  await h.sample(new Image().rectangle(20, 10, 10, 20));
  assert.equal(frames.at(-1).baseline, true);
  assert.equal(h.events.length, 0);
  assert.deepEqual(h.statuses.map(status => status.state), ['armed', 'waiting-camera', 'armed']);
  h.watcher.stop();
});
