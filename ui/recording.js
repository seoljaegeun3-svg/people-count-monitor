(() => {
  const startButton = document.getElementById('record-start');
  const stopButton = document.getElementById('record-stop');
  const audioInput = document.getElementById('record-audio');
  const convertButton = document.getElementById('record-convert');
  const status = document.getElementById('record-status');
  const fileButton = document.getElementById('record-file');
  const api = window.monitor;
  let state = 'idle', id, recorder, stream, startedAt, clock;
  let writes = Promise.resolve(), pendingBytes = 0, failure = '', writeFailed = false, stopRequested = false, finalizing;

  function update(next, message) {
    state = next;
    startButton.disabled = state !== 'idle';
    stopButton.disabled = !['starting', 'recording'].includes(state);
    audioInput.disabled = state !== 'idle';
    convertButton.disabled = state !== 'idle';
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
  function elapsed() {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const duration = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
    status.textContent = `● 녹화 중 ${duration}`;
  }
  async function finish() {
    if (finalizing) return finalizing;
    clearInterval(clock);
    update('stopping', '녹화 파일 저장 중…');
    finalizing = (async () => {
      await writes;
      for (const track of stream?.getTracks() || []) track.stop();
      try {
        const result = await api.recordingFinish(id, failure);
        showResult(result);
      } catch (error) {
        update('idle', `녹화 저장 오류: ${error.message}`);
        notify(`녹화 저장 오류: ${error.message}. 선택한 폴더의 부분 파일을 확인하세요.`);
      } finally { id = null; recorder = null; stream = null; }
    })();
    return finalizing;
  }
  function stop() {
    stopRequested = true;
    if (!['starting', 'recording'].includes(state)) return;
    clearInterval(clock);
    update('stopping', '녹화 파일 저장 중…');
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    // When MediaRecorder reports an error it becomes inactive before its final
    // dataavailable/stop events. Wait for stop so the final chunk is not lost.
    else if (!recorder && id && stream) finish();
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

  startButton.addEventListener('click', async () => {
    if (state !== 'idle') return;
    failure = ''; writeFailed = false; stopRequested = false; finalizing = null; writes = Promise.resolve(); pendingBytes = 0;
    status.title = '';
    update('starting', '프로그램 창 녹화 준비 중…');
    try {
      if (!window.MediaRecorder || !navigator.mediaDevices?.getDisplayMedia) throw new Error('이 PC에서 화면 녹화를 사용할 수 없습니다.');
      const prepared = await api.recordingPrepare({ audio: audioInput.checked });
      id = prepared.id;
      if (stopRequested) { await finish(); return; }
      update('starting', '프로그램 창 녹화 준비 중…');
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: audioInput.checked });
      if (stopRequested) { await finish(); return; }
      if (audioInput.checked && !stream.getAudioTracks().length) throw new Error('PC 소리를 가져오지 못했습니다. PC 소리 포함을 해제하고 다시 시도하세요.');
      update('starting', '녹화 저장 위치를 선택하세요…');
      const result = await api.recordingStart({ id });
      if (result.cancelled) {
        for (const track of stream?.getTracks() || []) track.stop();
        stream = null; id = null;
        update('idle', '녹화가 취소되었습니다.'); return;
      }
      if (stopRequested) { await finish(); return; }
      const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('WebM 녹화 형식을 사용할 수 없습니다.');
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
      recorder.addEventListener('dataavailable', event => enqueue(event.data));
      recorder.addEventListener('stop', finish, { once: true });
      recorder.addEventListener('error', event => { failure ||= event.error?.message || '녹화 중 오류가 발생했습니다.'; stop(); });
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', stop, { once: true });
      recorder.start(1000);
      startedAt = Date.now();
      update('recording', '● 녹화 중 00:00:00');
      clock = setInterval(elapsed, 1000);
    } catch (error) {
      failure = `녹화를 시작하지 못했습니다: ${error.message}`;
      if (id) await finish();
      else { update('idle', failure); notify(failure); }
    }
  });
  stopButton.addEventListener('click', stop);
  api.onRecordingStop(stop);
  api.onRecordingProgress(progress => {
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
  update('idle', '녹화 안 함 · MP4로 저장');
})();
