const MOTION_DEFAULTS = Object.freeze({
  region: Object.freeze({ x: 0, y: 0, width: 1, height: 1 }),
  sensitivity: 'normal'
});
const THRESHOLDS = { low: 0.03, normal: 0.01, high: 0.003 };
const FRAME_WIDTH = 160;
const FRAME_HEIGHT = 90;

function validateMotionSettings(settings = MOTION_DEFAULTS) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('움직임 감지 설정을 확인하세요.');
  }
  const region = settings.region === undefined ? MOTION_DEFAULTS.region : settings.region;
  const sensitivity = settings.sensitivity === undefined ? MOTION_DEFAULTS.sensitivity : settings.sensitivity;
  if (!region || typeof region !== 'object' || Array.isArray(region)
    || !['x', 'y', 'width', 'height'].every(key => typeof region[key] === 'number' && Number.isFinite(region[key]))
    || region.x < 0 || region.y < 0 || region.width < 0.05 || region.height < 0.05
    || region.x + region.width > 1 || region.y + region.height > 1) {
    throw new Error('감지 영역은 카메라 안에서 가로·세로 5% 이상으로 지정하세요.');
  }
  if (typeof sensitivity !== 'string' || !Object.hasOwn(THRESHOLDS, sensitivity)) {
    throw new Error('움직임 감도는 낮음·보통·높음 중에서 선택하세요.');
  }
  return { region: { x: region.x, y: region.y, width: region.width, height: region.height }, sensitivity };
}

function createMotionWatcher({ capture, region, sensitivity, onFrame = () => {}, onMotion = () => {}, onStatus = () => {},
  now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const settings = validateMotionSettings({ region, sensitivity });
  let running = false, generation = 0, timer, inFlight = false;
  let baseline, previousKey, previousSize, previousChange, status;

  function report(state) {
    if (status === state) return;
    status = state;
    onStatus({ state, message: state === 'armed' ? '카메라 움직임 감지 중' : '카메라 영상 대기 중' });
  }

  function reset() {
    baseline = undefined;
    previousKey = undefined;
    previousSize = undefined;
    previousChange = undefined;
  }

  function pixels(image) {
    const size = image.getSize();
    if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1
      || image.isEmpty?.()) throw new Error('Empty camera frame');
    const { x, y, width, height } = settings.region;
    const left = Math.floor(x * size.width), top = Math.floor(y * size.height);
    const right = Math.min(size.width, Math.ceil((x + width) * size.width));
    const bottom = Math.min(size.height, Math.ceil((y + height) * size.height));
    const cropped = image.crop({ x: left, y: top, width: right - left, height: bottom - top });
    const bitmap = cropped.resize({ width: FRAME_WIDTH, height: FRAME_HEIGHT, quality: 'good' })
      .toBitmap({ scaleFactor: 1 });
    if (bitmap.length !== FRAME_WIDTH * FRAME_HEIGHT * 4) throw new Error('Invalid camera frame');
    return { image: cropped, bitmap, size: `${size.width}x${size.height}` };
  }

  async function analyze(frame, epoch) {
    if (!frame?.image) {
      reset();
      report('waiting-camera');
      return;
    }
    let sample;
    try { sample = pixels(frame.image); }
    catch {
      reset();
      report('waiting-camera');
      return;
    }
    const { bitmap, size } = sample;
    const isBaseline = !baseline || previousKey !== frame.key || previousSize !== size;
    const changedMask = { data: new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT), width: FRAME_WIDTH, height: FRAME_HEIGHT };
    let changed = 0;
    if (isBaseline) {
      previousKey = frame.key;
      previousSize = size;
      previousChange = undefined;
    } else {
      for (let index = 0; index < bitmap.length; index += 4) {
        const difference = Math.abs(bitmap[index] - baseline[index])
          + Math.abs(bitmap[index + 1] - baseline[index + 1])
          + Math.abs(bitmap[index + 2] - baseline[index + 2]);
        if (difference >= 60) { changed++; changedMask.data[index / 4] = 1; }
      }
    }
    baseline = bitmap;
    const at = now(), changedRatio = changed / (FRAME_WIDTH * FRAME_HEIGHT);
    try {
      await onFrame({ at, image: sample.image, key: frame.key, changedRatio, changedMask, baseline: isBaseline });
    } catch {
      if (running && epoch === generation) { reset(); report('waiting-camera'); }
      return;
    }
    if (!running || epoch !== generation) return;
    report('armed');
    if (isBaseline) return;
    if (changedRatio >= THRESHOLDS[settings.sensitivity]) {
      // A lone image refresh or lighting jump should not save a clip. Keep the
      // first hit through duplicate frames so a 1 fps camera can still trigger.
      if (previousChange !== undefined && at >= previousChange && at - previousChange <= 1000) {
        onMotion({ at, changedRatio });
      }
      previousChange = at;
    } else if (previousChange !== undefined && (at < previousChange || at - previousChange > 1000)) {
      previousChange = undefined;
    }
  }

  function next() {
    if (!running || timer !== undefined) return;
    timer = schedule(() => { timer = undefined; void poll(); }, 250);
  }

  async function poll() {
    if (!running) return;
    if (inFlight) { next(); return; }
    const epoch = generation;
    inFlight = true;
    try {
      let frame;
      try { frame = await capture(); }
      catch { frame = null; }
      if (running && epoch === generation) await analyze(frame, epoch);
    } finally {
      inFlight = false;
      next();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      generation++;
      reset();
      status = undefined;
      void poll();
    },
    stop() {
      running = false;
      generation++;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      reset();
    }
  };
}

module.exports = { MOTION_DEFAULTS, validateMotionSettings, createMotionWatcher };
