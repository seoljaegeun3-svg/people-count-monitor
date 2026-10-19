const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

function installRecording(window) {
  const { app, desktopCapturer, dialog, ipcMain, shell } = require('electron');
  const contents = window.webContents;
  const session = contents.session;
  const uiURL = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;
  let current, preparing = false, lastResult, lastSaved, closeRequested = false, allowClose = false, closeTimer;

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
    if (!closeRequested || preparing || current || window.isDestroyed()) return;
    clearTimeout(closeTimer);
    allowClose = true;
    setImmediate(() => { if (!window.isDestroyed()) window.close(); });
  }
  async function finish(id, message = '') {
    if (!current && lastResult?.id === id) return lastResult;
    const job = active(id);
    if (job.finishing) return job.finishing;
    clearTimeout(job.captureTimer);
    job.finishing = (async () => {
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
      lastResult = { id: job.id, path: job.path, bytes, error: error || '' };
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
    if (preparing || current || closeRequested) throw new Error('이미 녹화 중이거나 저장 중입니다.');
    if (options?.audio && process.platform !== 'win32') throw new Error('PC 소리 녹음은 Windows에서 사용할 수 있습니다.');
    current = {
      id: randomUUID(), path: '', file: null, bytes: 0, queuedBytes: 0,
      writes: Promise.resolve(), audio: options?.audio === true,
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
    if (preparing || job.file || job.finishing || job.capturePending || closeRequested) throw new Error('녹화를 시작할 수 없습니다. 다시 시도하세요.');
    preparing = true;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const result = await dialog.showSaveDialog(window, {
        title: '프로그램 전체 화면 녹화 저장',
        defaultPath: path.join(app.getPath('videos'), `People-Count-${stamp}.webm`),
        filters: [{ name: 'WebM 동영상', extensions: ['webm'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });
      if (result.canceled || !result.filePath || closeRequested || window.isDestroyed() || current !== job || job.finishing) {
        if (current === job) await finish(job.id);
        return { cancelled: true };
      }
      if (path.extname(result.filePath).toLowerCase() !== '.webm') throw new Error('파일 이름의 확장자를 .webm으로 지정하세요.');
      let file;
      try { file = await fs.open(result.filePath, 'wx'); } catch (cause) {
        if (cause.code === 'EEXIST') throw new Error('같은 이름의 파일이 있습니다. 다른 파일 이름으로 저장하세요.');
        throw cause;
      }
      if (current !== job || job.finishing) { await file.close(); await fs.unlink(result.filePath).catch(() => {}); return { cancelled: true }; }
      job.path = result.filePath;
      job.file = file;
      return { id: job.id, path: job.path };
    } finally { preparing = false; resumeClose(); }
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
  ipcMain.handle('recording:reveal', event => {
    trusted(event);
    if (!lastSaved?.bytes) throw new Error('저장된 녹화 파일이 없습니다.');
    shell.showItemInFolder(lastSaved.path);
  });
  window.on('close', event => {
    if (allowClose || (!current && !preparing)) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    if (!contents.isDestroyed()) contents.send('recording:stop');
    closeTimer = setTimeout(() => {
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
}

module.exports = { installRecording };
