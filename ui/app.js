const $ = id => document.getElementById(id);
let settings, connected = false, toastTimer;
let activeBrowserTab = null;
const dialog = $('settings-dialog');
const authDialog = $('camera-auth-dialog');
let authRequest;
let comparisonDialogOpen = false;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
function layout() {
  const bounds = {};
  if (!dialog.open && !authDialog.open && !comparisonDialogOpen) for (const name of ['camera', 'youtube']) {
    if (name === 'youtube' && !activeBrowserTab) continue;
    const b = $(`${name}-space`).getBoundingClientRect();
    bounds[name] = { x: b.x + 1, y: b.y + 1, width: b.width - 2, height: b.height - 2 };
  }
  window.monitor.layout(bounds);
}
document.addEventListener('comparison-dialog', event => {
  comparisonDialogOpen = Boolean(event.detail?.open);
  layout();
});
function updateSettings() {
  $('camera-url').value = settings.camera;
  $('youtube-url').value = settings.youtube;
  $('plc-word').textContent = settings.plc.word;
  $('plc-endpoint').textContent = `LS XGT · ${settings.plc.host}:${settings.plc.port}`;
}
function navigate(name) {
  window.monitor.navigate(name, $(`${name}-url`).value).catch(error => toast(error.message));
}
function showPage(data) {
  if (data.url) $(`${data.panel}-url`).value = data.url;
  if (!data.state) return;
  const label = $(`${data.panel}-status`);
  label.className = `status ${data.state === 'ready' ? 'ok' : ['error', 'unauthorized'].includes(data.state) ? 'error' : ''}`;
  label.textContent = data.state === 'ready' ? '페이지 열림' : data.state === 'loading' ? '불러오는 중…' : data.state === 'unauthorized' ? '로그인 필요' : '페이지 연결 실패';
  label.title = data.message || '페이지 로드 상태입니다. 영상 재생 여부는 화면에서 확인하세요.';
}
function renderTabs(snapshot) {
  const changed = activeBrowserTab !== snapshot.activeId;
  activeBrowserTab = snapshot.activeId;
  const active = snapshot.tabs.find(tab => tab.id === activeBrowserTab);
  try { localStorage.setItem('monitor-browser-hidden', String(!active)); } catch { /* The view still closes without storage. */ }
  document.querySelector('.youtube-panel').hidden = !active;
  document.querySelector('.divider').hidden = !active;
  document.querySelector('.workspace').classList.toggle('one-panel', !active);
  $('browser-tabs').replaceChildren(...snapshot.tabs.map(tab => {
    const item = document.createElement('div');
    item.className = `browser-tab${tab.id === activeBrowserTab ? ' active' : ''}`;
    const select = document.createElement('button');
    select.className = 'tab-select'; select.dataset.tabId = tab.id;
    select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(tab.id === activeBrowserTab));
    select.textContent = tab.title || '새 탭'; select.title = tab.url;
    const close = document.createElement('button');
    close.className = 'tab-close'; close.dataset.closeTab = tab.id; close.textContent = '×';
    close.setAttribute('aria-label', `${tab.title || '웹 탭'} 닫기`);
    item.append(select, close); return item;
  }));
  if (active) showPage({ panel: 'youtube', state: active.state, message: active.message, url: changed ? active.url : undefined });
  layout();
}
async function tabAction(action, id) {
  try { renderTabs(await window.monitor.tabs(action, id)); } catch (error) { toast(error.message); }
}
window.monitor.onTabs(renderTabs);
$('add-browser').addEventListener('click', () => tabAction('add'));
$('add-tab').addEventListener('click', () => tabAction('add'));
$('browser-tabs').addEventListener('click', event => {
  const close = event.target.closest('[data-close-tab]');
  const tab = event.target.closest('[data-tab-id]');
  if (close) tabAction('close', close.dataset.closeTab);
  else if (tab) tabAction('activate', tab.dataset.tabId);
});
for (const name of ['camera', 'youtube']) $(`${name}-form`).addEventListener('submit', event => { event.preventDefault(); navigate(name); });
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
  window.monitor.action(button.dataset.panel, button.dataset.action).catch(error => toast(error.message));
}));
$('open-settings').addEventListener('click', () => {
  $('settings-camera').value = $('camera-url').value;
  $('settings-youtube').value = $('youtube-url').value;
  for (const key of ['host', 'port', 'word', 'interval']) $(`settings-${key}`).value = settings.plc[key];
  $('settings-error').textContent = '';
  dialog.showModal(); layout();
});
function closeSettings() { dialog.close(); layout(); }
$('close-settings').addEventListener('click', closeSettings);
dialog.addEventListener('close', layout);
function closeAuth() {
  $('camera-auth-password').value = '';
  authRequest = null;
  authDialog.close();
  layout();
}
async function cancelAuth() {
  const request = authRequest;
  closeAuth();
  if (request) await window.monitor.authenticate({ id: request.id, cancel: true }).catch(error => toast(error.message));
}
$('camera-auth-cancel').addEventListener('click', cancelAuth);
authDialog.addEventListener('cancel', event => { event.preventDefault(); cancelAuth(); });
authDialog.addEventListener('close', layout);
window.monitor.onAuth(request => {
  authRequest = request;
  if (dialog.open) dialog.close();
  const comparisonDialog = $('comparison-dialog');
  if (comparisonDialog?.open) comparisonDialog.close();
  comparisonDialogOpen = false;
  $('camera-auth-origin').textContent = `${request.origin} · ${request.scheme} · ${request.realm}`;
  $('camera-auth-password').value = '';
  $('camera-auth-error').textContent = '';
  if (!authDialog.open) authDialog.showModal();
  layout();
  ($('camera-auth-username').value ? $('camera-auth-password') : $('camera-auth-username')).focus();
});
window.monitor.onAuthClosed(data => { if (authRequest?.id === data.id) closeAuth(); });
$('camera-auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!authRequest) return;
  const input = { id: authRequest.id, username: $('camera-auth-username').value, password: $('camera-auth-password').value };
  closeAuth();
  try { await window.monitor.authenticate(input); } catch (error) { toast(error.message); }
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const next = { camera: $('settings-camera').value, youtube: $('settings-youtube').value, plc: {
    host: $('settings-host').value.trim(), port: Number($('settings-port').value), word: $('settings-word').value.trim().toUpperCase(), interval: Number($('settings-interval').value)
  } };
  try {
    settings = await window.monitor.save(next);
    connected = false; $('plc-connect').textContent = 'PLC 연결';
    updateSettings(); closeSettings();
    navigate('camera'); if (activeBrowserTab) navigate('youtube');
    toast('설정을 저장했습니다. PLC 연결 버튼으로 읽기를 시작하세요.');
  } catch (error) { $('settings-error').textContent = error.message; }
});
$('plc-connect').addEventListener('click', async () => {
  try {
    const nextConnection = !connected;
    await window.monitor.connect(nextConnection);
    connected = nextConnection;
    $('plc-connect').textContent = connected ? '연결 중지' : 'PLC 연결';
  } catch (error) { toast(error.message); }
});
window.monitor.onPLC(data => {
  const ok = data.state === 'ok';
  connected = data.state !== 'off';
  $('plc-connect').textContent = connected ? '연결 중지' : 'PLC 연결';
  $('plc-value').textContent = ok ? String(data.value) : '—';
  $('plc-status').className = `status ${ok ? 'ok' : data.state === 'error' ? 'error' : ''}`;
  $('plc-status').textContent = { ok: '● 실시간 수신', error: '● 통신 오류', off: '연결 중지', connecting: '연결 중…' }[data.state];
  $('plc-message').textContent = ok ? `${settings.plc.interval}ms 주기 · unsigned 16-bit` : data.message || (data.state === 'connecting' ? 'PLC에서 값을 읽고 있습니다.' : 'PLC 연결 버튼으로 읽기를 시작하세요.');
  $('plc-updated').textContent = ok ? `최근 수신 ${new Date(data.time).toLocaleTimeString('ko-KR')}` : '현재 유효한 값 없음';
});
window.monitor.onPage(data => {
  if (data.panel === 'youtube' && data.tabId && data.tabId !== activeBrowserTab) return;
  showPage(data);
  if (data.state === 'error') toast(`${data.panel === 'camera' ? '카메라' : '브라우저'}: ${data.message}`);
});
new ResizeObserver(layout).observe(document.querySelector('.workspace'));
const divider = document.querySelector('.divider');
const rowDivider = document.querySelector('.row-divider');
let split = 60, plcHeight = 146;
try {
  const saved = JSON.parse(localStorage.getItem('monitor-layout') || '{}');
  if (Number.isFinite(saved.split)) split = Math.max(30, Math.min(75, saved.split));
  if (Number.isFinite(saved.plcHeight)) plcHeight = saved.plcHeight;
} catch { /* Invalid local layout settings use defaults. */ }
function saveLayout() {
  try { localStorage.setItem('monitor-layout', JSON.stringify({ split, plcHeight })); } catch { /* Layout still works without storage. */ }
}
function resizeSplit(value) {
  split = Math.max(30, Math.min(75, value));
  document.documentElement.style.setProperty('--split', `${split}%`);
  divider.setAttribute('aria-valuenow', String(Math.round(split)));
  saveLayout();
  layout();
}
divider.addEventListener('pointerdown', event => { divider.setPointerCapture(event.pointerId); });
divider.addEventListener('pointermove', event => {
  if (!divider.hasPointerCapture(event.pointerId)) return;
  const b = document.querySelector('.workspace').getBoundingClientRect();
  resizeSplit((event.clientX - b.x) / b.width * 100);
});
function resizeRows(value) {
  const maximum = Math.max(100, document.querySelector('main').getBoundingClientRect().height - 262);
  plcHeight = Math.max(100, Math.min(maximum, value));
  document.documentElement.style.setProperty('--plc-height', `${plcHeight}px`);
  rowDivider.setAttribute('aria-valuenow', String(Math.round(plcHeight)));
  saveLayout(); layout();
}
rowDivider.addEventListener('pointerdown', event => rowDivider.setPointerCapture(event.pointerId));
rowDivider.addEventListener('pointermove', event => {
  if (!rowDivider.hasPointerCapture(event.pointerId)) return;
  resizeRows(document.querySelector('main').getBoundingClientRect().bottom - 34 - event.clientY);
});
rowDivider.addEventListener('keydown', event => {
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); resizeRows(plcHeight + (event.key === 'ArrowUp' ? 20 : -20)); }
});
window.addEventListener('resize', () => resizeRows(plcHeight));
resizeSplit(split); resizeRows(plcHeight);
divider.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeSplit(split + (event.key === 'ArrowLeft' ? -2 : 2)); }
});
function clock() { $('clock').textContent = new Date().toLocaleTimeString('ko-KR', { hour12: false }); }
clock(); setInterval(clock, 1000);
window.monitor.settings().then(async value => {
  settings = value; updateSettings(); layout();
  let hidden = false;
  try { hidden = localStorage.getItem('monitor-browser-hidden') === 'true'; } catch { /* Start with a browser by default. */ }
  let snapshot = await window.monitor.tabs('list');
  if (hidden) for (const tab of snapshot.tabs) snapshot = await window.monitor.tabs('close', tab.id);
  renderTabs(snapshot);
  navigate('camera'); if (activeBrowserTab) navigate('youtube');
  if (value.warning) toast(value.warning);
}).catch(error => toast(error.message));
