const test = require('node:test');
const assert = require('node:assert/strict');
const { comparePassage } = require('./passage-comparison');

const sample = (at, value, state = 'ok') => ({ at, value, state });
const crossing = (at, direction = 'in') => ({ at, direction });
const compare = overrides => comparePassage({ start: 1000, end: 3000, mapping: 'occupancy',
  plcSamples: [sample(900, 5), sample(1500, 6), sample(2500, 6)], crossings: [crossing(1400)], ...overrides });

test('matches independently observed entries and exits, not just net occupancy', () => {
  assert.equal(compare({}).status, 'matched');
  const both = compare({ crossings: [crossing(1400), crossing(2000, 'out')],
    plcSamples: [sample(900, 5), sample(1500, 6), sample(2200, 5), sample(2500, 5)] });
  assert.deepEqual({ status: both.status, in: both.plcIn, out: both.plcOut }, { status: 'matched', in: 1, out: 1 });
});

test('two video entries and one PLC increment are a mismatch', () => {
  const result = compare({ crossings: [crossing(1400), crossing(1500)] });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.videoIn, 2);
  assert.equal(result.plcIn, 1);
});

test('video passage without any PLC change is a mismatch', () => {
  const result = compare({ plcSamples: [sample(900, 5), sample(1500, 5), sample(2500, 5)] });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.plcTotal, 0);
});

test('opposite passages hidden between polls never match a net zero', () => {
  const result = compare({ crossings: [crossing(1400), crossing(1500, 'out')],
    plcSamples: [sample(900, 5), sample(1500, 5), sample(2500, 5)] });
  assert.equal(result.status, 'uncertain');
  assert.ok(result.reasons.some(reason => reason.includes('상쇄')));
  assert.equal(compare({ crossings: [crossing(1400), crossing(1500), crossing(1600, 'out')] }).status, 'uncertain');
});

test('total mapping compares both directions together and allows a small uint16 wrap', () => {
  const result = compare({ mapping: 'total', crossings: [crossing(1400), crossing(2000, 'out')],
    plcSamples: [sample(900, 65535), sample(1500, 0), sample(2500, 1)] });
  assert.equal(result.status, 'matched');
  assert.equal(result.plcTotal, 2);
  assert.equal(result.plcIn, undefined);
});

test('occupancy supports reverse uint16 wrap while resets and large jumps remain uncertain', () => {
  assert.equal(compare({ crossings: [crossing(1400, 'out')],
    plcSamples: [sample(900, 0), sample(1500, 65535), sample(2500, 65535)] }).status, 'matched');
  assert.equal(compare({ plcSamples: [sample(900, 500), sample(1500, 0), sample(2500, 0)] }).status, 'uncertain');
  assert.equal(compare({ mapping: 'total', plcSamples: [sample(900, 4), sample(1500, 3), sample(2500, 3)] }).status, 'uncertain');
  assert.equal(compare({ plcSamples: [sample(900, 5), sample(1500, 0), sample(2500, 0)] }).status, 'uncertain');
});

test('reconnect never bridges an error into a confident increment', () => {
  const result = compare({ plcSamples: [sample(900, 5), sample(1300, undefined, 'error'), sample(1500, 6), sample(2500, 6)] });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.plcIn, 0);
});

test('missing baseline, stale end, receive gaps, unknown mapping and model errors remain uncertain', () => {
  assert.equal(compare({ plcSamples: [sample(1500, 6), sample(2500, 6)] }).status, 'uncertain');
  assert.equal(compare({ end: 6000 }).status, 'uncertain');
  assert.equal(compare({ end: 6000, plcSamples: [sample(900, 5), sample(1500, 6), sample(5500, 6)] }).status, 'uncertain');
  assert.equal(compare({ mapping: 'unknown' }).status, 'uncertain');
  assert.equal(compare({ uncertainties: ['영상이 멈췄습니다.'] }).status, 'uncertain');
  assert.equal(compare({ crossings: [], motionCandidate: true, plcSamples: [sample(900, 5), sample(2500, 5)] }).status, 'uncertain');
});

test('interval is half-open, and out-of-order or contradictory PLC samples are uncertain', () => {
  const result = compare({ crossings: [crossing(999), crossing(1000), crossing(3000)],
    plcSamples: [sample(900, 5), sample(1000, 6), sample(2500, 6), sample(3000, 7)] });
  assert.equal(result.status, 'matched');
  assert.equal(result.videoIn, 1);
  assert.equal(result.plcIn, 1);
  assert.equal(compare({ plcSamples: [sample(900, 5), sample(2000, 6), sample(1500, 6), sample(2500, 6)] }).status, 'uncertain');
  assert.equal(compare({ plcSamples: [sample(900, 5), sample(1500, 5), sample(1500, 6), sample(2500, 6)] }).status, 'uncertain');
});
