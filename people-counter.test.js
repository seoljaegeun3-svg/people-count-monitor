const test = require('node:test');
const assert = require('node:assert/strict');
const { createPeopleCounter } = require('./people-counter');

const person = (x, y = 0.4, score = 0.9) => ({ x: x - 0.06, y: y - 0.15, width: 0.12, height: 0.3, score });

test('tracks confirmed crossings in both directions with stable identities', () => {
  const counter = createPeopleCounter();
  const first = counter.update([person(0.3)], { at: 0 });
  const approach = counter.update([person(0.44)], { at: 250 });
  const entered = counter.update([person(0.57)], { at: 500 });
  assert.equal(first.boxes[0].id, approach.boxes[0].id);
  assert.deepEqual(entered.events, [{ at: 500, id: 1, direction: 'in' }]);
  assert.deepEqual(counter.update([person(0.43)], { at: 900 }).events, [{ at: 900, id: 1, direction: 'out' }]);
});

test('line hysteresis ignores jitter, respects inverted horizontal direction and reset', () => {
  const counter = createPeopleCounter({ line: { axis: 'horizontal', position: 0.5, invert: true } });
  counter.update([person(0.4, 0.4)], { at: 0 });
  for (const [index, y] of [0.48, 0.51, 0.49, 0.52].entries()) {
    assert.equal(counter.update([person(0.4, y)], { at: 100 + index * 100 }).events.length, 0);
  }
  assert.equal(counter.update([person(0.4, 0.6)], { at: 600 }).events[0].direction, 'out');
  counter.reset();
  assert.equal(counter.update([person(0.4, 0.6)], { at: 0 }).events.length, 0);
});

test('counts two separated people independently', () => {
  const counter = createPeopleCounter();
  counter.update([person(0.32, 0.23), person(0.34, 0.77)], { at: 0 });
  counter.update([person(0.46, 0.23), person(0.47, 0.77)], { at: 250 });
  const result = counter.update([person(0.6, 0.23), person(0.61, 0.77)], { at: 500 });
  assert.equal(result.events.length, 2);
  assert.deepEqual(new Set(result.events.map(event => event.id)), new Set([1, 2]));
  assert.equal(result.personCount, 2);
});

test('weak near-line detections never count as confirmed people', () => {
  const counter = createPeopleCounter();
  counter.update([person(0.4)], { at: 0 });
  const result = counter.update([person(0.52, 0.4, 0.2)], { at: 300 });
  assert.equal(result.events.length, 0);
  assert.equal(result.personCount, 0);
  assert.ok(result.uncertain.some(reason => reason.includes('신뢰도')));
});

test('occlusion and ambiguous close matches are retained as uncertain', () => {
  const counter = createPeopleCounter();
  counter.update([person(0.43, 0.4), person(0.44, 0.45)], { at: 0 });
  const result = counter.update([person(0.5, 0.42), person(0.51, 0.46)], { at: 300 });
  assert.ok(result.uncertain.some(reason => reason.includes('구분')));
  assert.ok(result.uncertain.some(reason => reason.includes('겹쳐')));
});

test('opposite people exchanging nearest positions cannot silently appear stationary', () => {
  const counter = createPeopleCounter();
  counter.update([person(0.3), person(0.7)], { at: 0 });
  counter.update([person(0.44), person(0.56)], { at: 250 });
  const result = counter.update([person(0.56), person(0.44)], { at: 500 });
  assert.ok(result.uncertain.some(reason => reason.includes('교차')));
  const wider = createPeopleCounter();
  wider.update([person(0.35), person(0.65)], { at: 0 });
  const swapped = wider.update([person(0.65), person(0.35)], { at: 250, motionRatio: 0.2 });
  assert.ok(swapped.uncertain.some(reason => reason.includes('서로 바뀐')));
});

test('fast unlinked and expired crossings remain uncertain instead of silently disappearing', () => {
  for (const at of [250, 1600]) {
    const counter = createPeopleCounter();
    counter.update([person(0.25)], { at: 0 });
    const result = counter.update([person(0.75)], { at });
    assert.equal(result.events.length, 0);
    assert.ok(result.uncertain.some(reason => reason.includes('건너뛴')));
  }
});

test('lost tracks, slow analysis, and unexplained motion mark uncertainty', () => {
  const counter = createPeopleCounter();
  counter.update([person(0.46)], { at: 0 });
  const result = counter.update([], { at: 2500, motionRatio: 0.1 });
  assert.equal(result.trackCount, 0);
  assert.ok(result.uncertain.some(reason => reason.includes('끊겼')));
  assert.ok(result.uncertain.some(reason => reason.includes('분석 간격')));
  assert.ok(result.uncertain.some(reason => reason.includes('움직임')));
});

test('invalid detections and out-of-order frames cannot fabricate crossings', () => {
  const counter = createPeopleCounter();
  counter.update([person(0.3)], { at: 100 });
  assert.equal(counter.update([person(0.6)], { at: 50 }).events.length, 0);
  const result = counter.update([{ ...person(0.6), width: NaN }, person(3), null], { at: 200 });
  assert.equal(result.events.length, 0);
  assert.equal(result.personCount, 0);
});
