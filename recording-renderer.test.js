const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

for (const mode of ['normal', 'recorder-error', 'save-cancel', 'disk-error']) {
  test(`recording UI handles ${mode} without losing the final chunk or leaving capture running`, async () => {
    const ids = ['record-start', 'record-stop', 'record-audio', 'record-convert', 'record-status', 'record-file'];
    const nodes = Object.fromEntries(ids.map(id => [id, {
      dataset: {}, events: {}, disabled: id === 'record-file',
      addEventListener(name, handler) { this.events[name] = handler; }
    }]));
    let recorder, stoppedTracks = 0, finished = 0, finishError = '';
    const chunks = [];
    const track = { stop() { stoppedTracks++; }, addEventListener() {} };
    const stream = { getTracks: () => [track], getAudioTracks: () => [], getVideoTracks: () => [track] };
    class MediaRecorder extends EventEmitter {
      static isTypeSupported() { return true; }
      constructor() { super(); recorder = this; this.state = 'inactive'; }
      addEventListener(name, handler) { this.on(name, handler); }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.emit('dataavailable', { data: new Blob(['final']) });
          this.emit('stop');
        });
      }
    }
    const api = {
      recordingPrepare: async () => ({ id: 'test-recording' }),
      recordingStart: async () => mode === 'save-cancel' ? { cancelled: true } : { id: 'test-recording', path: 'C:\\Videos\\clip.mp4' },
      recordingChunk: async (_id, chunk) => {
        await new Promise(setImmediate);
        if (mode === 'disk-error') throw new Error('disk full');
        chunks.push(Buffer.from(chunk).toString());
      },
      recordingFinish: async (_id, error) => {
        finished++; finishError = error;
        return { bytes: chunks.join('').length, path: 'C:\\Videos\\clip.mp4', error };
      },
      onRecordingStop() {}, onRecordingProgress() {}, recordingReveal: async () => {}
    };
    vm.runInNewContext(await fs.readFile(path.join(__dirname, 'ui', 'recording.js'), 'utf8'), {
      window: { monitor: api, MediaRecorder }, MediaRecorder,
      navigator: { mediaDevices: { getDisplayMedia: async () => stream } },
      document: { getElementById: id => nodes[id] },
      setInterval: () => 1, clearInterval() {}, Blob, Date, toast() {}
    });
    assert.equal(nodes['record-audio'].checked, false);
    await nodes['record-start'].events.click();
    if (mode === 'save-cancel') {
      assert.equal(stoppedTracks, 1);
      assert.equal(finished, 0);
      assert.equal(nodes['record-status'].dataset.state, 'idle');
      assert.equal(nodes['record-start'].disabled, false);
      return;
    }
    assert.equal(nodes['record-status'].dataset.state, 'recording');
    assert.equal(nodes['record-start'].disabled, true);
    assert.equal(nodes['record-convert'].disabled, true);
    assert.equal(nodes['record-stop'].disabled, false);
    recorder.emit('dataavailable', { data: new Blob(['first']) });
    if (mode === 'recorder-error') {
      // Chromium becomes inactive before emitting the final dataavailable + stop.
      recorder.state = 'inactive';
      recorder.emit('error', { error: new Error('encoder failed') });
      recorder.emit('dataavailable', { data: new Blob(['final']) });
      recorder.emit('stop');
    } else nodes['record-stop'].events.click();
    for (let attempts = 0; attempts < 100 && nodes['record-status'].dataset.state !== 'idle'; attempts++) {
      await new Promise(setImmediate);
    }
    assert.equal(nodes['record-status'].dataset.state, 'idle');
    assert.equal(finished, 1);
    assert.equal(stoppedTracks, 1);
    assert.equal(nodes['record-start'].disabled, false);
    assert.equal(nodes['record-convert'].disabled, false);
    assert.equal(nodes['record-stop'].disabled, true);
    if (mode === 'disk-error') {
      assert.match(finishError, /disk full/);
      assert.equal(chunks.length, 0);
    } else {
      assert.equal(chunks.join(''), 'firstfinal');
      assert.equal(nodes['record-file'].disabled, false);
      assert.equal(nodes['record-file'].hidden, false);
      if (mode === 'recorder-error') assert.match(finishError, /encoder failed/);
      else assert.equal(finishError, '');
    }
  });
}

for (const mode of ['success', 'cancel', 'failure']) {
  test(`existing WebM conversion UI handles ${mode} and restores controls`, async () => {
    const ids = ['record-start', 'record-stop', 'record-audio', 'record-convert', 'record-status', 'record-file'];
    const nodes = Object.fromEntries(ids.map(id => [id, {
      dataset: {}, events: {}, addEventListener(name, handler) { this.events[name] = handler; }
    }]));
    let progress, resolveConversion;
    const pending = new Promise(resolve => { resolveConversion = resolve; });
    const api = {
      onRecordingStop() {}, onRecordingProgress(handler) { progress = handler; },
      recordingConvert: async () => {
        await pending;
        if (mode === 'failure') throw new Error('disk full');
        return mode === 'cancel' ? { cancelled: true } : { path: 'C:\\Videos\\old.mp4', bytes: 1000, error: '' };
      }
    };
    vm.runInNewContext(await fs.readFile(path.join(__dirname, 'ui', 'recording.js'), 'utf8'), {
      window: { monitor: api }, navigator: {},
      document: { getElementById: id => nodes[id] },
      setInterval, clearInterval, Date, toast() {}
    });
    const conversion = nodes['record-convert'].events.click();
    assert.equal(nodes['record-start'].disabled, true);
    assert.equal(nodes['record-convert'].disabled, true);
    assert.equal(nodes['record-stop'].disabled, true);
    progress({ message: 'MP4 변환 중…' });
    assert.match(nodes['record-status'].textContent, /MP4 변환 중/);
    resolveConversion();
    await conversion;
    assert.equal(nodes['record-status'].dataset.state, 'idle');
    assert.equal(nodes['record-start'].disabled, false);
    assert.equal(nodes['record-convert'].disabled, false);
    assert.match(nodes['record-status'].textContent, mode === 'success' ? /저장 완료: old.mp4/ : mode === 'cancel' ? /취소/ : /disk full/);
    if (mode === 'success') assert.equal(nodes['record-file'].disabled, false);
  });
}
