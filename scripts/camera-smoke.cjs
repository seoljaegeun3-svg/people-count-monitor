// Real Chromium authentication, tabs, and layout against local fixtures only.
const { app, BrowserWindow, session, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'people-count-auth-'));
app.setPath('userData', profile);
const recordingPath = path.join(profile, 'fixture-recording.mp4');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: recordingPath });
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
async function until(check, message, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; /* Renderer may be navigating. */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${message}${lastError ? ` (${lastError.message})` : ''}`);
}
const timeout = setTimeout(() => { console.error('Camera and browser smoke test timed out'); app.exit(1); }, 90000);
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

  const tabs = () => ui("window.monitor.tabs('list')");
  const tabButton = (attribute, id) => ui(`document.querySelector('[${attribute}="${id}"]').click(); true;`);
  const browserViews = () => win.contentView.children.filter(view => view.webContents !== camera);
  const effectiveTabs = async () => {
    const state = await tabs();
    const views = browserViews();
    assert.equal(views.length, state.tabs.length, 'every tab must have exactly one native view');
    assert.equal(win.contentView.children[0].webContents, camera, 'camera view must survive tab changes');
    const visible = views.filter(view => view.getVisible());
    assert.equal(visible.length, state.tabs.length ? 1 : 0, 'only the active browser view is visible');
    if (state.tabs.length) {
      const active = state.tabs.find(tab => tab.id === state.activeId);
      assert(active, 'active tab must exist');
      assert.equal(visible[0].webContents.getURL(), active.url, 'visible content belongs to active tab');
      assert.equal(await ui("document.getElementById('youtube-url').value"), active.url, 'address field follows selected tab');
    }
    return state;
  };
  await until(async () => { await effectiveTabs(); return true; }, 'initial browser tab layout');
  const first = await tabs();
  assert.equal(first.tabs.length, 1);
  const firstId = first.activeId;
  const firstURL = browser.getURL();
  await ui("document.getElementById('add-browser').click(); true;");
  await until(async () => (await tabs()).tabs.length === 2, 'new browser tab');
  const second = await tabs();
  const secondId = second.activeId;
  assert.notEqual(secondId, firstId);
  const secondView = browserViews().find(view => view.webContents !== browser);
  const secondContents = secondView.webContents;
  await until(() => secondContents.getURL() === 'https://www.google.com/', 'new tab uses saved start page');
  await navigateWeb('example.net/second-tab');
  await until(() => secondContents.getURL() === 'https://example.net/second-tab', 'navigation goes to active tab');
  assert.equal(browser.getURL(), firstURL, 'navigation must not overwrite inactive tab');
  await until(async () => { await effectiveTabs(); return true; }, 'second tab layout and address');
  await tabButton('data-tab-id', firstId);
  await until(async () => (await tabs()).activeId === firstId && browserViews().filter(view => view.getVisible())[0]?.webContents === browser, 'switch to original tab');
  await until(async () => { await effectiveTabs(); return true; }, 'first tab address restored');
  assert.equal(secondContents.getURL(), 'https://example.net/second-tab', 'switching preserves inactive page');
  await tabButton('data-tab-id', secondId);
  await until(async () => (await tabs()).activeId === secondId, 'switch back to new tab');
  await until(async () => { await effectiveTabs(); return true; }, 'second tab restored');
  assert.equal(await secondContents.executeJavaScript("typeof require + '/' + typeof window.monitor"), 'undefined/undefined', 'new tabs are sandboxed');
  console.log('PASS: add and switch browser tabs, independent navigation, start page, single visible native view, sandbox isolation');

  const bounds = () => ui(`(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
    return { workspace:rect('.workspace'), plc:rect('.plc-panel'), camera:rect('.camera-panel'), browser:rect('.youtube-panel') };
  })()`);
  const press = (selector, key) => ui(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}, bubbles:true})); true;`);
  const nativeBoundsFit = () => {
    const [width, height] = win.getContentSize();
    for (const view of win.contentView.children) {
      const b = view.getBounds();
      assert(b.x >= 0 && b.y >= 0 && b.width >= 0 && b.height >= 0, 'native view bounds must be nonnegative');
      assert(b.x + b.width <= width && b.y + b.height <= height, 'native views must fit within app content');
      if (view.getVisible()) assert(b.width > 0 && b.height > 0, 'empty native views must be hidden');
    }
  };
  const beforeHorizontal = await bounds();
  await press('.divider', 'ArrowRight');
  await until(async () => (await bounds()).camera.width > beforeHorizontal.camera.width + 2, 'horizontal resize grows camera');
  assert((await bounds()).browser.width < beforeHorizontal.browser.width);
  await press('.divider', 'ArrowLeft');
  await until(async () => Math.abs((await bounds()).camera.width - beforeHorizontal.camera.width) < 2, 'horizontal resize returns');
  const beforeVertical = await bounds();
  await press('.row-divider', 'ArrowUp');
  await until(async () => (await bounds()).plc.height > beforeVertical.plc.height + 2, 'vertical resize grows PLC area');
  assert((await bounds()).workspace.height < beforeVertical.workspace.height);
  await press('.row-divider', 'ArrowDown');
  await until(async () => Math.abs((await bounds()).workspace.height - beforeVertical.workspace.height) < 2, 'vertical resize returns');
  assert(win.getMinimumSize()[1] <= 500, 'window supports reducing height to 500 pixels');
  const originalSize = win.getContentSize();
  win.setContentSize(1000, 520);
  await until(async () => (await bounds()).workspace.height < beforeVertical.workspace.height, 'compact window reflows');
  await until(() => { nativeBoundsFit(); return true; }, 'compact native view bounds');
  const compact = await bounds();
  assert(compact.plc.y + compact.plc.height <= win.getContentSize()[1], 'PLC remains within short window');
  for (let i = 0; i < 30; i++) await press('.row-divider', 'ArrowUp');
  await until(() => { nativeBoundsFit(); return true; }, 'clamped vertical layout');
  win.setContentSize(...originalSize);
  for (let i = 0; i < 30; i++) await press('.row-divider', 'ArrowDown');
  await until(() => { nativeBoundsFit(); return true; }, 'restored native view bounds');
  console.log('PASS: horizontal and vertical keyboard resizing, compact window height, clamped native view bounds');

  await tabButton('data-close-tab', secondId);
  await until(async () => (await tabs()).tabs.length === 1 && secondContents.isDestroyed(), 'closing active tab destroys its native content');
  await until(async () => { await effectiveTabs(); return true; }, 'remaining tab becomes active');
  assert.equal((await tabs()).activeId, firstId);
  const beforeClose = await bounds();
  await tabButton('data-close-tab', firstId);
  await until(async () => (await tabs()).tabs.length === 0 && browser.isDestroyed(), 'closing last browser tab');
  await until(() => ui("document.querySelector('.youtube-panel').getBoundingClientRect().width === 0 && document.querySelector('.divider').getBoundingClientRect().width === 0"), 'last browser close hides browser panel and divider');
  assert.equal(win.contentView.children.length, 1, 'closing all tabs leaves only camera native view');
  assert((await bounds()).camera.width > beforeClose.camera.width + 20, 'camera expands when all browser tabs close');
  assert.equal(await ui("document.getElementById('add-browser').getBoundingClientRect().width > 0"), true, 'add browser stays accessible with no tabs');
  await ui("document.getElementById('add-browser').click(); true;");
  await until(async () => (await tabs()).tabs.length === 1, 'reopen browser after all tabs closed');
  await until(async () => { await effectiveTabs(); return true; }, 'reopened browser visible with fresh native content');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  nativeBoundsFit();
  console.log('PASS: close active and last tab, destroy native content, full-width camera, reopen browser without orphan views');

  const recordedBrowser = browserViews().find(view => view.getVisible()).webContents;
  const recordedPages = [camera, recordedBrowser];
  // Keep both native views moving, like a live camera/video. Static desktop
  // capture can omit unchanged tail frames and defer an unfocused view's paint.
  await Promise.all(recordedPages.map(contents => contents.executeJavaScript(`(() => {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
    document.body.replaceChildren(canvas);
    const context = canvas.getContext('2d');
    window.fixtureColor = 'rgb(232,64,64)';
    let frame = 0;
    const render = () => {
      if (canvas.width !== innerWidth || canvas.height !== innerHeight) { canvas.width = innerWidth; canvas.height = innerHeight; }
      context.fillStyle = window.fixtureColor; context.fillRect(0,0,canvas.width,canvas.height);
      context.fillStyle = 'white'; context.font = '24px sans-serif'; context.fillText('Live frame ' + frame++,20,40);
    };
    render(); setInterval(render,33); return true;
  })()`)));
  const paintRecordedPages = async (color, blue) => {
    await Promise.all(recordedPages.map(contents => contents.executeJavaScript(`window.fixtureColor = ${JSON.stringify(color)}; true;`)));
    await until(async () => {
      for (const contents of recordedPages) {
        const image = await contents.capturePage();
        const { width, height } = image.getSize();
        const pixels = image.toBitmap(), offset = (Math.floor(height/2)*width+Math.floor(width/2))*4;
        const red = pixels[offset+2], blueChannel = pixels[offset];
        assert(blue ? blueChannel > red+80 : red > blueChannel+80, 'native fixture compositor must paint the requested color');
      }
      return true;
    }, 'native camera and browser fixture color is painted');
  };
  await paintRecordedPages('rgb(232,64,64)', false);
  const recordButton = await ui("document.getElementById('record-audio').checked = false; (() => { const b = document.getElementById('record-start').getBoundingClientRect(); return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}; })()");
  win.focus();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseDown', ...recordButton, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...recordButton, button: 'left', clickCount: 1 });
  await until(() => ui("document.getElementById('record-status').dataset.state === 'recording'"), 'own-window recording starts').catch(async error => {
    throw new Error(`${error.message}: ${await ui("document.getElementById('record-status').textContent")}`);
  });
  await new Promise(resolve => setTimeout(resolve, 1300));
  await paintRecordedPages('rgb(64,96,232)', true);
  await new Promise(resolve => setTimeout(resolve, 1700));
  await ui("document.getElementById('record-stop').click(); true;");
  await until(() => ui("document.getElementById('record-status').dataset.state === 'idle' && document.getElementById('record-status').textContent.includes('저장 완료')"), 'MP4 recording finalizes', 30000);
  assert(fs.existsSync(recordingPath) && fs.statSync(recordingPath).size > 1024, 'recorded MP4 is written');
  const recording = fs.readFileSync(recordingPath);
  assert.equal(recording.subarray(4, 8).toString('ascii'), 'ftyp', 'recording is an MP4 container');
  assert(recording.includes(Buffer.from('avc1')), 'MP4 contains an H.264 video track');
  const metadataAt = recording.indexOf(Buffer.from('moov')), mediaAt = recording.indexOf(Buffer.from('mdat'));
  assert(metadataAt > 0 && mediaAt > metadataAt, 'MP4 metadata precedes media for fast seeking');
  assert.equal(await ui("document.getElementById('record-stop').disabled"), true);
  const playbackPath = path.join(profile, 'recording-playback.html');
  fs.writeFileSync(playbackPath, '<!doctype html><video src="fixture-recording.mp4" muted preload="auto"></video>');
  const playback = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  try {
    await playback.loadFile(playbackPath);
    await until(() => playback.webContents.executeJavaScript("document.querySelector('video').readyState >= 2 && document.querySelector('video').videoWidth > 0"), 'saved recording decodes in Chromium');
    const dimensions = await playback.webContents.executeJavaScript("({width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,duration:document.querySelector('video').duration})");
    assert(dimensions.width > 0 && dimensions.height > 0);
    assert(Number.isFinite(dimensions.duration) && dimensions.duration > 1, 'MP4 has a finite duration for timeline seeking');
    const seekFrame = fraction => playback.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const video = document.querySelector('video');
        const target = video.duration * ${fraction};
        const timer = setTimeout(() => reject(new Error('MP4 seek timed out at ' + target)), 7000);
        video.onseeked = () => {
          clearTimeout(timer);
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          const context = canvas.getContext('2d');
          context.drawImage(video, 0, 0);
          const sample = x => {
            const data = context.getImageData(Math.round(canvas.width*x)-2, Math.round(canvas.height*.5)-2, 5, 5).data;
            const rgb = [0,0,0];
            for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel++) rgb[channel] += data[i+channel]/25;
            return rgb.map(Math.round);
          };
          resolve({target,time:video.currentTime,ready:video.readyState,camera:sample(.25),browser:sample(.8)});
        };
        video.currentTime = target;
      })`);
    const later = await seekFrame(.75);
    const earlier = await seekFrame(.25);
    for (const [label, frame] of [['forward', later], ['backward', earlier]]) {
      assert(Math.abs(frame.time-frame.target) < .15 && frame.ready >= 2, `${label} timeline seek resolves to a decoded frame`);
      for (const panel of ['camera', 'browser']) {
        const [red, , blue] = frame[panel];
        assert(label === 'forward' ? blue > 150 && blue > red+80 : red > 150 && red > blue+80,
          `${label} seek must show the corresponding ${panel} native view frame, RGB=${frame[panel]}`);
      }
    }
    console.log(`PASS: own-window recording saved as H.264 fast-start MP4 with finite duration and working forward/backward seeks to camera/browser frames (${recording.length} bytes, ${dimensions.width}×${dimensions.height}, ${dimensions.duration.toFixed(2)}s)`);
  } finally { playback.destroy(); }
})().then(() => {
  clearTimeout(timeout); server.closeAllConnections(); foreign.closeAllConnections(); server.close(); foreign.close(); app.exit(0);
}, error => {
  console.error(error.message); clearTimeout(timeout); server.closeAllConnections(); foreign.closeAllConnections(); server.close(); foreign.close(); app.exit(1);
});
