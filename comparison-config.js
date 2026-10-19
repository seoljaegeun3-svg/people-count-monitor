const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateMotionSettings } = require('./motion');

function defaults() {
  return {
    configured: false,
    region: { x: 0, y: 0, width: 1, height: 1 },
    sensitivity: 'normal',
    line: { axis: 'vertical', position: .5, invert: false },
    mapping: 'unknown', confidence: .45
  };
}

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.configured !== 'boolean' || !input.region || !input.line) {
    throw new Error('비교 설정 형식을 확인하세요.');
  }
  const motion = validateMotionSettings(input);
  const { line, mapping, confidence } = input;
  if (!line || typeof line !== 'object' || Array.isArray(line)
    || !['vertical', 'horizontal'].includes(line.axis)
    || typeof line.position !== 'number' || !Number.isFinite(line.position)
    || line.position < .1 || line.position > .9 || typeof line.invert !== 'boolean') {
    throw new Error('출입선 방향과 위치, 입장 방향을 확인하세요.');
  }
  if (!['occupancy', 'total', 'unknown'].includes(mapping)) {
    throw new Error('PLC 값의 의미를 선택하세요.');
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < .2 || confidence > .7) {
    throw new Error('사람 인식 신뢰도는 20%부터 70% 사이로 지정하세요.');
  }
  return {
    configured: input.configured, ...motion,
    line: { axis: line.axis, position: line.position, invert: line.invert }, mapping, confidence
  };
}

function sourceIdentity(value) {
  if (!value || typeof value.key !== 'string' || value.key.length < 1 || value.key.length > 8192
    || !Number.isInteger(value.width) || !Number.isInteger(value.height)
    || value.width < 1 || value.height < 1 || value.width > 16384 || value.height > 16384) {
    throw new Error('카메라 영상 크기와 주소를 확인하지 못했습니다. 카메라를 연 뒤 다시 설정하세요.');
  }
  return { key: value.key, width: value.width, height: value.height };
}

async function createComparisonSettings({ filePath, capture }) {
  let current = defaults(), lastPreview = null, writes = Promise.resolve();
  const clone = value => structuredClone(value);
  try {
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const valid = validateSettings(saved);
    if (valid.configured) valid.source = sourceIdentity(saved.source);
    current = valid;
  } catch { /* Missing or invalid calibration keeps automatic comparison disabled. */ }

  async function preview() {
    lastPreview = null;
    const frame = await capture();
    if (!frame?.image || frame.image.isEmpty?.()) {
      throw new Error('카메라 화면을 불러오지 못했습니다. 카메라를 연 뒤 다시 시도하세요.');
    }
    const size = frame.image.getSize();
    const source = sourceIdentity({ key: frame.key, width: size.width, height: size.height });
    const image = frame.image.toDataURL();
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      throw new Error('카메라 미리보기를 만들지 못했습니다. 다시 시도하세요.');
    }
    lastPreview = source;
    return { image, ...source };
  }

  function save(input) {
    let valid;
    try {
      if (input && (Object.hasOwn(input, 'source') || Object.hasOwn(input, 'key'))) {
        throw new Error('카메라 정보는 미리보기에서만 지정할 수 있습니다.');
      }
      valid = validateSettings(input);
    } catch (error) { return Promise.reject(error); }
    const reviewed = lastPreview && clone(lastPreview);
    const operation = writes.then(async () => {
      if (valid.configured) {
        if (!reviewed) throw new Error('카메라 미리보기를 열고 영상 영역과 출입선을 확인하세요.');
        const actual = sourceIdentity(await capture({ identityOnly: true }));
        if (actual.key !== reviewed.key || actual.width !== reviewed.width || actual.height !== reviewed.height) {
          lastPreview = null;
          throw new Error('카메라 화면이 바뀌었습니다. AI 비교 설정을 다시 열어 확인하세요.');
        }
        valid.source = reviewed;
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      let file;
      try {
        file = await fs.open(temporary, 'wx', 0o600);
        await file.writeFile(`${JSON.stringify(valid, null, 2)}\n`);
        await file.sync(); await file.close(); file = null;
        await fs.rename(temporary, filePath);
        current = valid;
      } finally {
        if (file) await file.close().catch(() => {});
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
      return clone(current);
    });
    writes = operation.catch(() => {});
    return operation;
  }

  return { get: () => clone(current), preview, save };
}

module.exports = { createComparisonSettings };
