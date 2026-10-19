# Bundled video converter

People Count Monitor uses FFmpeg in a separate local process to create seekable H.264/AAC MP4 files. FFmpeg is distributed unmodified through the pinned `ffmpeg-static` 5.3.0 package.

- FFmpeg: Copyright the FFmpeg developers, https://ffmpeg.org/.
- Bundled build license: GNU General Public License version 3. The full binary license and build information are included beside the converter as `ffmpeg.exe.LICENSE` and `ffmpeg.exe.README` on Windows (`ffmpeg.LICENSE` and `ffmpeg.README` on Linux).
- `ffmpeg-static`: GPL-3.0-or-later. Its full license is included at `node_modules/ffmpeg-static/LICENSE`.
- Distribution and build documentation: https://github.com/eugeneware/ffmpeg-static/tree/v5.3.0 and https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1.
- Windows build provider and source/build instructions: https://www.gyan.dev/ffmpeg/builds/. The bundled Windows build identifies FFmpeg revision https://github.com/FFmpeg/FFmpeg/commit/e38092ef93 in its README. Consult the accompanying README for exact build and library versions.

The converter binary and its accompanying notices are unpacked under `resources/app.asar.unpacked/node_modules/ffmpeg-static/` in the application. Other dependency licenses remain with their respective packages in the application archive.
