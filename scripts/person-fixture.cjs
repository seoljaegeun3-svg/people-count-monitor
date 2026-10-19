// Test-only scene built from Lav Varshney's CC0 photograph. See the fixture's
// README for attribution, source and hash; none of these files are packaged.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const fixturePath = path.join(__dirname, '..', 'test-fixtures', 'person-detector', 'camera-cc0.png');
const crop = Object.freeze({ x: 4, y: 64, width: 320, height: 448 });
const patchSize = Object.freeze({ width: 120, height: 180 });
const sceneSize = Object.freeze({ width: 640, height: 360 });
let patch;

function createPersonFrame(centerX = 0.5, visible = true) {
  const { width, height } = sceneSize;
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 20;
    data[index + 1] = 25;
    data[index + 2] = 30;
    data[index + 3] = 255;
  }
  if (visible) {
    patch ||= execFileSync(require('ffmpeg-static'), [
      '-v', 'error', '-i', fixturePath,
      '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${patchSize.width}:${patchSize.height}:flags=bilinear`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'
    ], { maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    const left = Math.round(centerX * width - patchSize.width / 2);
    const top = (height - patchSize.height) / 2;
    if (left < 0 || left + patchSize.width > width) throw new Error('Person fixture is outside the frame.');
    for (let y = 0; y < patchSize.height; y++) {
      patch.copy(data, ((top + y) * width + left) * 4,
        y * patchSize.width * 4, (y + 1) * patchSize.width * 4);
    }
  }
  return { data, width, height, format: 'rgba' };
}

module.exports = { createPersonFrame, fixturePath, crop, patchSize, sceneSize };
