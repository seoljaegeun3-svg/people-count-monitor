const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createPersonDetector, preprocess, decode, intersectionOverUnion, loadModel } = require('./person-detector');

test('detector uses BGR 0..255, ignores alpha and pads only bottom/right with 114', () => {
  const data = Buffer.from([255, 10, 20, 0, 0, 30, 40, 255]);
  const prepared = preprocess({ data, width: 2, height: 1 });
  const plane = 416 * 416;
  assert.equal(prepared.tensor[0], 20);
  assert.equal(prepared.tensor[plane], 10);
  assert.equal(prepared.tensor[2 * plane], 255);
  assert.equal(prepared.tensor[415], 40);
  assert.equal(prepared.tensor[plane + 415], 30);
  assert.equal(prepared.tensor[2 * plane + 415], 0);
  assert.equal(prepared.tensor[208 * 416], 114);
  const nativeImage = { getSize: () => ({ width: 2, height: 1 }),
    toBitmap: () => Buffer.from([20, 10, 255, 0, 40, 30, 0, 255]) };
  assert.deepEqual(preprocess(nativeImage).tensor, prepared.tensor);
  assert.throws(() => preprocess({ data: Buffer.alloc(4), width: 2, height: 1 }), /카메라/);
});

test('raw YOLOX grid decoding suppresses duplicate person boxes and clips to ROI', () => {
  const data = new Float32Array(3549 * 85);
  function box(row, x, y, width, height, confidence, person = 1) {
    data.set([x, y, Math.log(width / 8), Math.log(height / 8), confidence, person], row * 85);
  }
  box(0, 8, 8, 100, 80, 0.9);
  box(1, 7, 8, 100, 80, 0.8);
  box(100, 0, 0, 20, 30, 0.9, 0.05); // A non-person class is ignored.
  const decoded = decode({ type: 'float32', data, dims: [1, 3549, 85] },
    { width: 416, height: 416, ratio: 1 });
  assert.equal(decoded.length, 1);
  assert.ok(Math.abs(decoded[0].score - 0.9) < 0.0001);
  assert.ok(decoded[0].x >= 0 && decoded[0].y >= 0);
  assert.ok(decoded[0].x + decoded[0].width <= 1);
  assert.equal(intersectionOverUnion(decoded[0], decoded[0]), 1);
  assert.throws(() => decode({ type: 'float32', dims: [1, 1, 85] }, {}), /모델/);
});

test('bundled model hash and real CPU inference detect licensed people and reject an empty scene', async () => {
  await loadModel();
  const detector = await createPersonDetector();
  try {
    for (const [name, hash] of [
      ['camera-cc0.png', 'b0793d2adda0fa6ae899c03989482bff9a42d3d5690fc7e3648f2795d730c23a'],
      ['astronaut-public-domain.png', '88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5']
    ]) {
      const filename = path.join(__dirname, 'test-fixtures', 'person-detector', name);
      assert.equal(createHash('sha256').update(await fs.readFile(filename)).digest('hex'), hash);
      const data = execFileSync(require('ffmpeg-static'),
        ['-v', 'error', '-i', filename, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
        { maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      const result = await detector.detect({ data, width: 512, height: 512 });
      assert.equal(result.detections.length, 1, `${name}: one clear person should be detected`);
      assert.ok(result.detections[0].score > 0.8, `${name}: wrong preprocessing can drastically reduce confidence`);
      assert.ok(result.elapsedMs > 0);
      assert.ok(result.detections[0].width > 0.4 && result.detections[0].height > 0.7);
    }
    const blank = await detector.detect({ data: Buffer.alloc(512 * 512 * 4, 114), width: 512, height: 512 });
    assert.deepEqual(blank.detections, []);
    assert.deepEqual(blank.weakDetections, []);
  } finally { await detector.close(); }
  await assert.rejects(detector.detect({}), /종료/);
});
