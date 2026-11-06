export const PDF_POINTS_PER_INCH = 72;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function pointsToPixels(points, scale = 1) {
  return (Number(points) || 0) * scale;
}

export function pixelsToPoints(pixels, scale = 1) {
  return (Number(pixels) || 0) / (scale || 1);
}

export function normalizeBox(box, page) {
  const pageWidth = Number(page?.width) || 612;
  const pageHeight = Number(page?.height) || 792;
  if (box?.field_type === 'image') {
    const ratio = imageAspectRatio(box);
    const width = Math.min(Math.max(8, Number(box.width) || 144), pageWidth, pageHeight * ratio);
    const height = width / ratio;
    return { ...box, width, height,
      x: clamp(box.x, 0, pageWidth - width), y: clamp(box.y, 0, pageHeight - height) };
  }
  const width = clamp(box?.width ?? 144, 8, pageWidth);
  const height = clamp(box?.height ?? 24, 8, pageHeight);
  return {
    ...box,
    x: clamp(box?.x, 0, pageWidth - width),
    y: clamp(box?.y, 0, pageHeight - height),
    width,
    height,
  };
}

export function clientDeltaToPoints(deltaX, deltaY, scale) {
  return {
    x: pixelsToPoints(deltaX, scale),
    y: pixelsToPoints(deltaY, scale),
  };
}

export function resizeBox(box, deltaX, deltaY, scale, page) {
  const delta = clientDeltaToPoints(deltaX, deltaY, scale);
  if (box.field_type === 'image') {
    const ratio = imageAspectRatio(box);
    const widthDelta = Math.abs(delta.x) >= Math.abs(delta.y * ratio) ? delta.x : delta.y * ratio;
    return resizeImageBox(box, Number(box.width) + widthDelta, 'width', page);
  }
  const pageWidth = Number(page?.width) || 612;
  const pageHeight = Number(page?.height) || 792;
  return normalizeBox({
    ...box,
    width: clamp(Number(box.width) + delta.x, 8, pageWidth - Number(box.x)),
    height: clamp(Number(box.height) + delta.y, 8, pageHeight - Number(box.y)),
  }, page);
}

export function imageAspectRatio(box) {
  const intrinsic = Number(box.image_width) / Number(box.image_height);
  const existing = Number(box.width) / Number(box.height);
  return Number.isFinite(intrinsic) && intrinsic > 0 ? intrinsic :
    Number.isFinite(existing) && existing > 0 ? existing : 3;
}

// Numeric and pointer resizing share the same ratio and page-edge constraints.
export function resizeImageBox(box, value, dimension, page) {
  const ratio = imageAspectRatio(box);
  const widthLimit = Math.min((Number(page?.width) || 612) - Number(box.x || 0),
    ((Number(page?.height) || 792) - Number(box.y || 0)) * ratio);
  const width = clamp(dimension === 'height' ? Number(value) * ratio : value,
    Math.min(Math.max(8, 8 * ratio), widthLimit), widthLimit);
  return { ...box, width, height: width / ratio };
}

export function moveBox(box, deltaX, deltaY, scale, page) {
  const delta = clientDeltaToPoints(deltaX, deltaY, scale);
  return normalizeBox({
    ...box,
    x: Number(box.x) + delta.x,
    y: Number(box.y) + delta.y,
  }, page);
}

export function calculateFitScale(mode, container, page, fallback = 1) {
  if (typeof mode === 'number') return mode;
  const widthScale = (Number(container?.width) || 0) / (Number(page?.width) || 612);
  const heightScale = (Number(container?.height) || 0) / (Number(page?.height) || 792);
  if (mode === 'fit-width') return widthScale || fallback;
  if (mode === 'fit-page') return Math.min(widthScale || fallback, heightScale || fallback);
  return fallback;
}