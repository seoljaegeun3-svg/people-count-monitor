const $ = id => document.getElementById(id);
let settings, connected = false, toastTimer;
const dialog = $('settings-dialog');
const authDialog = $('camera-auth-dialog');
let authRequest;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
function layout() {
  const bounds = {};
  if (!dialog.open && !authDialog.open) for (const name of ['camera', 'youtube']) {
    const b = $(`${name}-space`).getBoundingClientRect();
    bounds[name] = { x: b.x + 1, y: b.y + 1, width: b.width - 2, height: b.height - 2 };
  }
  window.monitor.layout(bounds);
}
function updateSettings() {
  $('camera-url').value = settings.camera;
  $('youtube-url').value = settings.youtube;
  $('plc-word').textContent = settings.plc.word;
  $('plc-endpoint').textContent = `LS XGT · ${settings.plc.host}:${settings.plc.port}`;
}
function navigate(name) {
  window.monitor.navigate(name, $(`${name}-url`).value).catch(error => toast(error.message));
}
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
    navigate('camera'); navigate('youtube');
    toast('설정을 저장했습니다. PLC 연결 버튼으로 읽기를 시작하세요.');
  } catch (error) { $('settings-error').textContent = error.message; }
});
$('plc-connect').addEventListener('click', async () => {
  try {
    await window.monitor.connect(!connected);
    connected = !connected;
    $('plc-connect').textContent = connected ? '연결 중지' : 'PLC 연결';
  } catch (error) { toast(error.message); }
});
window.monitor.onPLC(data => {
  const ok = data.state === 'ok';
  $('plc-value').textContent = ok ? String(data.value) : '—';
  $('plc-status').className = `status ${ok ? 'ok' : data.state === 'error' ? 'error' : ''}`;
  $('plc-status').textContent = { ok: '● 실시간 수신', error: '● 통신 오류', off: '연결 중지', connecting: '연결 중…' }[data.state];
  $('plc-message').textContent = ok ? `${settings.plc.interval}ms 주기 · unsigned 16-bit` : data.message || (data.state === 'connecting' ? 'PLC에서 값을 읽고 있습니다.' : 'PLC 연결 버튼으로 읽기를 시작하세요.');
  $('plc-updated').textContent = ok ? `최근 수신 ${new Date(data.time).toLocaleTimeString('ko-KR')}` : '현재 유효한 값 없음';
});
window.monitor.onPage(data => {
  if (data.url && data.panel === 'camera') $('camera-url').value = data.url;
  const label = $(`${data.panel}-status`);
  label.className = `status ${data.state === 'ready' ? 'ok' : ['error', 'unauthorized'].includes(data.state) ? 'error' : ''}`;
  label.textContent = data.state === 'ready' ? '페이지 열림' : data.state === 'loading' ? '불러오는 중…' : data.state === 'unauthorized' ? '로그인 필요' : '페이지 연결 실패';
  label.title = data.message || '페이지 로드 상태입니다. 영상 재생 여부는 화면에서 확인하세요.';
  if (data.state === 'error') toast(`${data.panel === 'camera' ? '카메라' : 'YouTube'}: ${data.message}`);
});
new ResizeObserver(layout).observe(document.querySelector('.workspace'));
window.addEventListener('resize', layout);
const divider = document.querySelector('.divider');
let split = 60;
function resizeSplit(value) {
  split = Math.max(30, Math.min(75, value));
  document.documentElement.style.setProperty('--split', `${split}%`);
  layout();
}
divider.addEventListener('pointerdown', event => { divider.setPointerCapture(event.pointerId); });
divider.addEventListener('pointermove', event => {
  if (!divider.hasPointerCapture(event.pointerId)) return;
  const b = document.querySelector('.workspace').getBoundingClientRect();
  resizeSplit((event.clientX - b.x) / b.width * 100);
});
divider.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeSplit(split + (event.key === 'ArrowLeft' ? -2 : 2)); }
});
function clock() { $('clock').textContent = new Date().toLocaleTimeString('ko-KR', { hour12: false }); }
clock(); setInterval(clock, 1000);
window.monitor.settings().then(value => {
  settings = value; updateSettings(); layout();
  navigate('camera'); navigate('youtube');
  if (value.warning) toast(value.warning);
}).catch(error => toast(error.message));
