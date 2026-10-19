const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

async function mainHarness(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'people-count-recording-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const handlers = new Map(), timers = new Map();
  let notifyConversion;
  const conversionStarted = new Promise(resolve => { notifyConversion = resolve; });
  const controls = {
    filePath: path.join(folder, 'recording.mp4'), canceled: false, convertCalls: [],
    sources: [{ id: 'window:88:0', name: 'People Count Monitor' }, { id: 'window:17:0', name: 'own window' }]
  };
  const session = {
    setDisplayMediaRequestHandler(handler) { controls.capture = handler; },
    setPermissionCheckHandler(handler) { controls.permissionCheck = handler; },
    setPermissionRequestHandler(handler) { controls.permissionRequest = handler; }
  };
  const contents = Object.assign(new EventEmitter(), {
    session, mainFrame: { url: pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href },
    isDestroyed: () => false,
    send(channel) { controls.lastMessage = channel; }
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => !!window.destroyed,
    getMediaSourceId: () => 'window:17:0',
    close() {
      const event = { preventDefault() { this.prevented = true; } };
      window.emit('close', event);
      if (!event.prevented) { window.destroyed = true; window.emit('closed'); }
    }
  });
  const electron = {
    app: { getPath: () => folder },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {
      showSaveDialog: async () => ({ canceled: controls.canceled, filePath: controls.filePath }),
      showOpenDialog: async () => ({ canceled: controls.openCanceled === true, filePaths: controls.openPath ? [controls.openPath] : [] })
    },
    desktopCapturer: { getSources: async () => controls.sources },
    shell: {
      showItemInFolder(filePath) { controls.revealed = filePath; },
      async openPath(folder) { controls.revealed = folder; return ''; }
    }
  };
  const module = { exports: {} };
  const conversion = {
    async convertToMP4(source, destination, onProgress) {
      controls.convertCalls.push({ source, destination });
      notifyConversion();
      onProgress({ state: 'converting', message: 'MP4 변환 중…' });
      if (controls.holdConversion) await controls.holdConversion;
      if (controls.convertFailure) throw new Error('fixture conversion failure');
      await fs.copyFile(source, destination, require('node:fs').constants.COPYFILE_EXCL);
      return { path: destination, bytes: (await fs.stat(destination)).size, error: '' };
    }
  };
  const automatic = {
    async createAutoRecording(options) {
      controls.autoOptions = options;
      controls.autoSegments = [];
      controls.autoPLC = [];
      return {
        async segment(buffer, timing) {
          if (controls.autoWriteFailure) throw new Error('fixture auto disk full');
          controls.autoSegments.push({ buffer, timing });
        },
        onPLC(data) { controls.autoPLC.push(data); },
        async close(error) {
          controls.autoCloseError = error;
          if (controls.holdAutoClose) await controls.holdAutoClose;
          return { saved: 0, folder: options.folder, path: options.folder, error: error || '' };
        }
      };
    }
  };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, 'recording.js'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === './mp4' ? conversion : name === './auto-recording' ? automatic : require(name), module, __dirname,
    Buffer, ArrayBuffer, process: { platform: 'win32' }, setImmediate,
    setTimeout(callback, milliseconds) { const timer = {}; timers.set(timer, { callback, milliseconds }); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  });
  const controller = module.exports.installRecording(window, { onAutoStart() { controls.autoStarted = true; } });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const invoke = (name, ...args) => handlers.get(`recording:${name}`)(event, ...args);
  async function capture(frame = contents.mainFrame) {
    let result;
    await controls.capture({ frame, videoRequested: true, audioRequested: true }, value => { result = value; });
    return result;
  }
  async function prepare(options = {}) {
    const job = await invoke('prepare', options);
    await capture();
    return job;
  }
  return { controls, contents, window, handlers, timers, invoke, capture, prepare, conversionStarted, controller, folder };
}

// Real filesystem writes exercise ordering and protection against data loss;
// Electron itself is mocked so these failure checks also run in ordinary Node.
test('recording grants only its trusted UI and own native window, once', async t => {
  const h = await mainHarness(t);
  await assert.rejects(async () => h.handlers.get('recording:prepare')({
    sender: h.contents, senderFrame: { url: h.contents.mainFrame.url }
  }, {}), /허용되지 않은/);
  await assert.rejects(async () => h.handlers.get('recording:prepare')({
    sender: {}, senderFrame: h.contents.mainFrame
  }, {}), /허용되지 않은/);
  const job = await h.invoke('prepare', { audio: true });
  assert.equal(Object.keys(await h.capture({ url: 'https://untrusted.example/' })).length, 0);
  assert.equal(h.controls.permissionCheck(h.contents, 'display-capture', 'file://', {
    isMainFrame: true, requestingUrl: h.contents.mainFrame.url
  }), true);
  assert.equal(h.controls.permissionCheck(h.contents, 'display-capture', 'file://', {
    isMainFrame: false, requestingUrl: h.contents.mainFrame.url
  }), false);
  const grant = await h.capture();
  assert.equal(grant.video.id, 'window:17:0');
  assert.equal(grant.audio, 'loopback');
  assert.equal(Object.keys(await h.capture()).length, 0);
  await h.invoke('finish', job.id);
  assert.equal(Object.keys(await h.capture()).length, 0);
});

test('recording does not fall back to another window with the same title', async t => {
  const h = await mainHarness(t);
  h.controls.sources = [{ id: 'window:88:0', name: 'People Count Monitor' }];
  const job = await h.invoke('prepare', {});
  assert.equal(Object.keys(await h.capture()).length, 0);
  assert.match((await h.invoke('finish', job.id)).error, /녹화 대상으로 찾지 못했습니다/);
});

test('recording serializes chunks, preserves partial files, and never overwrites an existing file', async t => {
  const h = await mainHarness(t);
  const job = await h.prepare();
  await h.invoke('start', { id: job.id });
  await assert.rejects(h.invoke('chunk', job.id, new Uint8Array(8 * 1024 * 1024 + 1)), /저장 속도/);
  await Promise.all(['first', 'second', 'third'].map(value => h.invoke('chunk', job.id, new TextEncoder().encode(value))));
  const result = await h.invoke('finish', job.id, 'encoder interrupted');
  assert.equal(await fs.readFile(result.path, 'utf8'), 'firstsecondthird');
  assert.equal(path.extname(result.path), '.webm');
  assert.equal(result.bytes, 16);
  assert.equal(result.error, 'encoder interrupted');
  assert.equal((await h.invoke('finish', job.id)).bytes, 16);
  await h.invoke('reveal');
  assert.equal(h.controls.revealed, result.path);
  await fs.writeFile(h.controls.filePath, 'existing user file');
  const next = await h.prepare();
  await assert.rejects(h.invoke('start', { id: next.id }), /같은 이름의 파일/);
  await h.invoke('cancel', next.id);
  assert.equal(await fs.readFile(h.controls.filePath, 'utf8'), 'existing user file');
  assert.equal(await fs.readFile(result.path, 'utf8'), 'firstsecondthird');
});

test('recording cancellation removes only its empty file and close waits for the last chunk', async t => {
  const h = await mainHarness(t);
  let job = await h.prepare();
  h.controls.canceled = true;
  assert.equal((await h.invoke('start', { id: job.id })).cancelled, true);
  await assert.rejects(fs.stat(h.controls.filePath), { code: 'ENOENT' });
  h.controls.canceled = false;
  job = await h.prepare();
  await h.invoke('start', { id: job.id });
  await h.invoke('cancel', job.id);
  await assert.rejects(fs.stat(h.controls.filePath), { code: 'ENOENT' });
  job = await h.prepare();
  await h.invoke('start', { id: job.id });
  const write = h.invoke('chunk', job.id, new TextEncoder().encode('last chunk'));
  h.window.close();
  assert.equal(h.window.destroyed, undefined);
  assert.equal(h.controls.lastMessage, 'recording:stop');
  await Promise.all([write, h.invoke('finish', job.id)]);
  await new Promise(setImmediate);
  assert.equal(h.window.destroyed, true);
  assert.equal(await fs.readFile(h.controls.filePath, 'utf8'), 'last chunk');
  assert.equal(h.controls.convertCalls.length, 1);
  await assert.rejects(fs.stat(h.controls.convertCalls[0].source), { code: 'ENOENT' });
});

test('MP4 failure preserves the raw recording and close waits for an active conversion', { timeout: 5000 }, async t => {
  const h = await mainHarness(t);
  const job = await h.prepare();
  await h.invoke('start', { id: job.id });
  await h.invoke('chunk', job.id, new TextEncoder().encode('recover this recording'));
  h.controls.convertFailure = true;
  let release;
  h.controls.holdConversion = new Promise(resolve => { release = resolve; });
  const finishing = h.invoke('finish', job.id);
  await h.conversionStarted;
  assert.equal(h.controls.convertCalls.length, 1);
  h.window.close();
  assert.equal(h.window.destroyed, undefined);
  assert.equal([...h.timers.values()].some(timer => timer.milliseconds === 12_000), false);
  await assert.rejects(async () => h.invoke('prepare', {}), /이미 녹화 중이거나/);
  release();
  const result = await finishing;
  await new Promise(setImmediate);
  assert.equal(h.window.destroyed, true);
  assert.equal(path.extname(result.path), '.webm');
  assert.match(result.error, /fixture conversion failure.*원본 녹화 파일/);
  assert.equal(await fs.readFile(result.path, 'utf8'), 'recover this recording');
  await assert.rejects(fs.stat(h.controls.filePath), { code: 'ENOENT' });
});

test('existing WebM conversion preserves the input and rejects overlapping recording or conversion', { timeout: 5000 }, async t => {
  const h = await mainHarness(t);
  const source = path.join(path.dirname(h.controls.filePath), 'old-recording.webm');
  await fs.writeFile(source, 'old source stays intact');
  h.controls.openPath = source;
  let release;
  h.controls.holdConversion = new Promise(resolve => { release = resolve; });
  const conversion = h.invoke('convert');
  await h.conversionStarted;
  assert.equal(h.controls.convertCalls.length, 1);
  await assert.rejects(async () => h.invoke('prepare', {}), /이미 녹화 중이거나/);
  await assert.rejects(h.invoke('convert'), /녹화·저장·변환/);
  release();
  const result = await conversion;
  assert.equal(result.path, h.controls.filePath);
  assert.equal(result.error, '');
  assert.equal(await fs.readFile(source, 'utf8'), 'old source stays intact');
  assert.equal(await fs.readFile(result.path, 'utf8'), 'old source stays intact');
  h.controls.openCanceled = true;
  assert.equal((await h.invoke('convert')).cancelled, true);
});

test('automatic recording accepts only trusted bounded segments and forwards actual PLC readings', async t => {
  const h = await mainHarness(t);
  h.controls.openPath = h.folder;
  const job = await h.prepare({ automatic: true });
  await assert.rejects(h.invoke('start', { id: job.id }), /녹화를 시작할 수 없습니다/);
  const started = await h.invoke('auto-start', { id: job.id });
  assert.equal(started.folder, h.folder);
  assert.equal(h.controls.autoStarted, true);
  h.controller.onPLC({ state: 'ok', value: 7 });
  assert.equal(h.controls.autoPLC[0].value, 7);
  const timing = { start: Date.now() - 2000, end: Date.now() };
  await h.invoke('auto-segment', job.id, new TextEncoder().encode('complete WebM segment'), timing);
  assert.equal(h.controls.autoSegments.length, 1);
  assert.equal(h.controls.autoSegments[0].buffer.toString(), 'complete WebM segment');
  await assert.rejects(h.invoke('auto-segment', job.id, new Uint8Array(8 * 1024 * 1024 + 1), timing), /저장 속도/);
  await assert.rejects(h.invoke('auto-segment', job.id, new Uint8Array(2), { start: 0, end: 16000 }), /녹화 시간/);
  await assert.rejects(async () => h.handlers.get('recording:auto-segment')({ sender: {}, senderFrame: h.contents.mainFrame }, job.id, new Uint8Array(2), timing), /허용되지 않은/);
  await assert.rejects(h.invoke('convert'), /녹화·저장·변환/);
  await h.invoke('reveal');
  assert.equal(h.controls.revealed, h.folder);
  await h.invoke('finish', job.id);
  h.controller.onPLC({ state: 'ok', value: 8 });
  assert.equal(h.controls.autoPLC.length, 1, 'stop disconnects the automatic PLC consumer');
});

test('automatic cancellation and write failure release capture, while closing waits for saved clips', async t => {
  const h = await mainHarness(t);
  h.controls.openCanceled = true;
  let job = await h.prepare({ automatic: true });
  assert.equal((await h.invoke('auto-start', { id: job.id })).cancelled, true);
  h.controls.openCanceled = false;
  h.controls.openPath = h.folder;
  job = await h.prepare({ automatic: true });
  await h.invoke('auto-start', { id: job.id });
  h.controls.autoWriteFailure = true;
  await assert.rejects(h.invoke('auto-segment', job.id, new Uint8Array(2), { start: 0, end: 2000 }), /auto disk full/);
  assert.equal(h.controls.lastMessage, 'recording:stop');
  let release;
  h.controls.holdAutoClose = new Promise(resolve => { release = resolve; });
  const finishing = h.invoke('finish', job.id);
  h.window.close();
  assert.equal(h.window.destroyed, undefined);
  assert.equal([...h.timers.values()].some(timer => timer.milliseconds === 12_000), false, 'automatic conversion is not force-closed after twelve seconds');
  release();
  const result = await finishing;
  await new Promise(setImmediate);
  assert.equal(h.window.destroyed, true);
  assert.match(result.error, /auto disk full/);
});
