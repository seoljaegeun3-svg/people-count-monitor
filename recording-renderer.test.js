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
      setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, Blob, Date, toast() {}
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
      setInterval, clearInterval, setTimeout, clearTimeout, Date, toast() {}
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

async function autoFixture(options = {}) {
  const ids = ['record-start', 'record-stop', 'record-audio', 'record-convert', 'record-status', 'record-file', 'record-auto', 'record-auto-status'];
  const nodes = Object.fromEntries(ids.map(id => [id, {
    dataset: {}, events: {}, attributes: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }
  }]));
  let now = 10_000, nextTimer = 0, finished = 0, stoppedTracks = 0, stopFromMain, progress, prepareOptions, captureOptions;
  const timers = new Map(), recorders = [], segments = [], calls = [];
  const track = { events: {}, stop() { stoppedTracks++; }, addEventListener(name, handler) { this.events[name] = handler; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  class MediaRecorder extends EventEmitter {
    static isTypeSupported() { return true; }
    constructor() { super(); this.number = recorders.push(this); this.state = 'inactive'; }
    addEventListener(name, handler) { this.on(name, handler); }
    start(timeslice) {
      if (options.failStart === this.number) throw new Error('encoder restart failed');
      this.timeslice = timeslice; this.state = 'recording'; calls.push(`start-${this.number}`);
    }
    stop() {
      this.state = 'inactive';
      calls.push(`stop-${this.number}`);
      queueMicrotask(() => {
        this.emit('dataavailable', { data: options.segment ? options.segment(this.number) : new Blob([`header-${this.number}:frame-${this.number}`]) });
        this.emit('dataavailable', { data: new Blob([`:final-${this.number}`]) });
        this.emit('stop');
      });
    }
  }
  const api = {
    recordingPrepare: async value => { prepareOptions = value; return { id: 'auto-session' }; },
    recordingAutoStart: async () => {
      if (options.start) await options.start();
      return options.cancel ? { cancelled: true } : { id: 'auto-session', folder: 'C:\\Videos', preSeconds: 5, postSeconds: 10 };
    },
    recordingAutoSegment: async (id, buffer, timing) => {
      assert.equal(id, 'auto-session');
      calls.push(`upload-${segments.length + 1}`);
      if (options.upload) await options.upload();
      segments.push({ text: Buffer.from(buffer).toString(), timing });
    },
    recordingFinish: async (id, error) => { finished++; calls.push('finish'); return { saved: segments.length ? 1 : 0, folder: 'C:\\Videos', error }; },
    onRecordingStop(handler) { stopFromMain = handler; },
    onRecordingProgress(handler) { progress = handler; }
  };
  const FakeDate = class extends Date { static now() { return now; } };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, 'ui', 'recording.js'), 'utf8'), {
    window: { monitor: api, MediaRecorder }, MediaRecorder, Blob,
    navigator: { mediaDevices: { getDisplayMedia: async value => { captureOptions = value; return stream; } } },
    document: { getElementById: id => nodes[id] },
    Date: FakeDate, toast() {}, setInterval: () => 1, clearInterval() {},
    setTimeout(callback, milliseconds) { const token = ++nextTimer; timers.set(token, { at: now + milliseconds, callback }); return token; },
    clearTimeout(token) { timers.delete(token); }
  });
  const flush = async () => { for (let attempt = 0; attempt < 12; attempt++) await new Promise(setImmediate); };
  return {
    nodes, api, recorders, segments, calls, track, progress: value => progress(value), stopFromMain: () => stopFromMain(), flush,
    async advance(milliseconds) {
      now += milliseconds;
      for (const [token, timer] of [...timers]) if (timer.at <= now) { timers.delete(token); timer.callback(); }
      await flush();
    },
    get finished() { return finished; }, get stoppedTracks() { return stoppedTracks; },
    get prepareOptions() { return prepareOptions; }, get captureOptions() { return captureOptions; }
  };
}

test('automatic recording starts disabled, records complete independent segments, and flushes before stopping', async () => {
  const fixture = await autoFixture();
  const { nodes } = fixture;
  assert.equal(nodes['record-auto'].attributes['aria-pressed'], 'false');
  assert.match(nodes['record-auto-status'].textContent, /전 5초.*후 10초/);
  await nodes['record-auto'].events.click();
  assert.equal(fixture.prepareOptions.automatic, true);
  assert.equal(fixture.captureOptions.audio, false);
  assert.equal(nodes['record-status'].dataset.state, 'automatic');
  assert.equal(nodes['record-auto'].attributes['aria-pressed'], 'true');
  for (const id of ['record-start', 'record-stop', 'record-convert', 'record-audio']) assert.equal(nodes[id].disabled, true);
  assert.equal(nodes['record-auto'].disabled, false);
  await fixture.advance(2000);
  await fixture.advance(2000);
  assert.equal(fixture.recorders.length, 3);
  assert.ok(fixture.recorders.every(item => item.timeslice === undefined));
  assert.deepEqual(fixture.segments.map(item => item.text), ['header-1:frame-1:final-1', 'header-2:frame-2:final-2']);
  assert.deepEqual(fixture.segments.map(item => [item.timing.start, item.timing.end]), [[10000, 12000], [12000, 14000]]);
  assert.ok(fixture.calls.indexOf('start-2') < fixture.calls.indexOf('upload-1'));
  fixture.progress({ mode: 'auto', state: 'saved', message: 'MP4 저장 완료', saved: 1 });
  assert.equal(nodes['record-auto-status'].textContent, 'MP4 저장 완료');
  assert.equal(nodes['record-file'].disabled, false);
  await fixture.advance(500);
  nodes['record-auto'].events.click();
  assert.equal(nodes['record-auto'].disabled, true);
  await fixture.flush();
  assert.equal(fixture.segments.length, 3);
  assert.equal(fixture.segments[2].text, 'header-3:frame-3:final-3');
  assert.deepEqual([fixture.segments[2].timing.start, fixture.segments[2].timing.end], [14000, 14500]);
  assert.equal(fixture.calls.at(-1), 'finish');
  assert.equal(fixture.finished, 1);
  assert.equal(fixture.stoppedTracks, 1);
  assert.equal(nodes['record-status'].dataset.state, 'idle');
  assert.equal(nodes['record-auto'].attributes['aria-pressed'], 'false');
  for (const id of ['record-start', 'record-convert', 'record-audio', 'record-auto']) assert.equal(nodes[id].disabled, false);
  await fixture.advance(10_000);
  assert.equal(fixture.recorders.length, 3);
});

test('canceling the automatic recording folder picker releases capture without starting any recorder', async () => {
  const fixture = await autoFixture({ cancel: true });
  await fixture.nodes['record-auto'].events.click();
  assert.equal(fixture.recorders.length, 0);
  assert.equal(fixture.stoppedTracks, 1);
  assert.equal(fixture.nodes['record-status'].dataset.state, 'idle');
  assert.equal(fixture.nodes['record-auto'].attributes['aria-pressed'], 'false');
  await fixture.advance(10_000);
  assert.equal(fixture.segments.length, 0);
});

test('automatic stop waits for pending segment upload and preserves the last segment', async () => {
  let releaseUpload;
  const pending = new Promise(resolve => { releaseUpload = resolve; });
  const fixture = await autoFixture({ upload: () => pending });
  await fixture.nodes['record-auto'].events.click();
  await fixture.advance(2000);
  fixture.stopFromMain();
  await fixture.flush();
  assert.equal(fixture.nodes['record-status'].dataset.state, 'stopping');
  assert.equal(fixture.finished, 0);
  assert.equal(fixture.stoppedTracks, 0);
  releaseUpload();
  await fixture.flush();
  assert.equal(fixture.segments.length, 2);
  assert.match(fixture.segments.at(-1).text, /final-2$/);
  assert.equal(fixture.finished, 1);
  assert.equal(fixture.stoppedTracks, 1);
});

test('automatic encoder errors preserve final data and stop the segment loop', async () => {
  const fixture = await autoFixture();
  await fixture.nodes['record-auto'].events.click();
  const recorder = fixture.recorders[0];
  recorder.state = 'inactive';
  recorder.emit('error', { error: new Error('encoder failed') });
  assert.equal(fixture.finished, 0);
  recorder.emit('dataavailable', { data: new Blob(['header:final-frame']) });
  recorder.emit('stop');
  await fixture.flush();
  assert.equal(fixture.segments[0].text, 'header:final-frame');
  assert.equal(fixture.recorders.length, 1);
  assert.equal(fixture.finished, 1);
  assert.match(fixture.nodes['record-status'].textContent, /encoder failed/);
});

test('automatic upload failure stops capture and restores manual controls', async () => {
  const fixture = await autoFixture({ upload: async () => { throw new Error('disk full'); } });
  await fixture.nodes['record-auto'].events.click();
  await fixture.advance(2000);
  assert.equal(fixture.finished, 1);
  assert.equal(fixture.stoppedTracks, 1);
  assert.match(fixture.nodes['record-status'].textContent, /disk full/);
  assert.equal(fixture.nodes['record-start'].disabled, false);
  assert.equal(fixture.nodes['record-convert'].disabled, false);
});

test('automatic recording bounds queued segments when the destination stops accepting writes', async () => {
  let releaseUpload;
  const pending = new Promise(resolve => { releaseUpload = resolve; });
  const fixture = await autoFixture({ upload: () => pending, segment: () => new Blob([new Uint8Array(6 * 1024 * 1024)]) });
  await fixture.nodes['record-auto'].events.click();
  await fixture.advance(2000);
  await fixture.advance(2000);
  await fixture.advance(2000);
  assert.equal(fixture.nodes['record-status'].dataset.state, 'stopping');
  assert.equal(fixture.recorders.length, 4);
  assert.equal(fixture.finished, 0);
  releaseUpload();
  await fixture.flush();
  assert.equal(fixture.finished, 1);
  assert.equal(fixture.stoppedTracks, 1);
  assert.match(fixture.nodes['record-status'].textContent, /저장 속도가 부족/);
  assert.equal(fixture.segments.length, 1);
  await fixture.advance(4000);
  assert.equal(fixture.recorders.length, 4);
});

test('stopping automatic setup waits for the folder picker and then releases capture', async () => {
  let releasePicker;
  const pending = new Promise(resolve => { releasePicker = resolve; });
  const fixture = await autoFixture({ start: () => pending });
  const starting = fixture.nodes['record-auto'].events.click();
  await fixture.flush();
  assert.equal(fixture.nodes['record-auto'].disabled, true);
  fixture.stopFromMain();
  assert.equal(fixture.finished, 0);
  releasePicker();
  await starting;
  assert.equal(fixture.recorders.length, 0);
  assert.equal(fixture.finished, 1);
  assert.equal(fixture.stoppedTracks, 1);
  assert.equal(fixture.nodes['record-status'].dataset.state, 'idle');
});

test('ending the captured video track stops automatic recording with the final segment intact', async () => {
  const fixture = await autoFixture();
  await fixture.nodes['record-auto'].events.click();
  fixture.track.events.ended();
  await fixture.flush();
  assert.equal(fixture.finished, 1);
  assert.equal(fixture.segments.length, 1);
  assert.match(fixture.segments[0].text, /final-1$/);
  assert.ok(fixture.segments[0].timing.end > fixture.segments[0].timing.start);
  assert.equal(fixture.nodes['record-status'].dataset.state, 'idle');
});

test('an encoder restart failure saves the completed segment and releases capture', async () => {
  const fixture = await autoFixture({ failStart: 2 });
  await fixture.nodes['record-auto'].events.click();
  await fixture.advance(2000);
  assert.equal(fixture.segments.length, 1);
  assert.match(fixture.segments[0].text, /final-1$/);
  assert.equal(fixture.finished, 1);
  assert.equal(fixture.stoppedTracks, 1);
  assert.equal(fixture.nodes['record-status'].dataset.state, 'idle');
  assert.match(fixture.nodes['record-status'].textContent, /encoder restart failed/);
});
