(() => {
  const startButton = document.getElementById('record-start');
  const stopButton = document.getElementById('record-stop');
  const audioInput = document.getElementById('record-audio');
  const convertButton = document.getElementById('record-convert');
  const autoButton = document.getElementById('record-auto');
  const autoStatus = document.getElementById('record-auto-status');
  const status = document.getElementById('record-status');
  const fileButton = document.getElementById('record-file');
  const api = window.monitor;
  let state = 'idle', mode = 'manual', id, recorder, stream, startedAt, clock, segmentTimer, setupPending = false;
  let writes = Promise.resolve(), pendingBytes = 0, failure = '', writeFailed = false, stopRequested = false, finalizing;
  let autoProgress;

  function update(next, message) {
    state = next;
    startButton.disabled = state !== 'idle';
    stopButton.disabled = !['starting', 'recording'].includes(state);
    audioInput.disabled = state !== 'idle';
    convertButton.disabled = state !== 'idle';
    if (autoButton) {
      autoButton.disabled = !['idle', 'automatic'].includes(state);
      autoButton.setAttribute('aria-pressed', String(state === 'automatic'));
      autoButton.textContent = state === 'automatic' ? '자동 녹화 ON · 끄기' : '자동 녹화 OFF · 켜기';
    }
    status.dataset.state = state;
    status.textContent = message;
  }
  function notify(message) { if (typeof toast === 'function') toast(message); }
  function showResult(result) {
    if (result.bytes > 0) {
      const name = result.path.split(/[\\/]/).pop();
      status.title = result.path;
      if (fileButton) { fileButton.hidden = false; fileButton.disabled = false; }
      update('idle', result.error ? `파일 확인: ${name} · ${result.error}` : `저장 완료: ${name}`);
      notify(result.error ? `오류가 발생했습니다. 저장 폴더에서 보존된 파일을 확인하세요. ${result.error}` : 'MP4 저장을 마쳤습니다. 저장 폴더에서 파일을 확인하세요.');
    } else {
      const message = result.error || failure || '녹화가 취소되었습니다.';
      update('idle', message);
      if (result.error || failure) notify(message);
    }
  }
  function showAutoResult(result) {
    const saved = result.saved || 0;
    if (result.path && fileButton) { fileButton.hidden = false; fileButton.disabled = false; status.title = result.path; }
    const message = result.error || failure;
    if (autoStatus) autoStatus.textContent = message || (saved ? `MP4 ${saved}개 저장 · 자동 녹화 꺼짐` : '감지된 이동 없음 · 자동 녹화 꺼짐');
    update('idle', message ? `자동 녹화 종료: ${message}` : `자동 녹화 종료 · MP4 ${saved}개 저장`);
    if (message) notify(message);
  }
  function elapsed() {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const duration = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
    status.textContent = `● 녹화 중 ${duration}`;
  }
  async function finish() {
    if (finalizing) return finalizing;
    clearInterval(clock);
    clearTimeout(segmentTimer);
    update('stopping', mode === 'auto' ? '자동 녹화 파일 저장 중…' : '녹화 파일 저장 중…');
    finalizing = (async () => {
      await writes;
      for (const track of stream?.getTracks() || []) track.stop();
      try {
        const result = await api.recordingFinish(id, failure);
        if (mode === 'auto') showAutoResult(result);
        else showResult(result);
      } catch (error) {
        update('idle', `녹화 저장 오류: ${error.message}`);
        notify(`녹화 저장 오류: ${error.message}. 선택한 폴더의 부분 파일을 확인하세요.`);
      } finally { id = null; recorder = null; stream = null; mode = 'manual'; }
    })();
    return finalizing;
  }
  function stop() {
    stopRequested = true;
    if (!['starting', 'recording', 'automatic'].includes(state)) return;
    clearInterval(clock);
    clearTimeout(segmentTimer);
    update('stopping', '녹화 파일 저장 중…');
    if (recorder && recorder.state !== 'inactive') {
      if (mode === 'auto') recorder.segmentEnd = Date.now();
      recorder.stop();
    }
    // When MediaRecorder reports an error it becomes inactive before its final
    // dataavailable/stop events. Wait for stop so the final chunk is not lost.
    else if (!recorder && id && !setupPending) finish();
  }
  function enqueue(blob) {
    if (!blob.size || writeFailed) return;
    if (pendingBytes + blob.size > 32 * 1024 * 1024) {
      failure = '디스크 저장 속도가 부족해 녹화를 중지했습니다.';
      writeFailed = true;
      stop(); return;
    }
    pendingBytes += blob.size;
    writes = writes.then(async () => {
      if (writeFailed) return;
      const buffer = await blob.arrayBuffer();
      for (let offset = 0; offset < buffer.byteLength; offset += 1024 * 1024) {
        await api.recordingChunk(id, buffer.slice(offset, offset + 1024 * 1024));
      }
    }).catch(error => {
      failure ||= error.message;
      writeFailed = true;
      stop();
    }).finally(() => { pendingBytes -= blob.size; });
  }

  function enqueueSegment(blob, timing) {
    if (!blob.size || writeFailed) return;
    if (blob.size > 8 * 1024 * 1024 || pendingBytes + blob.size > 16 * 1024 * 1024) {
      failure = '자동 녹화 저장 속도가 부족해 녹화를 중지했습니다.';
      writeFailed = true;
      stop(); return;
    }
    pendingBytes += blob.size;
    writes = writes.then(async () => {
      if (!writeFailed) await api.recordingAutoSegment(id, await blob.arrayBuffer(), timing);
    }).catch(error => {
      failure ||= error.message;
      writeFailed = true;
      stop();
    }).finally(() => { pendingBytes -= blob.size; });
  }
  function createRecorder() {
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('WebM 녹화 형식을 사용할 수 없습니다.');
    return new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
  }
  function startSegment() {
    const next = createRecorder(), chunks = [], start = Date.now();
    let size = 0;
    recorder = next;
    next.addEventListener('dataavailable', event => {
      size += event.data.size;
      if (size <= 8 * 1024 * 1024) chunks.push(event.data);
      else { failure ||= '자동 녹화 구간이 너무 커 녹화를 중지했습니다.'; writeFailed = true; stop(); }
    });
    next.addEventListener('stop', () => {
      clearTimeout(segmentTimer);
      const end = Math.max(start + 1, next.segmentEnd ?? Date.now());
      recorder = null;
      // Every segment gets its own container header and initial keyframe. A
      // timeslice from one long MediaRecorder cannot be decoded on its own.
      if (!stopRequested) {
        try { startSegment(); }
        catch (error) { failure ||= error.message; stopRequested = true; recorder = null; }
      }
      if (size <= 8 * 1024 * 1024) enqueueSegment(new Blob(chunks), { start, end });
      if (stopRequested && !recorder) finish();
    }, { once: true });
    next.addEventListener('error', event => { failure ||= event.error?.message || '자동 녹화 중 오류가 발생했습니다.'; stop(); });
    next.start();
    segmentTimer = setTimeout(() => {
      if (next.state !== 'inactive') { next.segmentEnd = Date.now(); next.stop(); }
    }, 2000);
  }

  async function begin(automatic = false) {
    if (state !== 'idle') return;
    mode = automatic ? 'auto' : 'manual';
    failure = ''; writeFailed = false; stopRequested = false; finalizing = null; writes = Promise.resolve(); pendingBytes = 0;
    id = null; recorder = null; stream = null; setupPending = true;
    autoProgress = null;
    status.title = '';
    update('starting', '프로그램 창 녹화 준비 중…');
    try {
      if (!window.MediaRecorder || !navigator.mediaDevices?.getDisplayMedia) throw new Error('이 PC에서 화면 녹화를 사용할 수 없습니다.');
      const prepared = await api.recordingPrepare({ audio: audioInput.checked, ...(automatic ? { automatic: true } : {}) });
      id = prepared.id;
      if (stopRequested) { await finish(); return; }
      update('starting', '프로그램 창 녹화 준비 중…');
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: audioInput.checked });
      if (stopRequested) { await finish(); return; }
      if (audioInput.checked && !stream.getAudioTracks().length) throw new Error('PC 소리를 가져오지 못했습니다. PC 소리 포함을 해제하고 다시 시도하세요.');
      update('starting', automatic ? '자동 녹화 저장 폴더를 선택하세요…' : '녹화 저장 위치를 선택하세요…');
      const result = automatic ? await api.recordingAutoStart({ id }) : await api.recordingStart({ id });
      if (result.cancelled) {
        for (const track of stream?.getTracks() || []) track.stop();
        stream = null; id = null;
        if (automatic && autoStatus) autoStatus.textContent = 'PLC 값 변화 전 5초 · 후 10초 저장';
        update('idle', '녹화가 취소되었습니다.'); return;
      }
      if (stopRequested) { await finish(); return; }
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', stop, { once: true });
      if (automatic) {
        startSegment();
        status.title = result.folder || '';
        if (result.folder && fileButton) { fileButton.hidden = false; fileButton.disabled = false; }
        if (autoStatus) autoStatus.textContent = autoProgress?.message || `PLC 값 변화 전 ${result.preSeconds ?? 5}초 · 후 ${result.postSeconds ?? 10}초 저장`;
        update('automatic', autoProgress?.message || '자동 녹화 대기 · PLC 값이 바뀌면 MP4 저장');
        if (autoProgress) status.dataset.autoState = autoProgress.state;
        return;
      }
      recorder = createRecorder();
      recorder.addEventListener('dataavailable', event => enqueue(event.data));
      recorder.addEventListener('stop', finish, { once: true });
      recorder.addEventListener('error', event => { failure ||= event.error?.message || '녹화 중 오류가 발생했습니다.'; stop(); });
      recorder.start(1000);
      startedAt = Date.now();
      update('recording', '● 녹화 중 00:00:00');
      clock = setInterval(elapsed, 1000);
    } catch (error) {
      failure = `녹화를 시작하지 못했습니다: ${error.message}`;
      if (id) await finish();
      else { update('idle', failure); notify(failure); }
    } finally { setupPending = false; }
  }
  startButton.addEventListener('click', () => begin());
  autoButton?.addEventListener('click', () => state === 'automatic' ? stop() : begin(true));
  stopButton.addEventListener('click', stop);
  api.onRecordingStop(stop);
  api.onRecordingProgress(progress => {
    if (progress.mode === 'auto' && mode === 'auto') {
      autoProgress = progress;
      if (autoStatus) autoStatus.textContent = progress.message;
      if (progress.path && fileButton) { fileButton.hidden = false; fileButton.disabled = false; status.title = progress.path; }
      if (state === 'automatic') {
        status.textContent = progress.message;
        status.dataset.autoState = progress.state;
      }
      return;
    }
    if (state === 'stopping' || state === 'converting') update(state, progress.message);
  });
  convertButton.addEventListener('click', async () => {
    if (state !== 'idle') return;
    failure = '';
    update('converting', '변환할 기존 WebM 녹화 파일을 선택하세요…');
    try {
      const result = await api.recordingConvert();
      if (result.cancelled) update('idle', 'MP4 변환이 취소되었습니다.');
      else showResult(result);
    } catch (error) {
      update('idle', `MP4 변환 오류: ${error.message}`);
      notify(`MP4 변환 오류: ${error.message}. 기존 원본은 유지됩니다.`);
    }
  });
  fileButton?.addEventListener('click', () => api.recordingReveal().catch(error => notify(error.message)));
  if (fileButton) fileButton.hidden = true;
  audioInput.checked = false;
  if (autoStatus) autoStatus.textContent = 'PLC 값 변화 전 5초 · 후 10초 저장';
  update('idle', '녹화 안 함 · MP4로 저장');
})();
