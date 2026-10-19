// A single occupancy register only reveals observed changes. Opposing passages
// hidden between polls must never be declared equal from their net value alone.
function comparePassage({ start, end, crossings = [], plcSamples = [], uncertainties = [], mapping = 'unknown', motionCandidate = false } = {}) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('비교 구간 시간이 올바르지 않습니다.');
  const reasons = new Set();
  const doubt = reason => reasons.add(reason);
  let videoIn = 0, videoOut = 0, plcIn = 0, plcOut = 0, plcTotal = 0;
  for (const crossing of crossings) {
    if (!Number.isFinite(crossing?.at) || crossing.at < start || crossing.at >= end) continue;
    if (crossing.direction === 'in') videoIn++;
    else if (crossing.direction === 'out') videoOut++;
    else doubt('영상 통행 방향을 판정하지 못한 기록이 있습니다.');
  }
  for (const item of uncertainties) {
    if (item && typeof item === 'object' && Number.isFinite(item.at) && (item.at < start || item.at >= end)) continue;
    const reason = typeof item === 'string' ? item : item?.reason;
    if (reason) doubt(String(reason));
  }
  if (motionCandidate && !videoIn && !videoOut) doubt('움직임 구간에서 사람의 통행 수를 확인하지 못했습니다.');
  if (!['occupancy', 'total'].includes(mapping)) doubt('PLC 값이 재실 인원인지 누적 통행 수인지 설정해야 합니다.');

  const samples = plcSamples.filter(sample => Number.isFinite(sample?.at));
  if (samples.some((sample, index) => index && sample.at < samples[index - 1].at && sample.at >= start && sample.at < end)) {
    doubt('PLC 수신 시간의 순서가 올바르지 않습니다.');
  }
  const ordered = samples.map((sample, index) => ({ ...sample, index })).sort((a, b) => a.at - b.at || a.index - b.index);
  const before = ordered.filter(sample => sample.at < start).at(-1);
  const inWindow = ordered.filter(sample => sample.at >= start && sample.at < end);
  const valid = sample => sample?.state === 'ok' && Number.isInteger(sample.value) && sample.value >= 0 && sample.value <= 65535;
  let previous = valid(before) ? before : undefined;
  if (!previous) doubt('비교 시작 직전의 정상 PLC 기준값이 없습니다.');
  else if (start - previous.at > 2000) { doubt('비교 시작 전 PLC 값이 오래되어 기준값을 신뢰하기 어렵습니다.'); previous = undefined; }
  let lastGoodAt = previous?.at;
  for (const sample of inWindow) {
    if (!valid(sample)) {
      doubt('비교 구간에 PLC 연결 중단 또는 읽기 오류가 있습니다.');
      previous = undefined;
      continue;
    }
    lastGoodAt = sample.at;
    if (previous) {
      if (sample.at - previous.at > 2000) doubt('PLC 수신 간격이 길어 중간 변화를 놓쳤을 수 있습니다.');
      if (sample.at === previous.at && sample.value !== previous.value) doubt('같은 수신 시각에 서로 다른 PLC 값이 있습니다.');
      const forward = (sample.value - previous.value + 65536) % 65536;
      const delta = forward <= 32767 ? forward : forward - 65536;
      if (Math.abs(delta) > 10) doubt('PLC 값이 크게 바뀌어 초기화 또는 통행 누락을 구분하기 어렵습니다.');
      else if (mapping === 'total') {
        if (delta < 0) doubt('누적 통행 수가 감소하여 PLC 초기화 여부를 확인해야 합니다.');
        else plcTotal += delta;
      } else if (mapping === 'occupancy') {
        if (sample.value === 0 && previous.value > 1 && delta < 0) doubt('PLC 값이 0으로 바뀌어 초기화 여부를 확인해야 합니다.');
        if (delta > 0) plcIn += delta;
        else plcOut -= delta;
      }
    }
    previous = sample;
  }
  if (lastGoodAt === undefined || end - lastGoodAt > 2000) doubt('비교 종료 시점까지 정상 PLC 수신이 이어지지 않았습니다.');
  if (mapping === 'occupancy') plcTotal = plcIn + plcOut;
  const countsEqual = mapping === 'occupancy' ? videoIn === plcIn && videoOut === plcOut : mapping === 'total' && videoIn + videoOut === plcTotal;
  if (mapping === 'occupancy' && videoIn && videoOut && !countsEqual && videoIn - videoOut === plcIn - plcOut) {
    doubt('입장과 퇴장이 PLC 수신 사이에 상쇄되었을 수 있어 순변화만으로 일치 판정할 수 없습니다.');
  }
  const status = reasons.size ? 'uncertain' : countsEqual ? 'matched' : 'mismatch';
  if (status === 'mismatch') reasons.add(mapping === 'total'
    ? `영상 통행 ${videoIn + videoOut}명과 PLC 통행 ${plcTotal}명이 다릅니다.`
    : `영상 입장 ${videoIn}명·퇴장 ${videoOut}명과 PLC 입장 ${plcIn}명·퇴장 ${plcOut}명이 다릅니다.`);
  return { status, videoIn, videoOut, ...(mapping === 'occupancy' ? { plcIn, plcOut, plcTotal } : mapping === 'total' ? { plcTotal } : {}), reasons: [...reasons] };
}

module.exports = { comparePassage };
