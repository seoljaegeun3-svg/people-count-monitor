const net = require('node:net');

let sequence = 0;
function validatePLC(config) {
  if (!config || !net.isIP(config.host)) throw new Error('PLC IP 주소를 확인하세요.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('포트는 1~65535입니다.');
  if (!/^%MW\d{1,6}$/.test(config.word)) throw new Error('주소는 %MW0 형식입니다.');
  if (!Number.isInteger(config.interval) || config.interval < 500 || config.interval > 60000) throw new Error('갱신 주기는 500~60000ms입니다.');
  return { host: config.host, port: config.port, word: config.word, interval: config.interval };
}

function readRequest(word, id) {
  const address = Buffer.from(word, 'ascii');
  const body = Buffer.alloc(10 + address.length);
  body.writeUInt16LE(0x54, 0); // XGT read only; no write command is implemented.
  body.writeUInt16LE(2, 2);
  body.writeUInt16LE(1, 6);
  body.writeUInt16LE(address.length, 8);
  address.copy(body, 10);
  const header = Buffer.alloc(20);
  header.write('LSIS-XGT\0\0', 'ascii');
  header[12] = 0xa0;
  header[13] = 0x33;
  header.writeUInt16LE(id, 14);
  header.writeUInt16LE(body.length, 16);
  header[19] = header.subarray(0, 19).reduce((sum, n) => sum + n, 0) & 255;
  return Buffer.concat([header, body]);
}

function readWord(config) {
  validatePLC(config);
  const id = sequence++ & 65535;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.host, port: config.port });
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const deadline = setTimeout(() => finish(new Error('PLC 응답 시간 초과 (3초)')), 3000);
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new Error('PLC 응답이 중간에 종료되었습니다.')));
    socket.on('connect', () => socket.write(readRequest(config.word, id)));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 20) return;
      const size = data.readUInt16LE(16);
      if (data.subarray(0, 10).toString('ascii') !== 'LSIS-XGT\0\0' || data[13] !== 0x11 || data.readUInt16LE(14) !== id || size < 8 || size > 1024) {
        return finish(new Error('올바른 XGT 응답이 아닙니다.'));
      }
      if (data.length < 20 + size) return;
      const b = data.subarray(20);
      if (b.readUInt16LE(0) !== 0x55 || b.readUInt16LE(2) !== 2 || b.readUInt16LE(4) !== 0) return finish(new Error('XGT 응답 명령/형식 오류'));
      if (b.readUInt16LE(6)) return finish(new Error(`PLC 오류: 0x${b.readUInt16LE(6).toString(16)}`));
      if (size !== 14 || data.length !== 34 || b.readUInt16LE(8) !== 1 || b.readUInt16LE(10) !== 2) return finish(new Error('XGT word 응답 길이 오류'));
      finish(null, b.readUInt16LE(12));
    });
  });
}
module.exports = { validatePLC, readWord, readRequest };
