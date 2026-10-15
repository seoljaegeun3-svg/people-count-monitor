const { isIP } = require('node:net');

function cleanInput(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('주소 또는 검색어를 입력하세요.');
  const value = input.trim();
  if (value.length > 4096) throw new Error('주소 또는 검색어는 4096자 이하로 입력하세요.');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('주소 또는 검색어에 사용할 수 없는 문자가 있습니다.');
  return value;
}

function safeWebURL(input) {
  const value = cleanInput(input);
  let url;
  try { url = new URL(value); } catch { throw new Error('올바른 웹 주소를 입력하세요.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('http 또는 https 웹 주소만 열 수 있습니다.');
  if (url.username || url.password) throw new Error('아이디나 비밀번호가 포함된 주소는 사용할 수 없습니다.');
  return url.href;
}

function resolveWebInput(input) {
  const value = cleanInput(input);
  if (/^https?:/i.test(value)) return safeWebURL(value);

  const address = value.replace(/^\/\//, '');
  const authority = address.split(/[/?#]/, 1)[0];
  if (!/\s/.test(value) && authority.includes('@')) {
    throw new Error('아이디나 비밀번호가 포함된 주소는 사용할 수 없습니다.');
  }
  const host = authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.split(':', 1)[0];
  const looksLikeHost = host.toLowerCase() === 'localhost' || isIP(host) || /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+\.?$/u.test(host);
  if (!/\s/.test(value) && looksLikeHost) return safeWebURL(`https://${address}`);
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) {
    throw new Error('http 또는 https 웹 주소만 열 수 있습니다.');
  }
  return `https://www.google.com/search?${new URLSearchParams({ q: value })}`;
}

module.exports = { resolveWebInput, safeWebURL };
