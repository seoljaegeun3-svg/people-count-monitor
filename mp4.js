const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function convertToMP4(source, destination, onProgress = () => {}) {
  if (path.resolve(source) === path.resolve(destination)) throw new Error('원본과 다른 MP4 파일 이름을 지정하세요.');
  if (path.extname(destination).toLowerCase() !== '.mp4') throw new Error('MP4 파일의 확장자를 .mp4로 지정하세요.');
  try {
    await fs.access(destination);
    throw new Error('같은 이름의 파일이 있습니다. 다른 파일 이름으로 저장하세요.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const installed = require('ffmpeg-static');
  if (!installed) throw new Error('이 PC에서 MP4 변환 프로그램을 사용할 수 없습니다.');
  const executable = installed.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const directory = await fs.mkdtemp(path.join(path.dirname(destination), '.people-count-mp4-'));
  const temporary = path.join(directory, 'recording.mp4');
  try {
    onProgress({ state: 'converting', message: 'MP4 변환 중… 원본 녹화는 안전하게 보관하고 있습니다.' });
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:2',
        '-protocol_whitelist', 'file,pipe', '-f', 'matroska', '-threads', '2', '-i', source,
        '-map', '0:v:0', '-map', '0:a?',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:v', 'libx264', '-threads:v', '2', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '60',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-n', temporary
      ], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
      let pending = '', diagnostic = '';
      child.stderr.on('data', data => {
        pending = (pending + data.toString()).slice(-8192);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          const time = /^out_time=(\d{2}:\d{2}:\d{2})/.exec(line);
          if (time) onProgress({ state: 'converting', message: `MP4 변환 중… ${time[1]}` });
          else if (line && !/^[a-z_]+=/.test(line)) diagnostic = (diagnostic + line + '\n').slice(-2000);
        }
      });
      child.once('error', error => reject(new Error(`MP4 변환 프로그램을 실행하지 못했습니다: ${error.message}`)));
      child.once('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`MP4 변환에 실패했습니다${diagnostic || pending ? `: ${(diagnostic || pending).trim()}` : ` (종료 코드 ${code})`}`));
      });
    });
    const { size } = await fs.stat(temporary);
    if (size === 0) throw new Error('변환된 MP4 파일이 비어 있습니다.');
    // Copy the completed conversion with exclusive filename creation. This does
    // not expose an atomic rename: the caller awaits copy+sync before reporting
    // success, and preserves the original if either step fails.
    try { await fs.copyFile(temporary, destination, constants.COPYFILE_EXCL); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('같은 이름의 파일이 생겨 MP4를 저장하지 못했습니다. 다른 이름으로 다시 변환하세요.');
      throw error;
    }
    const published = await fs.open(destination, 'r+');
    try { await published.sync(); } finally { await published.close(); }
    return { path: destination, bytes: size, error: '' };
  } finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

module.exports = { convertToMP4 };
