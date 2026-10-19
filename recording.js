const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { convertToMP4 } = require('./mp4');
const { createAutoRecording } = require('./auto-recording');

function installRecording(window, { onAutoStart = () => {} } = {}) {
  const { app, desktopCapturer, dialog, ipcMain, shell } = require('electron');
  const contents = window.webContents;
  const session = contents.session;
  const uiURL = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;
  let current, preparing = false, converting = false, lastResult, lastSaved, closeRequested = false, allowClose = false, closeTimer;

  function trusted(event) {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== uiURL) {
      throw new Error('허용되지 않은 녹화 요청입니다.');
    }
  }
  function active(id) {
    if (!current || current.id !== id) throw new Error('녹화가 종료되었거나 잘못된 요청입니다.');
    return current;
  }
  function resumeClose() {
    if (!closeRequested || preparing || converting || current || window.isDestroyed()) return;
    clearTimeout(closeTimer);
    allowClose = true;
    setImmediate(() => { if (!window.isDestroyed()) window.close(); });
  }
  function progress(value) {
    if (!contents.isDestroyed()) {
      try { contents.send('recording:progress', value); } catch { /* Finish saving if the UI exits. */ }
    }
  }
  function automaticError(job, cause) {
    job.error ||= cause instanceof Error ? cause : new Error(String(cause));
    if (current !== job) return;
    progress({ mode: 'auto', state: 'error', message: job.error.message });
    if (!contents.isDestroyed()) {
      try { contents.send('recording:stop'); } catch { /* The source files remain available after a renderer exit. */ }
    }
  }
  async function unusedDestination(filePath) {
    if (path.extname(filePath).toLowerCase() !== '.mp4') throw new Error('파일 이름의 확장자를 .mp4로 지정하세요.');
    try {
      await fs.access(filePath);
      throw new Error('같은 이름의 파일이 있습니다. 다른 파일 이름으로 저장하세요.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function chooseDestination(defaultPath) {
    return dialog.showSaveDialog(window, {
      title: 'MP4 동영상 저장', defaultPath,
      filters: [{ name: 'MP4 동영상', extensions: ['mp4'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });
  }
  async function finish(id, message = '') {
    if (!current && lastResult?.id === id) return lastResult;
    const job = active(id);
    if (job.finishing) return job.finishing;
    clearTimeout(job.captureTimer);
    job.finishing = (async () => {
      if (job.automatic) {
        clearTimeout(closeTimer);
        let result;
        try {
          const closed = await job.auto?.close(job.error?.message || message);
          const savedPath = closed?.path || job.autoFolder || '';
          const bytes = savedPath ? await fs.stat(savedPath).then(stat => stat.isDirectory() ? 1 : stat.size).catch(() => 0) : 0;
          result = { id: job.id, path: savedPath, bytes, saved: 0, ...closed, error: closed?.error || job.error?.message || message || '' };
        } catch (cause) {
          result = { id: job.id, path: job.autoFolder || '', bytes: 0, saved: 0, error: `자동 녹화 종료 오류: ${cause.message}. 원본 폴더를 확인하세요.` };
        }
        lastResult = result;
        if (result.bytes) lastSaved = result;
        if (current === job) current = null;
        resumeClose();
        return result;
      }
      await job.writes;
      let error = job.error?.message || message;
      if (job.file) {
        try { await job.file.sync(); } catch (cause) { error ||= cause.message; }
        try { await job.file.close(); } catch (cause) { error ||= cause.message; }
      }
      let bytes = job.bytes;
      if (job.path) try { bytes = (await fs.stat(job.path)).size; } catch (cause) { error ||= cause.message; }
      // Only remove the empty file created exclusively for this attempt.
      if (job.path && bytes === 0) await fs.unlink(job.path).catch(() => {});
      let result = { id: job.id, path: job.path, bytes, error: error || '' };
      if (bytes > 0 && !error && job.outputPath) {
        job.converting = true;
        // Encoding a long recording may take longer than the normal close grace
        // period. Keep the app open until the complete MP4 or original is safe.
        clearTimeout(closeTimer);
        try {
          result = { id: job.id, ...await convertToMP4(job.path, job.outputPath, progress) };
          await fs.unlink(job.path).catch(() => {});
        } catch (cause) {
          result.error = `${cause.message} 원본 녹화 파일은 ${job.path} 에 보존했습니다. 저장 폴더에서 WebM을 다시 MP4로 변환할 수 있습니다.`;
        } finally { job.converting = false; }
      }
      lastResult = result;
      if (bytes) lastSaved = lastResult;
      if (current === job) current = null;
      resumeClose();
      return lastResult;
    })();
    return job.finishing;
  }

  // A grant is single-use, short lived, and limited to the app's own native window.
  // Capturing the native window includes the camera/browser WebContentsViews.
  session.setDisplayMediaRequestHandler(async (request, callback) => {
    const job = current;
    const reply = streams => { try { callback(streams); } catch { /* Requesting frame was closed. */ } };
    if (!job || job.finishing || !job.capturePending || request.frame !== contents.mainFrame ||
        request.frame?.url !== uiURL || !request.videoRequested || Date.now() > job.captureDeadline) {
      reply({}); return;
    }
    job.capturePending = false;
    clearTimeout(job.captureTimer);
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      if (current !== job || job.finishing || window.isDestroyed()) { reply({}); return; }
      const source = sources.find(item => item.id === window.getMediaSourceId());
      if (!source) throw new Error('프로그램 창을 녹화 대상으로 찾지 못했습니다. 창을 최소화하지 말고 다시 시도하세요.');
      reply({ video: source, ...(job.audio && request.audioRequested ? { audio: 'loopback' } : {}) });
    } catch (cause) {
      job.error = cause;
      reply({});
    }
  }, { useSystemPicker: false });
  const mediaAllowed = (sender, permission, details) => sender === contents &&
    ['media', 'display-capture'].includes(permission) && !!current && !current.finishing &&
    details.isMainFrame === true && details.requestingUrl === uiURL;
  session.setPermissionCheckHandler((sender, permission, _origin, details) => mediaAllowed(sender, permission, details));
  session.setPermissionRequestHandler((sender, permission, callback, details) => callback(mediaAllowed(sender, permission, details)));

  ipcMain.handle('recording:prepare', (event, options) => {
    trusted(event);
    if (preparing || converting || current || closeRequested) throw new Error('이미 녹화 중이거나 저장·변환 중입니다.');
    if (options?.audio && process.platform !== 'win32') throw new Error('PC 소리 녹음은 Windows에서 사용할 수 있습니다.');
    current = {
      id: randomUUID(), path: '', file: null, bytes: 0, queuedBytes: 0,
      writes: Promise.resolve(), audio: options?.audio === true, automatic: options?.automatic === true,
      capturePending: true, captureDeadline: Date.now() + 60_000
    };
    const job = current;
    job.captureTimer = setTimeout(() => {
      if (current === job && job.capturePending) {
        if (!contents.isDestroyed()) contents.send('recording:stop');
        finish(job.id, '녹화를 시작하지 못했습니다. 다시 시도하세요.').catch(() => {});
      }
    }, 60_000);
    return { id: job.id };
  });
  ipcMain.handle('recording:start', async (event, options) => {
    trusted(event);
    const job = active(options?.id);
    if (job.automatic || preparing || job.file || job.finishing || job.capturePending || closeRequested) throw new Error('녹화를 시작할 수 없습니다. 다시 시도하세요.');
    preparing = true;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const result = await chooseDestination(path.join(app.getPath('videos'), `People-Count-${stamp}.mp4`));
      if (result.canceled || !result.filePath || closeRequested || window.isDestroyed() || current !== job || job.finishing) {
        if (current === job) await finish(job.id);
        return { cancelled: true };
      }
      await unusedDestination(result.filePath);
      const sourcePath = path.join(path.dirname(result.filePath), `${path.basename(result.filePath, path.extname(result.filePath))}-source-${job.id}.webm`);
      let file;
      try { file = await fs.open(sourcePath, 'wx'); } catch (cause) {
        if (cause.code === 'EEXIST') throw new Error('같은 이름의 파일이 있습니다. 다른 파일 이름으로 저장하세요.');
        throw cause;
      }
      if (current !== job || job.finishing) { await file.close(); await fs.unlink(sourcePath).catch(() => {}); return { cancelled: true }; }
      job.path = sourcePath;
      job.outputPath = result.filePath;
      job.file = file;
      return { id: job.id, path: job.outputPath };
    } finally { preparing = false; resumeClose(); }
  });
  ipcMain.handle('recording:auto-start', async (event, options) => {
    trusted(event);
    const job = active(options?.id);
    if (!job.automatic || preparing || job.auto || job.finishing || job.capturePending || closeRequested) throw new Error('자동 녹화를 시작할 수 없습니다.');
    preparing = true;
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: '자동 녹화 MP4 저장 폴더 선택', defaultPath: app.getPath('videos'),
        properties: ['openDirectory', 'createDirectory']
      });
      if (selected.canceled || !selected.filePaths?.[0] || closeRequested || window.isDestroyed() || current !== job || job.finishing) {
        if (current === job) await finish(job.id);
        return { cancelled: true };
      }
      const folder = selected.filePaths[0];
      if (!(await fs.stat(folder)).isDirectory()) throw new Error('자동 녹화 저장 폴더를 선택하세요.');
      const automatic = await createAutoRecording({
        folder,
        onStatus(value) {
          if (current !== job) return;
          if (value.path) lastSaved = { path: value.path, bytes: value.bytes || 1 };
          progress({ mode: 'auto', ...value });
        },
        onError: cause => automaticError(job, cause)
      });
      if (current !== job || job.finishing || closeRequested || window.isDestroyed()) {
        await automatic.close();
        if (current === job) await finish(job.id);
        return { cancelled: true };
      }
      job.auto = automatic;
      job.autoFolder = folder;
      lastSaved = { path: folder, bytes: 1 };
      onAutoStart();
      return { id: job.id, folder, preSeconds: 5, postSeconds: 10 };
    } finally { preparing = false; resumeClose(); }
  });
  ipcMain.handle('recording:auto-segment', async (event, id, buffer, timing) => {
    trusted(event);
    const job = active(id);
    if (!job.automatic || !job.auto || job.finishing || job.error) throw new Error(job.error?.message || '자동 녹화가 준비되지 않았습니다.');
    if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) throw new Error('잘못된 자동 녹화 데이터입니다.');
    const bytes = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || job.queuedBytes + bytes.length > 16 * 1024 * 1024) throw new Error('자동 녹화 저장 속도가 부족합니다.');
    if (!timing || !Number.isFinite(timing.start) || !Number.isFinite(timing.end) || timing.end < timing.start || timing.end - timing.start > 15_000) throw new Error('잘못된 자동 녹화 시간입니다.');
    job.queuedBytes += bytes.length;
    try { await job.auto.segment(bytes, { start: timing.start, end: timing.end }); }
    catch (cause) { automaticError(job, cause); throw cause; }
    finally { job.queuedBytes -= bytes.length; }
  });
  ipcMain.handle('recording:chunk', async (event, id, chunk) => {
    trusted(event);
    const job = active(id);
    if (job.finishing || job.capturePending || !job.file || job.error) throw new Error(job.error?.message || '녹화 데이터를 저장할 수 없습니다.');
    if (!(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) throw new Error('잘못된 녹화 데이터입니다.');
    const buffer = chunk instanceof ArrayBuffer ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (!buffer.length || buffer.length > 8 * 1024 * 1024 || job.queuedBytes + buffer.length > 16 * 1024 * 1024) {
      throw new Error('녹화 저장 속도가 부족합니다. 다른 저장 위치를 사용하세요.');
    }
    job.queuedBytes += buffer.length;
    const operation = job.writes.then(async () => {
      if (job.error) throw job.error;
      await job.file.writeFile(buffer);
      job.bytes += buffer.length;
    });
    job.writes = operation.catch(cause => { job.error ||= cause; });
    try { await operation; } finally { job.queuedBytes -= buffer.length; }
  });
  ipcMain.handle('recording:finish', (event, id, message) => {
    trusted(event);
    return finish(id, typeof message === 'string' ? message.slice(0, 1000) : '');
  });
  ipcMain.handle('recording:cancel', (event, id) => { trusted(event); return finish(id, '녹화를 취소했습니다.'); });
  ipcMain.handle('recording:convert', async event => {
    trusted(event);
    if (preparing || converting || current || closeRequested) throw new Error('녹화·저장·변환이 끝난 뒤 다시 시도하세요.');
    converting = true;
    let source = '';
    try {
      const opened = await dialog.showOpenDialog(window, {
        title: 'MP4로 변환할 기존 WebM 녹화 선택',
        filters: [{ name: 'WebM 동영상', extensions: ['webm'] }], properties: ['openFile']
      });
      if (opened.canceled || !opened.filePaths?.[0] || closeRequested) return { cancelled: true };
      source = opened.filePaths[0];
      if (path.extname(source).toLowerCase() !== '.webm') throw new Error('변환할 WebM 동영상을 선택하세요.');
      const selected = await chooseDestination(path.join(path.dirname(source), `${path.basename(source, path.extname(source))}.mp4`));
      if (selected.canceled || !selected.filePath || closeRequested) return { cancelled: true };
      await unusedDestination(selected.filePath);
      const result = await convertToMP4(source, selected.filePath, progress);
      lastSaved = result;
      return result;
    } catch (cause) {
      const bytes = source ? await fs.stat(source).then(value => value.size).catch(() => 0) : 0;
      const result = { path: source, bytes, error: `${cause.message}${source ? ' 기존 WebM 원본은 변경하지 않았습니다.' : ''}` };
      if (bytes) lastSaved = result;
      return result;
    } finally { converting = false; resumeClose(); }
  });
  ipcMain.handle('recording:reveal', async event => {
    trusted(event);
    if (!lastSaved?.bytes) throw new Error('저장된 녹화 파일이 없습니다.');
    if ((await fs.stat(lastSaved.path)).isDirectory()) await shell.openPath(lastSaved.path);
    else shell.showItemInFolder(lastSaved.path);
  });
  window.on('close', event => {
    if (allowClose || (!current && !preparing && !converting)) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    if (!contents.isDestroyed()) contents.send('recording:stop');
    if (converting || current?.converting || (current?.automatic && current.finishing)) return;
    closeTimer = setTimeout(() => {
      if (converting || current?.converting || (current?.automatic && current.finishing)) return;
      // A stalled renderer or storage device must not keep the app open forever.
      // Already written bytes remain on disk even if finalization cannot finish.
      closeTimer = setTimeout(() => {
        allowClose = true;
        if (!window.isDestroyed()) window.close();
      }, 2000);
      preparing = false;
      if (current) finish(current.id, '종료 대기 시간이 지나 녹화를 마쳤습니다. 부분 파일을 확인하세요.').catch(() => {});
      else resumeClose();
    }, 12_000);
  });
  contents.on('render-process-gone', () => {
    if (current) finish(current.id, '화면 프로세스가 종료되었습니다. 부분 녹화 파일을 확인하세요.').catch(() => {});
  });
  window.on('closed', () => {
    clearTimeout(closeTimer);
    if (current) finish(current.id, '프로그램 종료로 녹화를 마쳤습니다.').catch(() => {});
  });
  return {
    onPLC(data) {
      const job = current;
      if (!job?.automatic || !job.auto || job.finishing || job.error) return;
      try { job.auto.onPLC(data); } catch (cause) { automaticError(job, cause); }
    }
  };
}

module.exports = { installRecording };
