// This tracker deliberately reports doubtful crossings instead of silently
// turning crowded/poorly observed frames into a confident count.
function createPeopleCounter({ line = {}, confidence = 0.35 } = {}) {
  const axis = line.axis === 'horizontal' ? 'horizontal' : 'vertical';
  const position = Number.isFinite(line.position) ? Math.max(0.05, Math.min(0.95, line.position)) : 0.5;
  const threshold = Number.isFinite(confidence) ? Math.max(0.15, Math.min(1, confidence)) : 0.35;
  const band = 0.03, ttl = 1500;
  let tracks = [], sequence = 0, previousAt;

  const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const coordinate = box => center(box)[axis === 'vertical' ? 'x' : 'y'];
  const side = box => coordinate(box) < position - band ? -1 : coordinate(box) > position + band ? 1 : 0;
  const nearLine = box => Math.abs(coordinate(box) - position) <= band * 3;
  function overlap(a, b) {
    const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const intersection = width * height;
    return intersection / (a.width * a.height + b.width * b.height - intersection || 1);
  }
  function normalize(box) {
    if (!box || !['x', 'y', 'width', 'height', 'score'].every(key => Number.isFinite(box[key])) ||
        box.width <= 0 || box.height <= 0 || box.score < 0.15) return null;
    const x = Math.max(0, box.x), y = Math.max(0, box.y);
    const right = Math.min(1, box.x + box.width), bottom = Math.min(1, box.y + box.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y, score: box.score } : null;
  }

  function update(detections = [], { at = Date.now(), motionRatio = 0, unexplainedRatio = 0 } = {}) {
    const events = [], uncertain = new Set();
    const doubt = reason => uncertain.add(reason);
    if (!Number.isFinite(at)) throw new Error('영상 프레임 시간이 올바르지 않습니다.');
    if (previousAt !== undefined && at <= previousAt) {
      return { events, uncertain: ['영상 프레임의 시간 순서가 올바르지 않습니다.'], personCount: 0, boxes: [], trackCount: tracks.length };
    }
    if (previousAt !== undefined && at - previousAt > ttl) {
      doubt('영상 분석 간격이 길어 통행을 놓쳤을 수 있습니다.');
    }
    previousAt = at;
    const boxes = (Array.isArray(detections) ? detections : []).map(normalize).filter(Boolean);
    const reliable = boxes.filter(box => box.score >= threshold);
    if (boxes.some(box => box.score < threshold && nearLine(box))) doubt('통행선 주변 사람 검출의 신뢰도가 낮습니다.');
    if ((!reliable.length && motionRatio > 0.015) || unexplainedRatio > 0.03) {
      doubt('움직임은 있지만 사람의 통행을 충분히 확인하지 못했습니다.');
    }
    const expired = [];
    tracks = tracks.filter(track => {
      if (at - track.at <= ttl) return true;
      expired.push(track);
      if (nearLine(track.box)) doubt('통행선 주변에서 사람 추적이 끊겼습니다.');
      return false;
    });

    const candidates = [];
    for (let t = 0; t < tracks.length; t++) {
      for (let d = 0; d < reliable.length; d++) {
        const a = center(tracks[t].box), b = center(reliable[d]);
        const distance = Math.hypot(a.x - b.x, a.y - b.y), iou = overlap(tracks[t].box, reliable[d]);
        const limit = Math.min(0.4, 0.25 + (at - tracks[t].at) / 5000);
        if (distance <= limit || iou > 0.05) candidates.push({ t, d, distance, iou, cost: distance + (1 - iou) * 0.08 });
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    for (const candidate of candidates) {
      if (!nearLine(tracks[candidate.t].box) && !nearLine(reliable[candidate.d])) continue;
      if (candidates.some(other => other !== candidate && (other.t === candidate.t || other.d === candidate.d) &&
          Math.abs(other.cost - candidate.cost) < 0.06)) doubt('서로 가까운 사람들의 추적을 구분하기 어렵습니다.');
    }
    for (let a = 0; a < reliable.length; a++) {
      for (let b = a + 1; b < reliable.length; b++) {
        if (overlap(reliable[a], reliable[b]) > 0.45 && (nearLine(reliable[a]) || nearLine(reliable[b]))) {
          doubt('통행선 주변에서 사람들이 겹쳐 보입니다.');
        }
        const first = center(reliable[a]), second = center(reliable[b]);
        if (nearLine(reliable[a]) && nearLine(reliable[b]) && side(reliable[a]) * side(reliable[b]) === -1 &&
            Math.hypot(first.x - second.x, first.y - second.y) < 0.22) {
          // Without appearance features, opposite-moving people can exchange
          // their nearest boxes between frames and hide both crossings.
          doubt('통행선 양쪽의 가까운 사람이 교차해 추적이 바뀌었을 수 있습니다.');
        }
        const perpendicular = axis === 'vertical' ? 'y' : 'x';
        if (motionRatio > 0.015 && side(reliable[a]) * side(reliable[b]) === -1 &&
            Math.abs(first[perpendicular] - second[perpendicular]) < 0.25) {
          doubt('통행선 양쪽에 움직이는 사람이 있어 서로 바뀐 추적을 배제할 수 없습니다.');
        }
      }
    }

    const assignedTracks = new Set(), assignedDetections = new Set(), resultBoxes = [];
    for (const candidate of candidates) {
      if (assignedTracks.has(candidate.t) || assignedDetections.has(candidate.d)) continue;
      assignedTracks.add(candidate.t);
      assignedDetections.add(candidate.d);
      const track = tracks[candidate.t], box = reliable[candidate.d], nextSide = side(box);
      track.hits++;
      if (nextSide && track.side && nextSide !== track.side && track.hits >= 2) {
        const direction = (nextSide > track.side) !== !!line.invert ? 'in' : 'out';
        if (at - (track.crossed[direction] ?? -Infinity) >= 1000) {
          events.push({ at, id: track.id, direction });
          track.crossed[direction] = at;
        } else doubt('같은 사람이 통행선 주변을 빠르게 반복 이동했습니다.');
        if (!candidate.iou && candidate.distance > 0.25) doubt('사람의 이동이 빨라 통행 방향을 확신하기 어렵습니다.');
      }
      if (nextSide) track.side = nextSide;
      track.box = box;
      track.at = at;
      resultBoxes.push({ ...box, id: track.id });
    }
    const unmatched = [...expired, ...tracks.filter((_track, trackIndex) => !assignedTracks.has(trackIndex))];
    reliable.forEach((box, index) => {
      if (assignedDetections.has(index)) return;
      if (unmatched.some(track => {
        const a = center(track.box), b = center(box), perpendicular = axis === 'vertical' ? 'y' : 'x';
        return side(track.box) * side(box) === -1 && Math.abs(a[perpendicular] - b[perpendicular]) < 0.25;
      })) doubt('통행선을 건너뛴 사람 검출이 있어 빠른 통행을 놓쳤을 수 있습니다.');
      const track = { id: ++sequence, box, at, hits: 1, side: side(box), crossed: {} };
      tracks.push(track);
      resultBoxes.push({ ...box, id: track.id });
      if (nearLine(box)) doubt('사람을 통행선 주변에서 처음 발견해 이전 위치를 알 수 없습니다.');
    });
    return { events, uncertain: [...uncertain], personCount: reliable.length, boxes: resultBoxes, trackCount: tracks.length };
  }

  return { update, reset() { tracks = []; sequence = 0; previousAt = undefined; } };
}

module.exports = { createPeopleCounter };
