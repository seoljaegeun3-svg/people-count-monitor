const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWebInput, safeWebURL } = require('./web-url');

test('address bar normalizes web addresses and preserves explicit http', () => {
  for (const [input, expected] of [
    [' example.com ', 'https://example.com/'],
    ['Example.com:8443/path?q=1#part', 'https://example.com:8443/path?q=1#part'],
    ['http://192.168.1.100/home', 'http://192.168.1.100/home'],
    ['192.168.1.100:8080/home', 'https://192.168.1.100:8080/home'],
    ['localhost:8080/test', 'https://localhost:8080/test'],
    ['[::1]:8080/test', 'https://[::1]:8080/test'],
    ['//example.com/path', 'https://example.com/path'],
    ['HTTPS://GOOGLE.COM', 'https://google.com/'],
    ['한글.한국/검색', 'https://xn--bj0bj06e.xn--3e0b707e/%EA%B2%80%EC%83%89'],
  ]) assert.equal(resolveWebInput(input), expected, input);
});

test('address bar searches plain text using Google and encodes query punctuation', () => {
  for (const query of ['검색어', 'cctv camera', 'singleword', 'a & b + c #d', 'example.com comparison', '메일 user@example.com']) {
    const url = new URL(resolveWebInput(` ${query} `));
    assert.equal(url.origin, 'https://www.google.com');
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('q'), query);
  }
});

test('address bar rejects invalid input, non-web schemes and embedded credentials', () => {
  for (const value of [
    '', '   ', null, 'a'.repeat(4097), 'example.com\n/path',
    'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'ftp://example.com',
    'about:blank', 'mailto:user@example.com',
    'https://user:password@example.com', 'http://user@example.com',
    'user:password@example.com', 'user@example.com', '//user:password@example.com',
    'https://', 'example.com:99999', 'localhost:abc', '//not-a-host',
  ]) assert.throws(() => resolveWebInput(value), Error, String(value));
  assert.equal(new URL(resolveWebInput('a'.repeat(4096))).searchParams.get('q').length, 4096);
});

test('popup/navigation validator accepts only absolute http/https URLs without credentials', () => {
  assert.equal(safeWebURL('https://example.com/path'), 'https://example.com/path');
  assert.equal(safeWebURL('http://192.168.1.100'), 'http://192.168.1.100/');
  for (const value of ['example.com', '//example.com', 'javascript:alert(1)', 'file:///tmp/a', 'https://user:pass@example.com']) {
    assert.throws(() => safeWebURL(value), Error, value);
  }
});
