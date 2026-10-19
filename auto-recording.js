const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { concatToMP4 } = require('./mp4');

const PRE_ROLL = 5_000, POST_ROLL = 10_000, MAX_CLIP = 60_000, MAX_PENDING = 4;

async function createAutoRecording({ folder, onStatus = () => {}, onError = () => {}, now = Date.now }) {
  if (typeof folder !== 'string' || !folder) throw new Error('자동 녹화 저장 폴더를 선택하세요.');
  folder = path.resolve(folder);
  await fs.mkdir(folder, { recursive: true });
  const working = await fs.mkdtemp(path.join(folder, '.people-count-auto-'));
  const segments = [], queue = [];
  let baseline, active, saved = 0, sequence = 0, failure = '', lastPath = '', latestEnd = 0;
  let writes = Promise.resolve(), encoding, closing = false, closeResult, pendingBytes = 0, preserveWorking = false;

  function status(state, message, extra = {}) {
    try { onStatus({ state: failure ? 'error' : state, message: failure || message, saved, active: !!active,
      queued: queue.length + (encoding ? 1 : 0), ...extra }); } catch { /* A closing UI must not interrupt saving. */ }
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
        status('converting', '통행 구간을 MP4로 저장 중… 자동 감지는 계속됩니다.');
        const result = await concatToMP4(clip.parts.map(part => ({ path: part.path, duration: (part.end - part.start) / 1000 })),
          path.join(folder, `People-Count-${clip.name}.mp4`));
        saved++;
        lastPath = result.path;
        status('saved', `자동 녹화 ${saved}개 저장 완료`, { path: result.path, bytes: result.bytes });
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
      if (!closing && !failure) status(active ? 'recording' : baseline === undefined ? 'waiting-plc' : 'armed',
        active ? '통행 감지 · 마지막 변화 뒤 10초까지 녹화' : baseline === undefined ? 'PLC 연결을 기다리는 중' : '자동 녹화 켜짐 · 통행 감지 대기');
    });
  }
  function seal() {
    const clip = active;
    active = null;
    if (!clip?.parts.length) return;
    clip.name = `${new Date(clip.parts[0].start).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    // One overflow clip is retained for recovery while onError stops capture.
    // No event is silently dropped when the encoder cannot keep up.
    if (queue.length + (encoding ? 1 : 0) >= MAX_PENDING) fail(new Error('MP4 저장이 녹화 속도를 따라가지 못해 자동 녹화를 중지합니다. 수집한 원본은 보존합니다.'));
    queue.push(clip);
    pump();
  }
  function onPLC(data) {
    if (closing || failure) return;
    if (data?.state !== 'ok' || !Number.isInteger(data.value) || data.value < 0 || data.value > 65535) {
      baseline = undefined;
      status(active ? 'recording' : 'waiting-plc', active ? 'PLC 연결 중단 · 감지한 통행 구간 저장 중' : 'PLC 연결을 기다리는 중');
      return;
    }
    const previous = baseline;
    baseline = data.value;
    if (previous === undefined || previous === baseline) {
      if (!active) status('armed', '자동 녹화 켜짐 · 통행 감지 대기');
      return;
    }
    const time = now();
    if (!active) {
      active = { start: time - PRE_ROLL, deadline: time + POST_ROLL, parts: [] };
      for (const part of segments) if (part.end > active.start && part.start <= time) addPart(active, part);
    } else active.deadline = Math.max(active.deadline, time + POST_ROLL);
    status('recording', '통행 감지 · 마지막 변화 뒤 10초까지 녹화');
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
            const deadline = active.deadline;
            seal();
            active = { start: part.start, deadline, parts: [] };
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
      await cleanup(true);
      if (!preserveWorking) await fs.rm(working, { recursive: true, force: true }).catch(cause => {
        preserveWorking = true;
        lastPath ||= working;
        fail(new Error(`자동 녹화 임시 폴더를 정리하지 못했습니다: ${cause.message}`));
      });
      return { saved, folder, path: lastPath, error: failure };
    })();
    return closeResult;
  }
  status('waiting-plc', 'PLC 연결을 기다리는 중');
  return { segment, onPLC, close };
}

module.exports = { createAutoRecording };
