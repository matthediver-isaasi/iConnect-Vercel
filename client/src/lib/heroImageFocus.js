const CENTER_FOCAL_POINT = Object.freeze({ x: 50, y: 50 });

function toPercentage(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, number));
}

/**
 * Normalizes a stored focus point while preserving legacy heroes that have
 * never saved focus data. Focus is deliberately kept as percentages so it can
 * be used directly as CSS object-position values.
 */
export function normalizeHeroImageFocus(focalPoint) {
  return {
    x: toPercentage(focalPoint?.x, CENTER_FOCAL_POINT.x),
    y: toPercentage(focalPoint?.y, CENTER_FOCAL_POINT.y),
  };
}

/**
 * Resolves the focus point for the requested responsive background. A mobile
 * background set to "Same as Desktop" inherits the desktop focus, matching
 * the existing background-image inheritance behaviour.
 */
export function resolveHeroImageFocus(content, { mobile = false } = {}) {
  const desktopFocus = normalizeHeroImageFocus(content?.image_focal_point);
  if (!mobile || content?.mobile_background_type === 'same' || !content?.mobile_background_type) {
    return desktopFocus;
  }
  return normalizeHeroImageFocus(content?.mobile_image_focal_point);
}

export function isCoverImageFit(imageFit) {
  return !imageFit || imageFit === 'cover';
}

/**
 * Only cover crops should receive an explicit position. Contain and natural
 * image modes preserve their previous rendering exactly.
 */
export function getHeroImageFocusStyle(imageFit, focalPoint) {
  if (!isCoverImageFit(imageFit)) return {};
  const { x, y } = normalizeHeroImageFocus(focalPoint);
  return { objectPosition: `${x}% ${y}%` };
}

export function getHeroBackgroundFocusStyle(imageFit, focalPoint) {
  if (!isCoverImageFit(imageFit)) return {};
  const { x, y } = normalizeHeroImageFocus(focalPoint);
  return { backgroundPosition: `${x}% ${y}%` };
}

export function getHeroThumbnailBackgroundStyle(imageUrl, imageFit, focalPoint) {
  return {
    backgroundImage: `url(${imageUrl})`,
    backgroundSize: imageFit || 'cover',
    backgroundPosition: '50% 50%',
    backgroundRepeat: 'no-repeat',
    ...getHeroBackgroundFocusStyle(imageFit, focalPoint),
  };
}