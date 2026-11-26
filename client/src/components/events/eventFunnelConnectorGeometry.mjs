export function orthogonalPoints(points) {
  const result = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous && previous.x !== point.x && previous.y !== point.y) {
      // The final leg enters the top of the target vertically.
      result.push(point === points.at(-1) ? { x: point.x, y: previous.y } : { x: previous.x, y: point.y });
    }
    if (!previous || previous.x !== point.x || previous.y !== point.y) result.push({ ...point });
  }
  return result;
}

export function connectorPoints(start, end, bends) {
  if (bends?.length) {
    const interior = bends.map(point => ({ ...point }));
    interior[0].x = start.x;
    interior[interior.length - 1].x = end.x;
    return orthogonalPoints([start, ...interior, end]);
  }
  if (end.y >= start.y + 48) {
    const y = (start.y + end.y) / 2;
    // Retain both middle corners even on a straight vertical connection, so
    // moving a segment or adding a bend remains possible.
    return [start, { x: start.x, y }, { x: end.x, y }, end];
  }
  const x = Math.max(start.x, end.x) + 90;
  return [start, { x: start.x, y: start.y + 24 }, { x, y: start.y + 24 },
    { x, y: end.y - 24 }, { x: end.x, y: end.y - 24 }, end];
}

export const connectorPath = points => points.map((point, i) => `${i ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');

export function connectorMidpoint(points) {
  const lengths = points.slice(1).map((point, i) => Math.abs(point.x - points[i].x) + Math.abs(point.y - points[i].y));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i]) {
      const ratio = remaining / lengths[i];
      return { x: points[i].x + (points[i + 1].x - points[i].x) * ratio,
        y: points[i].y + (points[i + 1].y - points[i].y) * ratio };
    }
    remaining -= lengths[i];
  }
  return { ...points[0] };
}

export function moveConnectorBend(points, index, point) {
  const next = points.map(item => ({ ...item }));
  const old = points[index], before = next[index - 1], after = next[index + 1];
  if (!before || !after) return next;
  const beforeVertical = before.x === old.x, afterVertical = after.x === old.x;
  const moved = { ...point };
  if (index === 1) moved[beforeVertical ? 'x' : 'y'] = before[beforeVertical ? 'x' : 'y'];
  if (index === points.length - 2) moved[afterVertical ? 'x' : 'y'] = after[afterVertical ? 'x' : 'y'];
  // Apply constraints first, then update neighbours with the final coordinate.
  if (index > 1) {
    if (beforeVertical) before.x = moved.x; else before.y = moved.y;
  }
  if (index < points.length - 2) {
    if (afterVertical) after.x = moved.x; else after.y = moved.y;
  }
  next[index] = moved;
  return orthogonalPoints(next);
}

export function moveConnectorSegment(points, index, point) {
  if (index < 1 || index >= points.length - 2) return points;
  const next = points.map(item => ({ ...item }));
  const axis = points[index].y === points[index + 1].y ? 'y' : 'x';
  next[index][axis] = point[axis];
  next[index + 1][axis] = point[axis];
  return orthogonalPoints(next);
}

export function addConnectorBend(points) {
  if (points.length > 20) return points;
  let index = 0, longest = -1;
  for (let i = 0; i < points.length - 1; i++) {
    const length = Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y);
    if (length > longest) { longest = length; index = i; }
  }
  const a = points[index], b = points[index + 1], vertical = a.x === b.x;
  const axis = vertical ? 'y' : 'x', offsetAxis = vertical ? 'x' : 'y';
  const first = { ...a, [axis]: a[axis] + (b[axis] - a[axis]) / 3 };
  const last = { ...b, [axis]: a[axis] + 2 * (b[axis] - a[axis]) / 3 };
  return [...points.slice(0, index + 1), first, { ...first, [offsetAxis]: a[offsetAxis] + 60 },
    { ...last, [offsetAxis]: a[offsetAxis] + 60 }, last, ...points.slice(index + 1)];
}
