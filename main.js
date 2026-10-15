const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { validatePLC, readWord } = require('./plc');

app.setName('People Count Monitor');
let window, panels, settings, settingsPath;
let enabled = false, generation = 0;
const defaults = {
  camera: 'http://192.168.1.100/home/setup/opensdk/html/WiseAI/index.html#/statistics/setup/PEOPLE_COUNTING',
  youtube: 'https://www.youtube.com/',
  plc: { host: '192.168.1.2', port: 2004, word: '%MW0', interval: 500 }
};
function safeURL(panel, input) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('주소를 확인하세요.');
  const url = new URL(input);
  if (url.username || url.password) throw new Error('주소에 비밀번호를 넣지 마세요. 카메라 화면에서 로그인하세요.');
  if (panel === 'youtube') {
    if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) throw new Error('YouTube 주소를 입력하세요.');
  } else if (panel !== 'camera' || !['http:', 'https:'].includes(url.protocol)) throw new Error('카메라 HTTP/HTTPS 주소를 입력하세요.');
  return url.href;
}
function emit(channel, data) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
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
  } catch (error) {
    if (error.code !== 'ENOENT') settingsWarning = '저장된 설정을 읽지 못해 기본값을 사용합니다. 설정에서 다시 저장하세요.';
  }
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
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event, url) => {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) event.preventDefault();
    });
    let loadFailed = false;
    view.webContents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace && /^https?:/.test(url)) {
        loadFailed = false;
        emit('page', { panel: name, state: 'loading' });
      }
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
  ipcMain.handle('save', async (event, input) => {
    trusted(event);
    const next = { camera: safeURL('camera', input.camera), youtube: safeURL('youtube', input.youtube), plc: validatePLC(input.plc) };
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(`${settingsPath}.tmp`, JSON.stringify(next, null, 2));
    await fs.rename(`${settingsPath}.tmp`, settingsPath);
    settings = next;
    setConnection(false);
    return settings;
  });
  ipcMain.handle('navigate', async (event, name, url) => {
    trusted(event);
    const target = safeURL(name, url);
    emit('page', { panel: name, state: 'loading' });
    try { await panels[name].webContents.loadURL(target); } catch { /* did-fail-load reports errors. */ }
  });
  ipcMain.handle('action', (event, name, action) => {
    trusted(event);
    if (!['camera', 'youtube'].includes(name)) throw new Error('잘못된 화면');
    const contents = panels[name].webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
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
    enabled = false; generation++;
    for (const view of Object.values(panels)) if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  await window.loadFile(path.join(__dirname, 'ui/index.html'));
});
app.on('window-all-closed', () => app.quit());
