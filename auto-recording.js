const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { concatToMP4 } = require('./mp4');
const { comparePassage } = require('./passage-comparison');

const PRE_ROLL = 5_000, POST_ROLL = 10_000, MAX_CLIP = 60_000, MAX_PENDING = 4;

async function createAutoRecording({ folder, mapping = 'unknown', onStatus = () => {}, onError = () => {}, now = Date.now }) {
  if (typeof folder !== 'string' || !folder) throw new Error('자동 녹화 저장 폴더를 선택하세요.');
  folder = path.resolve(folder);
  await fs.mkdir(folder, { recursive: true });
  const working = await fs.mkdtemp(path.join(folder, '.people-count-auto-'));
  const segments = [], queue = [], plcSamples = [], crossings = [], uncertainties = [], observations = [];
  const logPath = path.join(folder, `People-Count-Review-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`);
  let baseline, active, saved = 0, matched = 0, sequence = 0, failure = '', lastPath = '', latestEnd = 0, log;
  let writes = Promise.resolve(), encoding, closing = false, closeResult, pendingBytes = 0, preserveWorking = false;

  function status(state, message, extra = {}) {
    try { onStatus({ state: failure ? 'error' : state, message: failure || message, saved, matched, active: !!active,
      queued: queue.length + (encoding ? 1 : 0), ...extra }); } catch { /* A closing UI must not interrupt saving. */ }
  }
  function trimHistory() {
    // Completed segments can begin before the requested pre-roll boundary.
    // Keep enough history for the largest accepted renderer segment too.
    const cutoff = (active?.start ?? now() - PRE_ROLL) - 15_000;
    for (const list of [plcSamples, observations]) {
      // Preserve a sample before the window as the comparison baseline.
      while (list.length > 1 && list[1].at < cutoff) list.shift();
    }
    for (const list of [crossings, uncertainties]) while (list.length && list[0].at < cutoff) list.shift();
  }
  async function writeReview(clip, video) {
    log ||= await fs.open(logPath, 'ax');
    await log.writeFile(JSON.stringify({ start: clip.parts[0].start, end: clip.parts.at(-1).end,
      mapping, ...clip.review, video: video || null, model: 'YOLOX-tiny' }) + '\n');
    await log.sync();
  }
  function fail(error) {
    if (failure) return;
    failure = error.message || String(error);
    status('error', failure, { path: lastPath || working });
    try { onError(new Error(failure)); } catch { /* Saving the originals still has to finish. */ }
  }
  async function cleanup(all = false) {
    // Keep an extra segment boundary so a change between two completed
    // segments still gets at least five seconds of pre-roll after warm-up.
    const threshold = latestEnd - PRE_ROLL - 2_000;
    for (const part of [...segments]) {
      if (part.refs || preserveWorking || (!all && part.end >= threshold)) continue;
      const index = segments.indexOf(part);
      if (index < 0) continue;
      // Claim deletion synchronously. A PLC callback or another cleanup can run
      // while unlink awaits the disk; neither may acquire this source again or
      // splice an unrelated segment using an index that has since moved.
      segments.splice(index, 1);
      try { await fs.unlink(part.path); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          segments.push(part);
          segments.sort((a, b) => a.start - b.start);
          preserveWorking = true;
          fail(new Error(`자동 녹화 임시 파일을 정리하지 못했습니다: ${error.message}`));
        }
      }
    }
  }
  function addPart(clip, part) {
    if (clip.parts.includes(part)) return;
    clip.parts.push(part);
    part.refs++;
  }
  async function recover(clip) {
    const recovery = path.join(folder, `People-Count-Recovery-${clip.name}`);
    try {
      await fs.mkdir(recovery);
      const manifest = ['ffconcat version 1.0'];
      for (let i = 0; i < clip.parts.length; i++) {
        const part = clip.parts[i], name = `segment-${String(i + 1).padStart(4, '0')}.webm`;
        // A segment can be referenced by both pre-roll and an older conversion.
        // Copy it rather than moving or deleting a shared source.
        await fs.copyFile(part.path, path.join(recovery, name));
        manifest.push(`file '${name}'`, `duration ${((part.end - part.start) / 1000).toFixed(6)}`);
      }
      await fs.writeFile(path.join(recovery, 'segments.ffconcat'), manifest.join('\n') + '\n');
      await fs.writeFile(path.join(recovery, '복구 안내.txt'), 'MP4 저장이 완료되지 않아 독립적으로 재생 가능한 WebM 원본을 보존했습니다.\n' + failure + '\n');
      lastPath = recovery;
    } catch (error) {
      preserveWorking = true;
      lastPath = working;
      failure += ` 원본 복사도 완료하지 못해 ${working} 에 남겨 두었습니다: ${error.message}`;
    }
  }
  function pump() {
    if (encoding || !queue.length) return;
    const clip = queue.shift();
    encoding = (async () => {
      try {
        if (clip.review.status === 'matched') {
          await writeReview(clip);
          matched++;
          status('matched', `영상·PLC 일치 ${matched}구간 · 비교 기록만 보관`, { path: logPath, review: clip.review });
        } else {
          status('converting', '불일치·확인 필요 구간을 MP4로 저장 중… 비교는 계속됩니다.');
          const result = await concatToMP4(clip.parts.map(part => ({ path: part.path, duration: (part.end - part.start) / 1000 })),
            path.join(folder, `People-Count-${clip.review.status === 'mismatch' ? 'Mismatch' : 'Review'}-${clip.name}.mp4`));
          await writeReview(clip, result.path);
          saved++;
          lastPath = result.path;
          status('saved', `확인할 영상 ${saved}개 저장 · 영상 입장 ${clip.review.videoIn} / 퇴장 ${clip.review.videoOut}`, { path: result.path, bytes: result.bytes, review: clip.review });
        }
      } catch (error) {
        fail(new Error(`자동 녹화 MP4 저장에 실패했습니다: ${error.message} 원본 구간을 복구 폴더에 보존합니다.`));
        await recover(clip);
      } finally {
        for (const part of clip.parts) part.refs--;
        await cleanup(closing);
      }
    })().finally(() => {
      encoding = null;
      pump();
      if (!closing && !failure) status(active ? 'recording' : 'armed',
        active ? '영상·PLC 비교 중 · 마지막 감지 뒤 10초까지 확인' : `AI 비교 대기 · 확인 영상 ${saved}개 / 일치 ${matched}구간`);
    });
  }
  function seal() {
    const clip = active;
    active = null;
    if (!clip?.parts.length) return;
    clip.name = `${new Date(clip.parts[0].start).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const start = clip.parts[0].start, end = clip.parts.at(-1).end;
    const samples = observations.filter(value => value.at >= start && value.at < end);
    const doubts = uncertainties.filter(value => value.at >= start && value.at < end);
    if (!samples.length || samples[0].at - start > 2000 || end - samples.at(-1).at > 2000) {
      doubts.push({ at: start, reason: '비교 구간 전체의 영상 분석을 확인하지 못했습니다.' });
    }
    if (samples.some((sample, index) => !sample.healthy || (index > 0 && sample.at - samples[index - 1].at > 2000))) {
      doubts.push({ at: start, reason: '비교 구간 중 영상 분석이 중단된 시간이 있습니다.' });
    }
    if (closing && end < clip.deadline) doubts.push({ at: start, reason: '자동 녹화를 꺼 통행 후 확인 시간이 끝나기 전에 저장했습니다.' });
    if (clip.split) doubts.push({ at: start, reason: '통행이 이어져 구간을 나눴으므로 경계의 통행을 확인해야 합니다.' });
    clip.review = comparePassage({ start, end, mapping, crossings, plcSamples, uncertainties: doubts, motionCandidate: clip.motionCandidate });
    // One overflow clip is retained for recovery while onError stops capture.
    // No event is silently dropped when the encoder cannot keep up.
    if (queue.length + (encoding ? 1 : 0) >= MAX_PENDING) fail(new Error('MP4 저장이 녹화 속도를 따라가지 못해 자동 녹화를 중지합니다. 수집한 원본은 보존합니다.'));
    queue.push(clip);
    pump();
  }
  function candidate(at, motionCandidate = false) {
    if (closing || failure) return;
    if (!active) {
      active = { start: at - PRE_ROLL, deadline: at + POST_ROLL, motionCandidate, parts: [] };
      for (const part of segments) if (part.end > active.start && part.start <= at) addPart(active, part);
    } else {
      active.deadline = Math.max(active.deadline, at + POST_ROLL);
      active.motionCandidate ||= motionCandidate;
    }
    status('recording', '영상·PLC 비교 중 · 마지막 감지 뒤 10초까지 확인');
  }
  function onMotion({ at = now() } = {}) { if (Number.isFinite(at)) candidate(at, true); }
  function onObservation({ at = now(), events = [], uncertain = [], healthy = true } = {}) {
    if (closing || failure || !Number.isFinite(at)) return;
    observations.push({ at, healthy });
    for (const event of events) if (Number.isFinite(event.at)) crossings.push({ ...event });
    for (const reason of uncertain) uncertainties.push({ at, reason: String(reason) });
    if (!healthy && !uncertain.length) uncertainties.push({ at, reason: '카메라 영상 분석을 확인하지 못했습니다.' });
    if (events.length) candidate(at, true);
    trimHistory();
  }
  function onPLC(data) {
    if (closing || failure) return;
    plcSamples.push({ at: now(), state: data?.state, value: data?.value });
    trimHistory();
    if (data?.state !== 'ok' || !Number.isInteger(data.value) || data.value < 0 || data.value > 65535) {
      baseline = undefined;
      status(active ? 'recording' : 'armed', 'PLC 연결 대기 · 카메라 감지는 계속하며 확인 영상을 보관합니다.');
      return;
    }
    const previous = baseline;
    baseline = data.value;
    if (previous === undefined || previous === baseline) {
      return;
    }
    candidate(now());
  }
  async function segment(buffer, timing) {
    if (closing) throw new Error('자동 녹화가 이미 종료되었습니다.');
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 16 * 1024 * 1024 ||
        !Number.isFinite(timing?.start) || !Number.isFinite(timing?.end) || timing.end <= timing.start || timing.end - timing.start > MAX_CLIP) {
      const error = new Error('자동 녹화 구간 데이터나 시간이 올바르지 않습니다.');
      fail(error); throw error;
    }
    if (pendingBytes + buffer.length > 32 * 1024 * 1024) {
      const error = new Error('자동 녹화 데이터를 디스크에 저장하는 속도가 부족합니다. 다른 저장 폴더를 사용하세요.');
      fail(error); throw error;
    }
    const part = { path: path.join(working, `segment-${String(++sequence).padStart(8, '0')}.webm`),
      start: timing.start, end: timing.end, refs: 0 };
    pendingBytes += buffer.length;
    const operation = writes.then(async () => {
      try {
        await fs.writeFile(part.path, buffer, { flag: 'wx' });
        segments.push(part);
        latestEnd = Math.max(latestEnd, part.end);
        if (active && part.end > active.start && part.start <= active.deadline) {
          if (active.parts.length && part.end - active.parts[0].start > MAX_CLIP) {
            const { deadline, motionCandidate } = active;
            active.split = true;
            seal();
            active = { start: part.start, deadline, motionCandidate, split: true, parts: [] };
          }
          addPart(active, part);
        }
        if (active && part.end >= active.deadline) seal();
        await cleanup();
      } catch (error) {
        preserveWorking = true;
        lastPath = working;
        fail(new Error(`자동 녹화 원본을 저장하지 못했습니다: ${error.message} 이미 수집한 파일은 ${working} 에 보존합니다.`));
        throw error;
      }
    });
    writes = operation.catch(() => {});
    try { await operation; } finally { pendingBytes -= buffer.length; }
  }
  function close(error = '') {
    if (closeResult) return closeResult;
    closing = true;
    closeResult = (async () => {
      await writes;
      if (error) fail(error instanceof Error ? error : new Error(String(error)));
      seal();
      while (encoding || queue.length) { pump(); await encoding; }
      if (log) { await log.close(); log = null; }
      await cleanup(true);
      if (!preserveWorking) await fs.rm(working, { recursive: true, force: true }).catch(cause => {
        preserveWorking = true;
        lastPath ||= working;
        fail(new Error(`자동 녹화 임시 폴더를 정리하지 못했습니다: ${cause.message}`));
      });
      return { saved, matched, folder, path: lastPath || (matched ? logPath : ''), error: failure };
    })();
    return closeResult;
  }
  status('armed', '카메라 움직임과 PLC를 비교할 준비 중');
  return { segment, onPLC, onMotion, onObservation, close };
}

module.exports = { createAutoRecording };
