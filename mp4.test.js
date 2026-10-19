const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { convertToMP4 } = require('./mp4');
const ffmpeg = require('ffmpeg-static');
const run = promisify(execFile);

async function fixture(t, audio = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'people-count-mp4-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.webm');
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=161x91:rate=12',
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
    '-t', '0.5', '-filter_threads', '1', '-c:v', 'libvpx', '-threads', '1',
    ...(audio ? ['-c:a', 'libopus'] : []), '-n', source
  ], { windowsHide: true });
  return { directory, source, destination: path.join(directory, 'result.mp4') };
}

test('real conversion produces seekable H264/AAC MP4 and preserves the odd-sized WebM input', async t => {
  const { source, destination } = await fixture(t);
  const original = await fs.readFile(source);
  const progress = [];
  const result = await convertToMP4(source, destination, event => progress.push(event));
  const output = await fs.readFile(destination);
  assert.equal(result.path, destination);
  assert.equal(result.bytes, output.length);
  assert.equal(result.error, '');
  assert(output.includes(Buffer.from('avc1')), 'video uses H264');
  assert(output.includes(Buffer.from('mp4a')), 'audio uses AAC');
  assert(output.indexOf('moov') > 0 && output.indexOf('moov') < output.indexOf('mdat'), 'faststart places the seek metadata before video data');
  assert(output.includes(Buffer.from('stss')), 'MP4 contains the keyframe seek table');
  const header = output.indexOf('mvhd');
  assert(header > 0);
  assert.equal(output[header + 4], 0, 'short fixture uses a version zero movie header');
  const duration = output.readUInt32BE(header + 20) / output.readUInt32BE(header + 16);
  assert(duration > 0 && duration < 2, `finite MP4 duration: ${duration}`);
  assert.deepEqual(await fs.readFile(source), original);
  assert(progress.some(event => event.state === 'converting'));
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', destination, '-f', 'null', '-'], { windowsHide: true });
});

test('real conversion also accepts a recording without PC audio', async t => {
  const { source, destination } = await fixture(t, false);
  await convertToMP4(source, destination);
  const output = await fs.readFile(destination);
  assert(output.includes(Buffer.from('avc1')));
  assert(!output.includes(Buffer.from('mp4a')));
});

test('conversion protects an existing MP4 both before conversion and at final publication', async t => {
  const { source, destination } = await fixture(t);
  const original = await fs.readFile(source);
  await fs.writeFile(destination, 'existing user file');
  await assert.rejects(convertToMP4(source, destination), /같은 이름의 파일/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'existing user file');
  await fs.unlink(destination);
  let injected = false;
  await assert.rejects(convertToMP4(source, destination, () => {
    if (!injected) {
      injected = true;
      // Simulate another program claiming the chosen filename after preflight.
      fsSync.writeFileSync(destination, 'created during conversion', { flag: 'wx' });
    }
  }), /같은 이름의 파일이 생겨/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'created during conversion');
  assert.deepEqual(await fs.readFile(source), original);
});

test('failed conversion leaves the source intact and cleans its temporary output', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'people-count-mp4-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'broken.webm'), destination = path.join(directory, 'result.mp4');
  await fs.writeFile(source, 'incomplete original recording');
  await assert.rejects(convertToMP4(source, destination), /MP4 변환에 실패/);
  assert.equal(await fs.readFile(source, 'utf8'), 'incomplete original recording');
  assert.deepEqual(await fs.readdir(directory), ['broken.webm']);
});
