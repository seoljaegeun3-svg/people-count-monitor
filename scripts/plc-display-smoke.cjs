// Real Electron renderer + IPC + read-only PLC fixture; no external network.
const { app, BrowserWindow, session } = require('electron');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'people-count-plc-display-'));
app.setPath('userData', profile);
let failExtra = false, pending = 0, peak = 0, mw3Value = 1;
const sockets = new Set();
const plc = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  let request = Buffer.alloc(0);
  socket.on('data', chunk => {
    request = Buffer.concat([request, chunk]);
    if (request.length < 20 || request.length < 20 + request.readUInt16LE(16)) return;
    assert.equal(request.readUInt16LE(20), 0x54, 'read only');
    const word = request.subarray(30).toString('ascii');
    peak = Math.max(peak, ++pending);
    const busy = pending > 1;
    setTimeout(() => {
      const response = Buffer.alloc(34);
      request.copy(response, 0, 0, 20);
      response[13] = 0x11;
      response.writeUInt16LE(14, 16);
      response.writeUInt16LE(0x55, 20);
      response.writeUInt16LE(2, 22);
      response.writeUInt16LE(busy || failExtra && word === '%MW3' ? 1 : 0, 26);
      response.writeUInt16LE(1, 28);
      response.writeUInt16LE(2, 30);
      response.writeUInt16LE({ '%MW0': 41, '%MW2': 0, '%MW3': mw3Value }[word], 32);
      pending--;
      socket.end(response);
    }, 25);
  });
});
const camera = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Local camera fixture</h1>'); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out: ' + label);
}
const deadline = setTimeout(() => { console.error('PLC display smoke timed out'); app.exit(1); }, 45000);
(async () => {
  await Promise.all([app.whenReady(), listen(plc), listen(camera)]);
  const origin = 'http://127.0.0.1:' + camera.address().port;
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    camera: origin, youtube: 'https://www.youtube.com/',
    plc: { host: '127.0.0.1', port: plc.address().port, word: '%MW0', interval: 500 }
  }));
  session.fromPartition('persist:youtube').protocol.handle('https', () => new Response('<h1>Local browser fixture</h1>', { headers: { 'Content-Type': 'text/html' } }));
  for (const name of ['camera', 'youtube']) session.fromPartition('persist:' + name).webRequest.onBeforeRequest(
    { urls: ['http://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' }));
  require('../main.js');
  await until(() => BrowserWindow.getAllWindows().length > 0, 'window');
  const win = BrowserWindow.getAllWindows()[0];
  const ui = script => win.webContents.executeJavaScript(script);
  await until(() => ui("document.getElementById('camera-url')?.value.startsWith('http://127.0.0.1:')"), 'settings loaded');
  await ui('window.monitor.connect(true)');
  await until(() => ui("document.getElementById('plc-value').textContent === '41' && document.getElementById('plc-value-mw2').textContent === '0' && document.getElementById('plc-value-mw3').textContent === '작업영역에 사람 감지'"), 'work area detected and numeric MW0/MW2');
  assert.equal(peak, 1, 'PLC requests never overlap');
  assert.match(await ui("document.getElementById('open-settings').textContent"), /1\.3\.3/);
  win.setSize(860, 500);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await ui("['plc-value', 'plc-value-mw2', 'plc-value-mw3'].every(id => { const b = document.getElementById(id).getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight; })"), true, 'all three readings visible at minimum window size');
  assert.equal(await ui("document.querySelector('.work-area-reading').innerText.trim()"), '작업영역에 사람 감지', 'MW3 shows only the message');
  mw3Value = 0;
  await until(() => ui("document.getElementById('plc-value-mw3').textContent === '작업 영역 사람감지 없음'"), 'work area empty');
  assert.equal(await ui("document.querySelector('.work-area-reading').innerText.trim()"), '작업 영역 사람감지 없음');
  assert.equal(await ui("(() => { const e = document.getElementById('plc-value-mw3'), b = e.getBoundingClientRect(); return b.right <= innerWidth && b.bottom <= innerHeight && e.scrollWidth <= e.clientWidth; })()"), true, 'longer no-person message fits compact window');
  mw3Value = 2;
  await until(() => ui("document.getElementById('plc-value-mw3').textContent === '작업영역 상태 확인 필요'"), 'nonbinary value is not an all-clear');
  mw3Value = 1;
  await until(() => ui("document.getElementById('plc-value-mw3').textContent === '작업영역에 사람 감지'"), 'detected status recovers');
  console.log('PASS: MW3=1/0 maps to exact messages, other values stay unknown, and compact window fits');
  failExtra = true;
  await until(() => ui("document.getElementById('plc-value-mw3').textContent === '작업영역 상태 확인 불가' && document.getElementById('plc-value-mw3').title.includes('PLC 오류')"), 'visible per-address error');
  assert.equal(await ui("document.getElementById('plc-value').textContent"), '41');
  assert.equal(await ui("document.getElementById('plc-value-mw2').textContent"), '0');
  console.log('PASS: MW3 read error is visible without losing primary or zero MW2');
  await ui('window.monitor.connect(false)');
  await until(() => ui("['plc-value', 'plc-value-mw2'].every(id => document.getElementById(id).textContent === '—') && document.getElementById('plc-value-mw3').textContent === '작업영역 상태 확인 불가'"), 'stopped values cleared');
  console.log('PASS: stopping clears all stale PLC values');
})().then(() => finish(0), error => { console.error(error.stack); finish(1); });
function finish(code) {
  clearTimeout(deadline);
  for (const socket of sockets) socket.destroy();
  plc.close(); camera.closeAllConnections(); camera.close();
  app.exit(code);
}
