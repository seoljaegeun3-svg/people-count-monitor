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
    shell: { showItemInFolder(filePath) { controls.revealed = filePath; } }
  };
  const module = { exports: {} };
  const conversion = {
    async convertToMP4(source, destination, onProgress) {
      controls.convertCalls.push({ source, destination });
      onProgress({ state: 'converting', message: 'MP4 변환 중…' });
      if (controls.holdConversion) await controls.holdConversion;
      if (controls.convertFailure) throw new Error('fixture conversion failure');
      await fs.copyFile(source, destination, require('node:fs').constants.COPYFILE_EXCL);
      return { path: destination, bytes: (await fs.stat(destination)).size, error: '' };
    }
  };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, 'recording.js'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === './mp4' ? conversion : require(name), module, __dirname,
    Buffer, ArrayBuffer, process: { platform: 'win32' }, setImmediate,
    setTimeout(callback, milliseconds) { const timer = {}; timers.set(timer, { callback, milliseconds }); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  });
  module.exports.installRecording(window);
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
  return { controls, contents, window, handlers, timers, invoke, capture, prepare };
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

test('MP4 failure preserves the raw recording and close waits for an active conversion', async t => {
  const h = await mainHarness(t);
  const job = await h.prepare();
  await h.invoke('start', { id: job.id });
  await h.invoke('chunk', job.id, new TextEncoder().encode('recover this recording'));
  h.controls.convertFailure = true;
  let release;
  h.controls.holdConversion = new Promise(resolve => { release = resolve; });
  const finishing = h.invoke('finish', job.id);
  for (let attempts = 0; attempts < 100 && !h.controls.convertCalls.length; attempts++) await new Promise(setImmediate);
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

test('existing WebM conversion preserves the input and rejects overlapping recording or conversion', async t => {
  const h = await mainHarness(t);
  const source = path.join(path.dirname(h.controls.filePath), 'old-recording.webm');
  await fs.writeFile(source, 'old source stays intact');
  h.controls.openPath = source;
  let release;
  h.controls.holdConversion = new Promise(resolve => { release = resolve; });
  const conversion = h.invoke('convert');
  for (let attempts = 0; attempts < 100 && !h.controls.convertCalls.length; attempts++) await new Promise(setImmediate);
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
