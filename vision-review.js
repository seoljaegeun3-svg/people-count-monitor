const { createMotionWatcher } = require('./motion');
const { createPersonDetector } = require('./person-detector');
const { createPeopleCounter } = require('./people-counter');

function unexplainedChange(mask, boxes) {
  const { width, height, data } = mask;
  const covered = new Uint8Array(width * height);
  for (const box of boxes) {
    if (!box || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]))
      || box.width <= 0 || box.height <= 0) continue;
    const padX = Math.max(0.02, box.width * 0.2), padY = Math.max(0.02, box.height * 0.2);
    const left = Math.max(0, Math.min(width, Math.floor((box.x - padX) * width)));
    const top = Math.max(0, Math.min(height, Math.floor((box.y - padY) * height)));
    const right = Math.max(0, Math.min(width, Math.ceil((box.x + box.width + padX) * width)));
    const bottom = Math.max(0, Math.min(height, Math.ceil((box.y + box.height + padY) * height)));
    for (let y = top; y < bottom; y++) covered.fill(1, y * width + left, y * width + right);
  }
  let unexplained = 0;
  for (let index = 0; index < data.length; index++) if (data[index] && !covered[index]) unexplained++;
  return unexplained / (width * height);
}

async function createVisionReview({ capture, settings, onMotion = () => {}, onObservation = () => {},
  onStatus = () => {}, onFatal = () => {} }) {
  if (typeof settings?.source?.key !== 'string' || !settings.source.key) {
    throw new Error('카메라 영상 영역과 통행선을 먼저 설정하세요.');
  }
  const sourceKey = settings.source.key;
  const detector = await createPersonDetector({ scoreThreshold: settings.confidence ?? 0.35, weakThreshold: 0.15 });
  const counter = createPeopleCounter({ line: { ...settings.line }, confidence: settings.confidence });
  let active = false, generation = 0, stopPromise, inference = Promise.resolve();
  let priorBoxes = [], previousAt, interrupted = false, seenFrame = false;

  function stop() {
    if (stopPromise) return stopPromise;
    active = false;
    generation++;
    watcher.stop();
    counter.reset();
    priorBoxes = [];
    stopPromise = (async () => { await inference; await detector.close(); })();
    return stopPromise;
  }

  function fatal(cause) {
    if (!active) return;
    const stopping = stop();
    // The caller receives the failure through onFatal. A failed cleanup must
    // not become an unhandled rejection while that caller shuts the app down.
    stopping.catch(() => {});
    onFatal(cause instanceof Error ? cause : new Error(String(cause)));
  }

  async function analyze(frame) {
    const epoch = generation;
    if (!active) return;
    try {
      const gap = previousAt !== undefined && frame.at - previousAt > 2000;
      if (frame.baseline || gap) { counter.reset(); priorBoxes = []; }
      const started = Date.now();
      const result = await detector.detect(frame.image);
      if (!active || epoch !== generation) return;
      const detections = [...result.detections, ...result.weakDetections];
      const unexplainedRatio = frame.baseline ? 0
        : unexplainedChange(frame.changedMask, [...detections, ...priorBoxes]);
      const observation = counter.update(detections, {
        at: frame.at, motionRatio: frame.changedRatio, unexplainedRatio
      });
      const uncertain = new Set(observation.uncertain);
      if (result.weakDetections.length) uncertain.add('사람 검출의 신뢰도가 낮습니다.');
      if (unexplainedRatio > 0.01) uncertain.add('사람으로 설명되지 않는 움직임이 있습니다.');
      if (gap) uncertain.add('영상 분석 간격이 길어 통행을 놓쳤을 수 있습니다.');
      if (Math.max(result.elapsedMs || 0, Date.now() - started) > 800) {
        uncertain.add('영상 분석이 느려 빠른 통행을 놓쳤을 수 있습니다.');
      }
      if (frame.baseline && (interrupted || seenFrame)) {
        uncertain.add('카메라 영상 기준을 다시 잡아 이전 통행을 확인할 수 없습니다.');
      }
      priorBoxes = detections;
      previousAt = frame.at;
      interrupted = false;
      seenFrame = true;
      await onObservation({ at: frame.at, events: observation.events, uncertain: [...uncertain],
        healthy: true, personCount: observation.personCount, boxes: observation.boxes,
        motionRatio: frame.changedRatio, unexplainedRatio });
    } catch (cause) { fatal(cause); }
  }

  const watcher = createMotionWatcher({ region: settings.region, sensitivity: settings.sensitivity,
    async capture() {
      const epoch = generation;
      const frame = await capture();
      if (!active || epoch !== generation) return null;
      if (frame && frame.key !== sourceKey) {
        fatal(new Error('카메라 페이지가 바뀌었습니다. 영상 영역과 통행선을 다시 설정하세요.'));
        return null;
      }
      return frame;
    },
    onFrame(frame) {
      const operation = analyze(frame);
      inference = operation.catch(() => {});
      return operation;
    },
    onMotion(event) {
      if (!active) return;
      try { onMotion(event); } catch (cause) { fatal(cause); }
    },
    onStatus(status) {
      if (!active) return;
      try {
        if (status.state === 'waiting-camera') {
          counter.reset();
          priorBoxes = [];
          previousAt = undefined;
          interrupted = true;
          onObservation({ at: Date.now(), events: [], uncertain: ['카메라 영상 중단'],
            healthy: false, personCount: 0, boxes: [] });
        }
        onStatus(status);
      } catch (cause) { fatal(cause); }
    }
  });

  return {
    start() {
      if (stopPromise) throw new Error('종료한 영상 분석을 다시 시작할 수 없습니다.');
      if (active) return;
      active = true;
      generation++;
      watcher.start();
    },
    stop
  };
}

module.exports = { createVisionReview };
