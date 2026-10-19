const { app, BrowserWindow, WebContentsView, ipcMain, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validatePLC, readWord } = require('./plc');
const { resolveWebInput, safeWebURL } = require('./web-url');
const { installRecording } = require('./recording');

app.setName('People Count Monitor');
let window, panels, settings, settingsPath, recordingController;
const browserTabs = [];
let activeTabId = null, lastBounds = {};
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
  if (channel === 'plc') recordingController?.onPLC(data);
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}
function tabsSnapshot() {
  return { tabs: browserTabs.map(({ id, title, url, state, message }) => ({ id, title, url, state, message })), activeId: activeTabId };
}
function emitPage(name, tabId, data) {
  if (tabId) {
    const tab = browserTabs.find(item => item.id === tabId);
    if (!tab) return;
    Object.assign(tab, data);
    if (data.state && !data.message) delete tab.message;
    emit('tabs', tabsSnapshot());
  }
  emit('page', { panel: name, tabId, ...data });
}
function applyLayout() {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  const place = (view, bounds) => {
    if (!view || view.webContents.isDestroyed()) return;
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) {
      view.setVisible(false); view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); return;
    }
    const x = Math.max(0, Math.min(width, Math.round(bounds.x))), y = Math.max(0, Math.min(height, Math.round(bounds.y)));
    view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height))) });
    view.setVisible(true);
  };
  place(panels.camera, lastBounds.camera);
  for (const tab of browserTabs) place(tab.view, tab.id === activeTabId ? lastBounds.youtube : null);
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
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ width: Math.min(1600, workArea.width), height: Math.min(1000, workArea.height), minWidth: 860, minHeight: 500, resizable: true, backgroundColor: '#0b1120', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  recordingController = installRecording(window, { onAutoStart: () => setConnection(true) });
  panels = {};
  const createPanel = (name, tabId = null) => {
    const view = new WebContentsView({ webPreferences: { partition: `persist:${name}`, nodeIntegration: false, contextIsolation: true, sandbox: true } });
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
      emitPage('camera', null, { state: 'unauthorized', message: '카메라 계정으로 로그인하세요.' });
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
        emitPage(name, tabId, { state: 'loading', url });
      }
    });
    view.webContents.on('did-navigate', (_event, url, code) => {
      emitPage(name, tabId, { url });
      if (code >= 200 && code < 400) loadFailed = false;
      if (code >= 400) {
        loadFailed = true;
        emitPage(name, tabId, { state: code === 401 ? 'unauthorized' : 'error', message: code === 401 && name === 'camera' ? '카메라 로그인이 필요합니다. 로그인 / 홈에서 시작하세요.' : `HTTP ${code}` });
      }
    });
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) emitPage(name, tabId, { url });
    });
    view.webContents.on('did-finish-load', () => {
      if (!loadFailed && /^https?:/.test(view.webContents.getURL())) emitPage(name, tabId, { state: 'ready' });
    });
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        loadFailed = true;
        emitPage(name, tabId, { state: 'error', message: `${description} (${code})` });
      }
    });
    if (tabId) view.webContents.on('page-title-updated', (_event, title) => {
      const tab = browserTabs.find(item => item.id === tabId);
      if (tab) { tab.title = title || '새 탭'; emit('tabs', tabsSnapshot()); }
    });
    return view;
  };
  const activateTab = id => {
    const tab = browserTabs.find(item => item.id === id);
    if (!tab) throw new Error('웹 탭을 찾을 수 없습니다.');
    activeTabId = id;
    panels.youtube = tab.view;
    applyLayout();
    emit('tabs', tabsSnapshot());
  };
  const addTab = (load = true) => {
    if (browserTabs.length >= 12) throw new Error('웹 탭은 최대 12개까지 열 수 있습니다.');
    const id = randomUUID();
    const tab = { id, title: '새 탭', url: settings.youtube, state: 'loading', view: createPanel('youtube', id) };
    browserTabs.push(tab);
    activateTab(id);
    if (load) tab.view.webContents.loadURL(tab.url).catch(() => {});
  };
  panels.camera = createPanel('camera');
  addTab(false);
  const trusted = event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('허용되지 않은 요청');
  };
  ipcMain.handle('settings', event => { trusted(event); return { ...settings, warning: settingsWarning }; });
  ipcMain.handle('browser-tabs', (event, action, id) => {
    trusted(event);
    if (action === 'add') addTab();
    else if (action === 'activate') activateTab(id);
    else if (action === 'close') {
      const index = browserTabs.findIndex(tab => tab.id === id);
      if (index < 0) throw new Error('웹 탭을 찾을 수 없습니다.');
      const [tab] = browserTabs.splice(index, 1);
      window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
      if (id === activeTabId) {
        activeTabId = browserTabs[Math.min(index, browserTabs.length - 1)]?.id || null;
        panels.youtube = browserTabs.find(item => item.id === activeTabId)?.view;
      }
      applyLayout();
      emit('tabs', tabsSnapshot());
    } else if (action !== 'list') throw new Error('잘못된 웹 탭 동작입니다.');
    return tabsSnapshot();
  });
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
    if (!panels[name]) throw new Error('먼저 웹 창 추가를 눌러주세요.');
    if (name === 'camera') { cancelCameraAuth(); cameraOrigin = new URL(target).origin; }
    emitPage(name, name === 'youtube' ? activeTabId : null, { state: 'loading' });
    try { await panels[name].webContents.loadURL(target); } catch { /* did-fail-load reports errors. */ }
  });
  ipcMain.handle('action', (event, name, action) => {
    trusted(event);
    if (!['camera', 'youtube'].includes(name)) throw new Error('잘못된 화면');
    if (!panels[name]) throw new Error('먼저 웹 창 추가를 눌러주세요.');
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
    lastBounds = bounds || {};
    applyLayout();
  });
  window.on('closed', () => {
    cancelCameraAuth();
    enabled = false; generation++;
    for (const view of [panels.camera, ...browserTabs.map(tab => tab.view)]) if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  await window.loadFile(path.join(__dirname, 'ui/index.html'));
});
app.on('window-all-closed', () => app.quit());
