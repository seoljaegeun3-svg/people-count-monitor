const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { readWord, validatePLC } = require('./plc');

test('LS XGT read: exact %MW0 packet, fragmented response, malformed responses, disconnect', async t => {
  let mode = 'ok';
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    let request = Buffer.alloc(0);
    socket.on('data', chunk => {
      request = Buffer.concat([request, chunk]);
      if (request.length < 20 || request.length < 20 + request.readUInt16LE(16)) return;
      assert.equal(request.length, 34);
      assert.equal(request.subarray(0, 10).toString('ascii'), 'LSIS-XGT\0\0');
      assert.equal(request[12], 0xa0);
      assert.equal(request[13], 0x33);
      assert.equal(request[19], request.subarray(0, 19).reduce((sum, n) => sum + n, 0) & 255);
      assert.deepEqual([...request.subarray(20)], [0x54, 0, 2, 0, 0, 0, 1, 0, 4, 0, 37, 77, 87, 48]);
      if (mode === 'disconnect') { socket.end(); return; }
      if (mode === 'timeout') return;
      const response = Buffer.alloc(34);
      request.copy(response, 0, 0, 20);
      response[13] = 0x11;
      response.writeUInt16LE(14, 16);
      response.writeUInt16LE(0x55, 20);
      response.writeUInt16LE(2, 22);
      response.writeUInt16LE(1, 28);
      response.writeUInt16LE(2, 30);
      response.writeUInt16LE(mode === 'zero' ? 0 : 65535, 32);
      if (mode === 'id') response[14] ^= 1;
      if (mode === 'error') response.writeUInt16LE(1, 26);
      if (mode === 'write') response.writeUInt16LE(0x59, 20);
      if (mode === 'length') response.writeUInt16LE(2048, 16);
      if (mode === 'blocks') response.writeUInt16LE(2, 28);
      if (mode === 'word-size') response.writeUInt16LE(4, 30);
      socket.write(response.subarray(0, 9));
      setTimeout(() => { if (!socket.destroyed) socket.end(response.subarray(9)); }, 10);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { host: '127.0.0.1', port: server.address().port, word: '%MW0', interval: 500 };
  await t.test('fragmented max unsigned word', async () => assert.equal(await readWord(config), 65535));
  await t.test('zero is a valid count', async () => { mode = 'zero'; assert.equal(await readWord(config), 0); });
  for (const bad of ['id', 'error', 'write', 'length', 'blocks', 'word-size', 'disconnect', 'timeout']) {
    await t.test(`reject ${bad}`, async () => { mode = bad; await assert.rejects(readWord(config)); });
  }
  await t.test('reject invalid settings before network connection', () => {
    for (const override of [{ host: 'bad' }, { port: 0 }, { port: 65536 }, { word: '%MW200=1' }, { interval: 0 }]) {
      assert.throws(() => validatePLC({ ...config, ...override }));
    }
  });
});
