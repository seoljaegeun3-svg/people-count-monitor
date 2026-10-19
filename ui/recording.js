(() => {
  const startButton = document.getElementById('record-start');
  const stopButton = document.getElementById('record-stop');
  const audioInput = document.getElementById('record-audio');
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
    status.dataset.state = state;
    status.textContent = message;
  }
  function notify(message) { if (typeof toast === 'function') toast(message); }
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
        if (result.bytes > 0) {
          const name = result.path.split(/[\\/]/).pop();
          status.title = result.path;
          if (fileButton) { fileButton.hidden = false; fileButton.disabled = false; }
          const message = result.error ? `부분 파일 저장: ${name} · ${result.error}` : `저장 완료: ${name}`;
          update('idle', message);
          notify(result.error ? `녹화가 중단됐습니다. 저장 폴더에서 부분 파일을 확인하세요. ${result.error}` : '녹화를 저장했습니다. 저장 폴더 버튼으로 파일을 확인하세요.');
        } else {
          update('idle', failure || result.error || '녹화가 취소되었습니다.');
          if (failure) notify(failure);
        }
      } catch (error) {
        update('idle', `녹화 저장 오류: ${error.message}`);
        notify(`녹화 저장 오류: ${error.message}. 선택한 폴더의 부분 파일을 확인하세요.`);
      } finally { id = null; recorder = null; stream = null; }
    })();
    return finalizing;
  }
  function stop() {
    stopRequested = true;
    if (state === 'idle' || state === 'stopping') return;
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
  fileButton?.addEventListener('click', () => api.recordingReveal().catch(error => notify(error.message)));
  if (fileButton) fileButton.hidden = true;
  audioInput.checked = false;
  update('idle', '녹화 안 함 · 프로그램 창 전체를 저장');
})();
