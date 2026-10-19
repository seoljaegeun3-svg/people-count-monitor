const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const model = require('./models/manifest.json');

const INPUT_SIZE = 416;
// The August 2021 release removed RGB/ImageNet normalization. Its ONNX asset
// uses BGR 0..255, despite the release tag pointing at older source code.
function preprocess(image) {
  let data, width, height, format;
  if (typeof image?.toBitmap === 'function') {
    ({ width, height } = image.getSize());
    data = image.toBitmap({ scaleFactor: 1 });
    format = 'bgra';
  } else ({ data, width, height, format = 'rgba' } = image || {});
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 16384 || height > 16384 || !ArrayBuffer.isView(data)
    || data.byteLength !== width * height * 4 || !['rgba', 'bgra'].includes(format)) {
    throw new Error('사람 감지에 사용할 카메라 영상을 읽지 못했습니다.');
  }
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const ratio = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  const resizedWidth = Math.max(1, Math.floor(width * ratio));
  const resizedHeight = Math.max(1, Math.floor(height * ratio));
  const plane = INPUT_SIZE * INPUT_SIZE;
  const tensor = new Float32Array(3 * plane).fill(114);
  for (let y = 0; y < resizedHeight; y++) {
    const sourceY = Math.max(0, Math.min(height - 1, (y + 0.5) * height / resizedHeight - 0.5));
    const y0 = Math.floor(sourceY), y1 = Math.min(height - 1, y0 + 1), fy = sourceY - y0;
    for (let x = 0; x < resizedWidth; x++) {
      const sourceX = Math.max(0, Math.min(width - 1, (x + 0.5) * width / resizedWidth - 0.5));
      const x0 = Math.floor(sourceX), x1 = Math.min(width - 1, x0 + 1), fx = sourceX - x0;
      const offsets = [(y0 * width + x0) * 4, (y0 * width + x1) * 4,
        (y1 * width + x0) * 4, (y1 * width + x1) * 4];
      for (let channel = 0; channel < 3; channel++) {
        const sourceChannel = format === 'bgra' ? channel : 2 - channel;
        const top = bytes[offsets[0] + sourceChannel] * (1 - fx) + bytes[offsets[1] + sourceChannel] * fx;
        const bottom = bytes[offsets[2] + sourceChannel] * (1 - fx) + bytes[offsets[3] + sourceChannel] * fx;
        // OpenCV resizes uint8 before converting to float32.
        const value = Math.round(top * (1 - fy) + bottom * fy);
        tensor[channel * plane + y * INPUT_SIZE + x] = value;
      }
    }
  }
  return { tensor, width, height, ratio };
}

function intersectionOverUnion(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  return intersection / Math.max(Number.EPSILON, a.width * a.height + b.width * b.height - intersection);
}

function decode(output, { width, height, ratio }, threshold = 0.15) {
  if (output.type !== 'float32' || output.dims.length !== 3 || output.dims[0] !== 1
    || output.dims[1] !== 3549 || output.dims[2] !== 85) {
    throw new Error('사람 감지 모델의 출력 형식이 맞지 않습니다. 프로그램을 다시 다운로드하세요.');
  }
  const candidates = [];
  let row = 0;
  for (const stride of [8, 16, 32]) {
    const gridSize = INPUT_SIZE / stride;
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++, row++) {
        const offset = row * 85, values = output.data;
        const score = values[offset + 4] * values[offset + 5];
        if (!Number.isFinite(score) || score < threshold) continue;
        const centerX = (values[offset] + gx) * stride / ratio;
        const centerY = (values[offset + 1] + gy) * stride / ratio;
        const boxWidth = Math.exp(values[offset + 2]) * stride / ratio;
        const boxHeight = Math.exp(values[offset + 3]) * stride / ratio;
        const left = Math.max(0, Math.min(width, centerX - boxWidth / 2));
        const top = Math.max(0, Math.min(height, centerY - boxHeight / 2));
        const right = Math.max(0, Math.min(width, centerX + boxWidth / 2));
        const bottom = Math.max(0, Math.min(height, centerY + boxHeight / 2));
        if (![left, top, right, bottom].every(Number.isFinite) || right - left < 2 || bottom - top < 2) continue;
        candidates.push({ x: left / width, y: top / height,
          width: (right - left) / width, height: (bottom - top) / height, score });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const detections = [];
  for (const candidate of candidates) {
    if (detections.every(previous => intersectionOverUnion(previous, candidate) <= 0.45)) detections.push(candidate);
    if (detections.length >= 100) break;
  }
  return detections;
}

async function loadModel() {
  // ORT accepts bytes, so the exact verified model is used both in source and
  // inside Electron's asar without relying on native library virtual paths.
  const bytes = await fs.readFile(path.join(__dirname, 'models', model.file));
  if (bytes.length !== model.bytes || createHash('sha256').update(bytes).digest('hex') !== model.sha256) {
    throw new Error('사람 감지 모델 파일이 손상되었습니다. 프로그램을 다시 다운로드하세요.');
  }
  return bytes;
}

async function createPersonDetector({ scoreThreshold = 0.35, weakThreshold = 0.15 } = {}) {
  if (!(weakThreshold > 0 && weakThreshold <= scoreThreshold && scoreThreshold <= 1)) {
    throw new Error('사람 감지 신뢰도 설정이 올바르지 않습니다.');
  }
  const ort = require('onnxruntime-node');
  const session = await ort.InferenceSession.create(await loadModel(), {
    executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1,
    graphOptimizationLevel: 'all', executionMode: 'sequential'
  });
  let closed = false, pending = Promise.resolve();
  return {
    detect(image) {
      if (closed) return Promise.reject(new Error('사람 감지가 종료되었습니다.'));
      const operation = pending.then(async () => {
        const started = performance.now();
        const prepared = preprocess(image);
        const results = await session.run({
          [session.inputNames[0]]: new ort.Tensor('float32', prepared.tensor, [1, 3, INPUT_SIZE, INPUT_SIZE])
        });
        const boxes = decode(results[session.outputNames[0]], prepared, weakThreshold);
        return { detections: boxes.filter(box => box.score >= scoreThreshold),
          weakDetections: boxes.filter(box => box.score < scoreThreshold),
          width: prepared.width, height: prepared.height, elapsedMs: performance.now() - started };
      });
      pending = operation.catch(() => {});
      return operation;
    },
    async close() {
      if (closed) return;
      closed = true;
      await pending;
      await session.release();
    }
  };
}

module.exports = { createPersonDetector, preprocess, decode, intersectionOverUnion, loadModel };
