const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const inside = '--inside-packaged-electron';

async function verify(resources) {
  assert.ok(process.versions.electron, 'Run the check with the packaged Electron executable.');
  const appRoot = path.join(resources, 'app.asar');
  const logicalBinary = require(path.join(appRoot, 'node_modules', 'ffmpeg-static'));
  assert.equal(typeof logicalBinary, 'string', 'The packaged FFmpeg dependency must resolve.');
  assert.ok(logicalBinary.includes(`${path.sep}app.asar${path.sep}`), 'Resolve FFmpeg from the packaged app.');
  const binary = logicalBinary.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  await fs.access(binary);
  const version = execFileSync(binary, ['-version'], { encoding: 'utf8', windowsHide: true });
  assert.match(version, /^ffmpeg version /);
  const packageDir = path.dirname(logicalBinary);
  for (const license of [path.join(packageDir, 'LICENSE'), `${logicalBinary}.LICENSE`]) {
    assert.match(await fs.readFile(license, 'utf8'), /GNU GENERAL PUBLIC LICENSE/, `Missing GPL text: ${license}`);
  }
  assert.ok((await fs.readFile(`${logicalBinary}.README`, 'utf8')).trim(), 'Include the binary build/source README.');

  const model = require(path.join(appRoot, 'models', 'manifest.json'));
  const { createPersonDetector } = require(path.join(appRoot, 'person-detector.js'));
  assert.equal(typeof createPersonDetector, 'function', 'Package the real person detector.');
  for (const [filename, text] of [
    ['LICENSE-YOLOX.txt', /Apache License/],
    ['LICENSE-ONNXRUNTIME.txt', /MIT License/],
    ['ONNXRUNTIME-ThirdPartyNotices.txt', /Copyright/]
  ]) {
    assert.match(await fs.readFile(path.join(appRoot, 'models', filename), 'utf8'), text,
      `Include the bundled AI component license: ${filename}`);
  }
  // Creating the real session verifies the packaged model's exact checksum and
  // makes Electron load the unpacked ONNX Runtime native addon and CPU library.
  const detector = await createPersonDetector();
  try {
    const result = await detector.detect({
      data: Buffer.alloc(416 * 416 * 4, 114), width: 416, height: 416, format: 'rgba'
    });
    assert.deepEqual(result.detections, [], 'The packaged CPU detector must reject an empty scene.');
    assert.deepEqual(result.weakDetections, [], 'An empty scene must not produce weak person detections.');
    assert.ok(result.elapsedMs > 0 && Number.isFinite(result.elapsedMs), 'Run actual native inference.');
    console.log(`Packaged person detector check passed: ${JSON.stringify({
      electron: process.versions.electron,
      runtime: require(path.join(appRoot, 'node_modules', 'onnxruntime-node', 'package.json')).version,
      provider: 'cpu', model: model.file, sha256: model.sha256,
      detections: result.detections.length, elapsedMs: Math.round(result.elapsedMs)
    })}`);
  } finally { await detector.close(); }

  const { convertToMP4, concatToMP4 } = require(path.join(appRoot, 'mp4.js'));
  assert.equal(typeof convertToMP4, 'function', 'Package the real MP4 conversion helper.');
  assert.equal(typeof require(path.join(appRoot, 'auto-recording.js')).createAutoRecording, 'function', 'Package the automatic recording controller.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'people-count-packaged-mp4-'));
  try {
    const source = path.join(directory, 'odd-size-with-audio.webm');
    const destination = path.join(directory, 'seekable.mp4');
    execFileSync(binary, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'testsrc=size=321x241:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-t', '1', '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', source
    ], { windowsHide: true, timeout: 60_000 });
    await convertToMP4(source, destination);
    const data = await fs.readFile(destination);
    assert.ok(data.length > 1024, 'Create a nonempty MP4.');
    const atoms = [];
    for (let offset = 0; offset < data.length;) {
      assert.ok(offset + 8 <= data.length, 'MP4 atom header must be complete.');
      let size = data.readUInt32BE(offset);
      const type = data.toString('ascii', offset + 4, offset + 8);
      if (size === 1) {
        assert.ok(offset + 16 <= data.length, 'Extended MP4 atom header must be complete.');
        size = Number(data.readBigUInt64BE(offset + 8));
      } else if (size === 0) size = data.length - offset;
      assert.ok(Number.isSafeInteger(size) && size >= 8 && offset + size <= data.length, 'MP4 atom size must fit the file.');
      atoms.push(type);
      offset += size;
    }
    assert.ok(atoms.includes('ftyp') && atoms.includes('moov') && atoms.includes('mdat'), 'Write MP4 format, index, and video data.');
    assert.ok(atoms.indexOf('moov') < atoms.indexOf('mdat'), 'Place the seek index before video data (+faststart).');
    const decoded = spawnSync(binary, [
      '-hide_banner', '-nostdin', '-i', destination, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(decoded.status, 0, decoded.stderr || decoded.error?.message);
    assert.match(decoded.stderr, /Video: h264/);
    assert.match(decoded.stderr, /Audio: aac/);
    assert.match(decoded.stderr, /322x242/);
    const duration = decoded.stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    assert.ok(duration, 'Store a finite playback duration.');
    const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
    assert.ok(seconds >= 0.9 && seconds < 2, `Unexpected duration: ${seconds}`);
    const seekedFrame = execFileSync(binary, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', '0.75', '-i', destination,
      '-map', '0:v:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
    assert.equal(seekedFrame.length, 322 * 242 * 3, 'Decode a frame after seeking into the MP4.');
    const joined = path.join(directory, 'automatic.mp4');
    await concatToMP4([{ path: source, duration: 1 }, { path: source, duration: 1 }], joined);
    const joinedFrame = execFileSync(binary, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', '1.5', '-i', joined,
      '-map', '0:v:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
    assert.equal(joinedFrame.length, 322 * 242 * 3, 'Seek across independently captured automatic recording segments.');
    assert.ok((await fs.stat(source)).size > 0, 'Keep the source recording available.');
    console.log(`Packaged MP4 check passed: ${version.split(/\r?\n/)[0]}; H.264/AAC, 322x242, ${seconds}s, indexed seeking.`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === inside) {
  verify(path.resolve(process.argv[3])).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const executable = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked', 'People Count Monitor.exe'));
  const resources = path.resolve(process.argv[3] || path.join(path.dirname(executable), 'resources'));
  const result = spawnSync(executable, [__filename, inside, resources], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit', windowsHide: true, timeout: 180_000
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
}
