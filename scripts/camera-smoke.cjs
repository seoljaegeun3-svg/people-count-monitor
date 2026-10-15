// Real Chromium camera authentication and web navigation against local fixtures only.
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'people-count-auth-'));
app.setPath('userData', profile);
const username = 'fixture-user', password = 'fixture-password';
const md5 = value => crypto.createHash('md5').update(value).digest('hex');
const nonce = 'local-fixture-nonce', realm = 'Camera Digest';
let foreignRequests = 0;
const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || '';
  const digest = Object.fromEntries([...auth.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m => [m[1], m[2] || m[3]]));
  const digestOK = digest.username === username && digest.realm === realm && digest.nonce === nonce && digest.uri === req.url && digest.qop === 'auth' && digest.response === md5(`${md5(`${username}:${realm}:${password}`)}:${nonce}:${digest.nc}:${digest.cnonce}:auth:${md5(`GET:${req.url}`)}`);
  const isBasic = req.url.startsWith('/basic');
  const isDigest = req.url.startsWith('/digest');
  if (isBasic && auth !== `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` || isDigest && !digestOK) {
    res.writeHead(401, { 'WWW-Authenticate': isBasic ? 'Basic realm="Camera Basic"' : `Digest realm="${realm}", nonce="${nonce}", algorithm=MD5, qop="auth"` });
    res.end('401 Authorization Required');
    return;
  }
  const code = req.url === '/401' ? 401 : req.url === '/403' ? 403 : 200;
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<h1 id="fixture">${isBasic ? 'basic authenticated' : isDigest ? 'digest authenticated' : `HTTP ${code}`}</h1>`);
});
const foreign = http.createServer((_req, res) => { foreignRequests++; res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Other device"' }); res.end('Other origin'); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function until(check, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* Renderer may be navigating. */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${message}`);
}
const timeout = setTimeout(() => { console.error('Camera authentication smoke test timed out'); app.exit(1); }, 60000);
(async () => {
  await Promise.all([app.whenReady(), listen(server), listen(foreign)]);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = { camera: `${origin}/basic`, youtube: 'https://www.youtube.com/', plc: { host: '127.0.0.1', port: 2004, word: '%MW0', interval: 500 } };
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(config));
  const browserSession = session.fromPartition('persist:youtube');
  const webRequests = [];
  browserSession.protocol.handle('https', request => {
    webRequests.push(request.url);
    return new Response('<h1 id="web-fixture">Mock web page</h1><a id="result" href="https://example.com/result" target="_blank">Search result</a>', { headers: { 'Content-Type': 'text/html' } });
  });
  browserSession.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' }));
  session.fromPartition('persist:camera').webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' }));
  require('../main.js');
  await until(() => BrowserWindow.getAllWindows().length > 0, 'main window');
  const win = BrowserWindow.getAllWindows()[0];
  const ui = script => win.webContents.executeJavaScript(script);
  const dialogOpen = () => ui("document.getElementById('camera-auth-dialog')?.open === true");
  await until(dialogOpen, 'Basic auth dialog');
  assert(win.contentView.children.every(v => !v.getVisible()), 'web panels must not cover the login dialog');
  await ui("document.getElementById('camera-auth-cancel').click()");
  await until(() => ui("document.getElementById('camera-status').textContent === '로그인 필요'"), 'cancel keeps 401 status');
  assert.equal(await dialogOpen(), false);
  console.log('PASS: authentication cancellation and 401 status');

  const navigate = url => ui(`void window.monitor.navigate('camera', ${JSON.stringify(url)}); true;`);
  const submit = secret => ui(`document.getElementById('camera-auth-username').value = ${JSON.stringify(username)}; document.getElementById('camera-auth-password').value = ${JSON.stringify(secret)}; document.getElementById('camera-auth-form').requestSubmit(); true;`);
  await navigate(`${origin}/basic?retry`);
  await until(dialogOpen, 'retry dialog');
  await submit('wrong-fixture-password');
  await until(dialogOpen, 'wrong password prompts again');
  assert.equal(await ui("document.getElementById('camera-auth-password').value"), '');
  await submit(password);
  const camera = win.contentView.children[0].webContents;
  await until(() => camera.executeJavaScript("document.getElementById('fixture')?.textContent === 'basic authenticated'"), 'Basic authentication success');
  await until(() => ui("document.getElementById('camera-status').textContent === '페이지 열림'"), '200 status');
  console.log('PASS: Basic authentication, wrong-password retry, password field cleared');

  await navigate(`${origin}/digest`);
  await until(dialogOpen, 'Digest auth dialog');
  await submit(password);
  await until(() => camera.executeJavaScript("document.getElementById('fixture')?.textContent === 'digest authenticated'"), 'Digest authentication success');
  console.log('PASS: Chromium Digest authentication');

  await camera.loadURL(`http://127.0.0.1:${foreign.address().port}/other`).catch(() => {});
  await until(() => foreignRequests > 0, 'different origin challenge');
  assert.equal(await dialogOpen(), false, 'a different camera origin must not receive a credential prompt');
  await navigate(`${origin}/401`);
  await until(() => ui("document.getElementById('camera-status').textContent === '로그인 필요'"), '401 without challenge');
  await navigate(`${origin}/403`);
  await until(() => ui("document.getElementById('camera-status').textContent === '페이지 연결 실패'"), '403 must not show ready');
  console.log('PASS: different-origin auth rejected, HTTP 401/403 never show ready');

  await ui("document.querySelector('[data-action=home]').click()");
  await until(() => camera.getURL() === `${origin}/`, 'camera home');
  await ui("document.querySelector('[data-action=people-counting]').click()");
  await until(() => camera.getURL().endsWith('#/statistics/setup/PEOPLE_COUNTING'), 'people-counting shortcut');
  assert(!fs.readFileSync(path.join(profile, 'settings.json'), 'utf8').includes(password));
  console.log('PASS: home/counting shortcuts, camera password absent from settings');

  const browser = win.contentView.children[1].webContents;
  const navigateWeb = input => ui(`document.getElementById('youtube-url').value = ${JSON.stringify(input)}; document.getElementById('youtube-form').requestSubmit(); true;`);
  await navigateWeb('오늘 날씨 & CCTV');
  await until(() => new URL(browser.getURL()).hostname === 'www.google.com' && new URL(browser.getURL()).searchParams.get('q') === '오늘 날씨 & CCTV', 'Google search navigation');
  await until(() => browser.executeJavaScript("document.getElementById('web-fixture') !== null"), 'mock Google page loaded');
  await until(() => ui("document.getElementById('youtube-url').value.includes('google.com/search?')"), 'browser address follows navigation');
  await browser.executeJavaScript("document.getElementById('result').click(); true;");
  await until(() => browser.getURL() === 'https://example.com/result', 'target blank search result opens in browser panel');
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'web results must not create extra windows');
  assert.equal(await browser.executeJavaScript("typeof require + '/' + typeof window.monitor"), 'undefined/undefined', 'remote web content has no privileged bridge');
  await ui("document.querySelector('[data-panel=youtube][data-action=back]').click()");
  await until(() => new URL(browser.getURL()).searchParams.get('q') === '오늘 날씨 & CCTV', 'browser back to search');
  await ui("document.querySelector('[data-panel=youtube][data-action=forward]').click()");
  await until(() => browser.getURL() === 'https://example.com/result', 'browser forward to result');
  await navigateWeb('example.org/test');
  await until(() => browser.getURL() === 'https://example.org/test', 'bare website address');
  await ui("document.querySelector('[data-panel=youtube][data-action=google]').click()");
  await until(() => browser.getURL() === 'https://www.google.com/', 'Google shortcut');
  await ui("document.querySelector('[data-panel=youtube][data-action=youtube]').click()");
  await until(() => browser.getURL() === 'https://www.youtube.com/', 'YouTube shortcut');
  await ui(`window.monitor.save({...${JSON.stringify(config)}, youtube: 'https://www.google.com/'}).then(() => true)`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).youtube, 'https://www.google.com/');
  assert(webRequests.some(url => url.includes('google.com/search?')));
  console.log('PASS: Google search, website address, new-window links, back/forward, shortcuts, saved browser start page, sandbox isolation');
})().then(() => {
  clearTimeout(timeout); server.closeAllConnections(); foreign.closeAllConnections(); server.close(); foreign.close(); app.exit(0);
}, error => {
  console.error(error.message); clearTimeout(timeout); server.closeAllConnections(); foreign.closeAllConnections(); server.close(); foreign.close(); app.exit(1);
});
