const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validatePLC, readWord } = require('./plc');
const { resolveWebInput, safeWebURL } = require('./web-url');

app.setName('People Count Monitor');
let window, panels, settings, settingsPath;
let enabled = false, generation = 0;
const peopleCountingPath = '/home/setup/opensdk/html/WiseAI/index.html#/statistics/setup/PEOPLE_COUNTING';
const legacyCameraURL = `http://192.168.1.100${peopleCountingPath}`;
let cameraOrigin, cameraAuth;
const defaults = {
  camera: 'http://192.168.1.100/',
  youtube: 'https://www.youtube.com/',
  plc: { host: '192.168.1.2', port: 2004, word: '%MW0', interval: 500 }
};
function safeURL(panel, input) {
  if (panel === 'youtube') return resolveWebInput(input);
  if (typeof input !== 'string' || input.length > 4096) throw new Error('주소를 확인하세요.');
  const url = new URL(input);
  if (url.username || url.password) throw new Error('주소에 비밀번호를 넣지 마세요. 카메라 화면에서 로그인하세요.');
  if (panel !== 'camera' || !['http:', 'https:'].includes(url.protocol)) throw new Error('카메라 HTTP/HTTPS 주소를 입력하세요.');
  return url.href;
}
function emit(channel, data) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}
function cancelCameraAuth() {
  if (!cameraAuth) return;
  const pending = cameraAuth;
  cameraAuth = null;
  for (const callback of pending.callbacks) callback();
  emit('camera-auth-closed', { id: pending.id });
}
async function poll(token) {
  while (enabled && generation === token && !window.isDestroyed()) {
    const start = Date.now();
    try {
      const value = await readWord(settings.plc);
      if (generation === token) emit('plc', { state: 'ok', value, time: Date.now() });
    } catch (error) {
      if (generation === token) emit('plc', { state: 'error', message: error.message });
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, settings.plc.interval - (Date.now() - start))));
  }
}
function setConnection(on) {
  enabled = on === true;
  const token = ++generation;
  emit('plc', { state: enabled ? 'connecting' : 'off' });
  if (enabled) poll(token);
}

app.whenReady().then(async () => {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  settings = structuredClone(defaults);
  let settingsWarning = '';
  try {
    const loaded = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    settings = { camera: safeURL('camera', loaded.camera), youtube: safeURL('youtube', loaded.youtube), plc: validatePLC(loaded.plc) };
    if (settings.camera === legacyCameraURL) settings.camera = defaults.camera;
  } catch (error) {
    if (error.code !== 'ENOENT') settingsWarning = '저장된 설정을 읽지 못해 기본값을 사용합니다. 설정에서 다시 저장하세요.';
  }
  cameraOrigin = new URL(settings.camera).origin;
  window = new BrowserWindow({ width: 1600, height: 1000, minWidth: 1000, minHeight: 720, backgroundColor: '#0b1120', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  panels = {};
  for (const name of ['camera', 'youtube']) {
    const view = new WebContentsView({ webPreferences: { partition: `persist:${name}`, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    panels[name] = view;
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
    window.contentView.addChildView(view);
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (name === 'youtube') {
        try {
          const target = safeWebURL(url);
          setImmediate(() => { if (!view.webContents.isDestroyed()) view.webContents.loadURL(target).catch(() => {}); });
        } catch { /* Only web pages can open in the existing browser panel. */ }
      }
      return { action: 'deny' };
    });
    if (name === 'camera') view.webContents.on('login', (event, details, authInfo, callback) => {
      event.preventDefault();
      const origin = new URL(details.url).origin;
      if (authInfo.isProxy || origin !== cameraOrigin || !['basic', 'digest'].includes(authInfo.scheme.toLowerCase())) { callback(); return; }
      const key = `${origin}/${authInfo.scheme}/${authInfo.realm}`;
      if (cameraAuth) {
        if (cameraAuth.key === key) cameraAuth.callbacks.push(callback); else callback();
        return;
      }
      cameraAuth = { id: randomUUID(), key, callbacks: [callback] };
      emit('page', { panel: 'camera', state: 'unauthorized', message: '카메라 계정으로 로그인하세요.' });
      emit('camera-auth', { id: cameraAuth.id, origin, realm: authInfo.realm, scheme: authInfo.scheme });
    });
    const guardNavigation = (event, url) => {
      try { safeWebURL(url); } catch { event.preventDefault(); }
    };
    view.webContents.on('will-navigate', guardNavigation);
    view.webContents.on('will-redirect', guardNavigation);
    let loadFailed = false;
    view.webContents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace && /^https?:/.test(url)) {
        loadFailed = false;
        emit('page', { panel: name, state: 'loading', url });
      }
    });
    view.webContents.on('did-navigate', (_event, url, code) => {
      emit('page', { panel: name, url });
      if (code >= 200 && code < 400) loadFailed = false;
      if (code >= 400) {
        loadFailed = true;
        emit('page', { panel: name, state: code === 401 ? 'unauthorized' : 'error', message: code === 401 && name === 'camera' ? '카메라 로그인이 필요합니다. 로그인 / 홈에서 시작하세요.' : `HTTP ${code}` });
      }
    });
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) emit('page', { panel: name, url });
    });
    view.webContents.on('did-finish-load', () => {
      if (!loadFailed && /^https?:/.test(view.webContents.getURL())) emit('page', { panel: name, state: 'ready' });
    });
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        loadFailed = true;
        emit('page', { panel: name, state: 'error', message: `${description} (${code})` });
      }
    });
  }
  const trusted = event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('허용되지 않은 요청');
  };
  ipcMain.handle('settings', event => { trusted(event); return { ...settings, warning: settingsWarning }; });
  ipcMain.handle('camera-auth', (event, input) => {
    trusted(event);
    if (!cameraAuth || input?.id !== cameraAuth.id) throw new Error('만료된 로그인 요청입니다. 다시 열어주세요.');
    if (input.cancel === true) { cancelCameraAuth(); return; }
    if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 256 || typeof input.password !== 'string' || input.password.length > 4096) throw new Error('카메라 계정 정보를 확인하세요.');
    const pending = cameraAuth;
    cameraAuth = null;
    for (const callback of pending.callbacks) callback(input.username, input.password);
  });
  ipcMain.handle('save', async (event, input) => {
    trusted(event);
    const next = { camera: safeURL('camera', input.camera), youtube: safeURL('youtube', input.youtube), plc: validatePLC(input.plc) };
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(`${settingsPath}.tmp`, JSON.stringify(next, null, 2));
    await fs.rename(`${settingsPath}.tmp`, settingsPath);
    settings = next;
    cancelCameraAuth();
    cameraOrigin = new URL(settings.camera).origin;
    setConnection(false);
    return settings;
  });
  ipcMain.handle('navigate', async (event, name, url) => {
    trusted(event);
    const target = safeURL(name, url);
    if (name === 'camera') { cancelCameraAuth(); cameraOrigin = new URL(target).origin; }
    emit('page', { panel: name, state: 'loading' });
    try { await panels[name].webContents.loadURL(target); } catch { /* did-fail-load reports errors. */ }
  });
  ipcMain.handle('action', (event, name, action) => {
    trusted(event);
    if (!['camera', 'youtube'].includes(name)) throw new Error('잘못된 화면');
    const contents = panels[name].webContents;
    if (name === 'youtube' && ['google', 'youtube'].includes(action)) {
      contents.loadURL(action === 'google' ? 'https://www.google.com/' : 'https://www.youtube.com/').catch(() => {});
      return;
    }
    if (name === 'camera' && ['home', 'people-counting'].includes(action)) {
      cancelCameraAuth();
      const target = new URL(action === 'home' ? '/' : peopleCountingPath, cameraOrigin).href;
      contents.loadURL(target).catch(() => {});
      return;
    }
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === 'reload') contents.reload();
    if (action === 'zoom-in') contents.setZoomFactor(Math.min(2, contents.getZoomFactor() + .1));
    if (action === 'zoom-out') contents.setZoomFactor(Math.max(.4, contents.getZoomFactor() - .1));
  });
  ipcMain.handle('connect', (event, on) => { trusted(event); setConnection(on); });
  ipcMain.on('layout', (event, bounds) => {
    trusted(event);
    const [width, height] = window.getContentSize();
    for (const name of ['camera', 'youtube']) {
      const b = bounds?.[name];
      if (!b) { panels[name].setVisible(false); continue; }
      if (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(b[key]))) continue;
      const x = Math.max(0, Math.min(width, Math.round(b.x))), y = Math.max(0, Math.min(height, Math.round(b.y)));
      panels[name].setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(b.width))), height: Math.max(0, Math.min(height - y, Math.round(b.height))) });
      panels[name].setVisible(true);
    }
  });
  window.on('closed', () => {
    cancelCameraAuth();
    enabled = false; generation++;
    for (const view of Object.values(panels)) if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  await window.loadFile(path.join(__dirname, 'ui/index.html'));
});
app.on('window-all-closed', () => app.quit());
