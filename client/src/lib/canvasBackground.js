// Shared, pure CSS-background builders used by the canvas Hero/Section blocks
// AND the authenticated-portal sidebar branding. Extracted from
// `components/canvas/blocks/registry.jsx` so the exact same CSS-generation code
// drives both surfaces (no duplicated, drifting logic). registry.jsx imports
// and re-exports the section builders for backwards compatibility.

// Convert a hex (or arbitrary CSS) colour plus an opacity (0-1) into an rgba()
// string. `color-mix` is overkill — instead we fall back to letting the browser
// resolve the colour and apply opacity via a second value. To keep the
// gradient string valid CSS in every case, we always emit rgba() for hex
// inputs and an opacity-multiplied raw value otherwise.
export function hexToRgba(input, opacity) {
  const o = Math.max(0, Math.min(1, Number(opacity) || 0));
  if (typeof input !== 'string') return `rgba(0,0,0,${o})`;
  const s = input.trim();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m3) {
    const r = parseInt(m3[1] + m3[1], 16);
    const g = parseInt(m3[2] + m3[2], 16);
    const b = parseInt(m3[3] + m3[3], 16);
    return `rgba(${r},${g},${b},${o})`;
  }
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (m6) {
    const r = parseInt(m6[1], 16);
    const g = parseInt(m6[2], 16);
    const b = parseInt(m6[3], 16);
    return `rgba(${r},${g},${b},${o})`;
  }
  // Fallback: assume the caller passed an rgb()/rgba()/named colour and
  // approximate opacity by wrapping in color-mix. Browsers without
  // color-mix support fall back to the raw value (opacity ignored), which
  // is acceptable for v1 since the inspector picker emits hex.
  return `color-mix(in srgb, ${s} ${Math.round(o * 100)}%, transparent)`;
}

// ---------------------------------------------------------------------------
// Fixed Height / Horizontal Crop image fit (Task #3159)
//
// A responsive display mode for wide images: the image scales strictly by the
// HEIGHT of its box (never by width), so as the box narrows the left/right
// edges are clipped instead of the image growing taller. The box's height is
// author-controlled and never grows because of the image.
//
// Implementation is one shared recipe used by every render surface (v1 editor
// stage, v1 public renderer, v2 flow editor/public — all of which render
// blocks through the same registry components):
//   - a clipping wrapper with `overflow: hidden` filling the box, and
//   - the <img> inside sized `height: 100%; width: auto` (aspect-preserving)
//     and horizontally anchored on the focal x: `left: fx%` +
//     `translateX(-fx%)` pins the image's fx% point to the box's fx% point,
//     so cropping happens symmetrically around the chosen safe area.
// ---------------------------------------------------------------------------
export const IMAGE_FIT_FIXED_CROP = 'fixed-crop';

export function isFixedCropFit(fit) {
  return fit === IMAGE_FIT_FIXED_CROP;
}

// Style for the <img> inside an overflow-hidden clipping box. `focalX` is the
// horizontal focal point in percent (0 = left edge stays visible, 100 = right
// edge stays visible, 50 = centre crop).
export function buildFixedCropImgStyle(focalX) {
  // NB: Number(null) === 0, so nullish/empty must be checked explicitly or a
  // missing focal point would left-anchor the crop instead of centring it.
  const n = focalX == null || focalX === '' ? NaN : Number(focalX);
  const fx = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50;
  return {
    position: 'absolute',
    top: 0,
    bottom: 0,
    height: '100%',
    width: 'auto',
    maxWidth: 'none',
    maxHeight: 'none',
    left: `${fx}%`,
    transform: `translateX(-${fx}%)`,
  };
}

// Hero/overlay direction presets → CSS linear-gradient angle (deg). The angle
// names the direction the gradient travels toward, so e.g. 'to-top' (0deg)
// puts the first colour at the bottom fading to the second at the top.
export const HERO_OVERLAY_DIRECTIONS = {
  'to-top': 0,
  'to-bottom': 180,
  'to-right': 90,
  'to-left': 270,
  'to-bottom-right': 135,
  'to-top-right': 45,
};

export function heroOverlayAngle(c) {
  const dir = c.overlayDirection || 'to-top';
  if (dir === 'custom') {
    return Number.isFinite(c.overlayAngle) ? c.overlayAngle : 0;
  }
  return HERO_OVERLAY_DIRECTIONS[dir] ?? 0;
}

// Builds the Hero image/video overlay CSS background. Solid (default, and the
// fallback for legacy data that has no overlayStyle) reproduces the original
// flat black wash driven by darkWash. Gradient emits a linear gradient along
// the chosen direction: a full multipoint gradient when a usable `overlayStops`
// array (2+ stops) is present, otherwise the legacy two-stop from→to output so
// blocks saved before per-stop support are byte-identical.
export function buildHeroOverlayBackground(c) {
  if ((c.overlayStyle || 'solid') === 'none') {
    return null;
  }
  if ((c.overlayStyle || 'solid') === 'gradient') {
    const stops = getUsableStops(c.overlayStops);
    if (stops) {
      return `linear-gradient(${heroOverlayAngle(c)}deg, ${buildGradientStopList(stops)})`;
    }
    const from = hexToRgba(c.overlayFromColor || '#000000', c.overlayFromOpacity ?? 0.6);
    const to = hexToRgba(c.overlayToColor || '#000000', c.overlayToOpacity ?? 0);
    return `linear-gradient(${heroOverlayAngle(c)}deg, ${from}, ${to})`;
  }
  return `rgba(0,0,0,${Math.max(0, Math.min(1, c.darkWash ?? 0.4))})`;
}

export function buildSectionOverlayBackground(c) {
  const t = c.overlayType || 'none';
  if (t === 'solid') {
    return hexToRgba(c.overlayColor || '#000000', c.overlayOpacity ?? 0.4);
  }
  if (t === 'linear') {
    const angle = Number.isFinite(c.overlayAngle) ? c.overlayAngle : 180;
    const from = hexToRgba(c.overlayFromColor || '#000000', c.overlayFromOpacity ?? 0.6);
    const to = hexToRgba(c.overlayToColor || '#000000', c.overlayToOpacity ?? 0);
    return `linear-gradient(${angle}deg, ${from}, ${to})`;
  }
  if (t === 'radial') {
    const centre = hexToRgba(c.overlayCenterColor || '#000000', c.overlayCenterOpacity ?? 0);
    const edge = hexToRgba(c.overlayEdgeColor || '#000000', c.overlayEdgeOpacity ?? 0.6);
    return `radial-gradient(ellipse at center, ${centre}, ${edge})`;
  }
  return null;
}

// A gradient stops array is "usable" only when it carries at least two valid
// stops. Anything less falls back to the legacy two-stop fields so older
// blocks (and blocks mid-edit) keep rendering exactly as before. Shared by the
// Section gradient (`gradientStops`) and the Hero overlay (`overlayStops`).
export function getUsableStops(arr) {
  if (!Array.isArray(arr)) return null;
  const stops = arr.filter((s) => s && typeof s === 'object');
  return stops.length >= 2 ? stops : null;
}

export function getUsableGradientStops(c) {
  return getUsableStops(c.gradientStops);
}

// Emits the CSS colour-stop list ("rgba(...) 25%, rgba(...) 80%") for a
// multipoint gradient. Each stop contributes colour (with opacity folded in
// via hexToRgba) plus an optional position; positions are clamped to 0–100%.
export function buildGradientStopList(stops) {
  return stops
    .map((s) => {
      const col = hexToRgba(typeof s.color === 'string' ? s.color : '#000000', s.opacity ?? 1);
      const posNum = Number(s.position);
      if (Number.isFinite(posNum)) {
        return `${col} ${Math.max(0, Math.min(100, posNum))}%`;
      }
      return col;
    })
    .join(', ');
}

// Builds the CSS gradient string for sections whose `bgType === 'gradient'`.
// Mirrors buildSectionOverlayBackground but uses dedicated `gradient*` keys
// so the value is preserved separately from any image-overlay configuration
// the same section may also have stored.
//
// When a `gradientStops` array with 2+ stops is present it is the source of
// truth and emits a full multipoint gradient. When it is absent (legacy
// sections, or solid/image sections) we fall back to the original two-stop
// from→to / centre→edge output so existing pages are byte-identical.
export function buildSectionGradientBackground(c) {
  const t = c.gradientType || 'linear';
  const stops = getUsableGradientStops(c);
  if (stops) {
    const stopList = buildGradientStopList(stops);
    if (t === 'radial') {
      return `radial-gradient(ellipse at center, ${stopList})`;
    }
    const angle = Number.isFinite(c.gradientAngle) ? c.gradientAngle : 180;
    return `linear-gradient(${angle}deg, ${stopList})`;
  }
  if (t === 'radial') {
    const centre = hexToRgba(c.gradientCenterColor || '#3b82f6', c.gradientCenterOpacity ?? 1);
    const edge = hexToRgba(c.gradientEdgeColor || '#1e3a8a', c.gradientEdgeOpacity ?? 1);
    return `radial-gradient(ellipse at center, ${centre}, ${edge})`;
  }
  const angle = Number.isFinite(c.gradientAngle) ? c.gradientAngle : 180;
  const from = hexToRgba(c.gradientFromColor || '#3b82f6', c.gradientFromOpacity ?? 1);
  const to = hexToRgba(c.gradientToColor || '#1e3a8a', c.gradientToOpacity ?? 1);
  return `linear-gradient(${angle}deg, ${from}, ${to})`;
}

// Derives the stops array the inspector edits. When a usable stops array is
// already stored we normalise it; otherwise we seed a sensible two-stop list
// from the legacy from/to (linear) or centre/edge (radial) fields so the very
// first edit picks up exactly what the section is rendering today.
export function deriveSectionGradientStops(c, type) {
  const stored = getUsableGradientStops(c);
  if (stored) {
    return stored.map((s, i) => ({
      color: typeof s.color === 'string' && s.color ? s.color : '#000000',
      opacity: Math.max(0, Math.min(1, Number(s.opacity ?? 1) || 0)),
      position: Number.isFinite(Number(s.position))
        ? Math.max(0, Math.min(100, Number(s.position)))
        : (i === 0 ? 0 : 100),
    }));
  }
  if (type === 'radial') {
    return [
      { color: c.gradientCenterColor || '#3b82f6', opacity: c.gradientCenterOpacity ?? 1, position: 0 },
      { color: c.gradientEdgeColor || '#1e3a8a', opacity: c.gradientEdgeOpacity ?? 1, position: 100 },
    ];
  }
  return [
    { color: c.gradientFromColor || '#3b82f6', opacity: c.gradientFromOpacity ?? 1, position: 0 },
    { color: c.gradientToColor || '#1e3a8a', opacity: c.gradientToOpacity ?? 1, position: 100 },
  ];
}

// Builds an inline-style object for an authenticated-portal nav surface
// (sidebar / mobile sheet) from a `portalNav.background` config. Reuses the
// exact Hero overlay + Section gradient CSS builders above so the sidebar
// background visually matches the canvas Hero element background.
//
// Shape of `bg`:
//   { type: 'solid' | 'image' | 'gradient',
//     solidColor,                                  // solid
//     imageUrl, focalPoint:{x,y},                  // image
//     overlayStyle, darkWash, overlayStops, overlayDirection, overlayAngle,
//     gradientType, gradientStops, gradientAngle } // gradient
//
// Returns {} when nothing usable is configured so callers can fall back to
// their existing default classes (no visual regression).
export function buildPortalNavBackgroundStyle(bg) {
  if (!bg || typeof bg !== 'object') return {};
  const type = bg.type || 'solid';

  if (type === 'gradient') {
    const css = buildSectionGradientBackground(bg);
    return css ? { backgroundImage: css } : {};
  }

  if (type === 'image' && bg.imageUrl) {
    const overlay = buildHeroOverlayBackground(bg);
    // backgroundImage layers must all be gradients/urls — a bare rgba() is not
    // a valid layer, so a solid wash is expressed as a flat two-stop gradient.
    // A null overlay ('none' style) means no wash layer at all.
    const overlayLayer = !overlay
      ? null
      : /^(linear|radial)-gradient/.test(overlay)
        ? overlay
        : `linear-gradient(${overlay}, ${overlay})`;
    const fp = bg.focalPoint || { x: 50, y: 50 };
    const fx = Number.isFinite(Number(fp.x)) ? Number(fp.x) : 50;
    const fy = Number.isFinite(Number(fp.y)) ? Number(fp.y) : 50;
    const url = String(bg.imageUrl).replace(/["\\\n\r]/g, '');
    const style = {
      backgroundImage: overlayLayer ? `${overlayLayer}, url("${url}")` : `url("${url}")`,
      backgroundSize: 'cover',
      backgroundPosition: `${fx}% ${fy}%`,
      backgroundRepeat: 'no-repeat',
    };
    // Base colour rendered beneath the image. background-color always paints
    // below every background-image layer, so a transparent image blends over
    // this colour for subtle effects.
    if (bg.solidColor) style.backgroundColor = bg.solidColor;
    return style;
  }

  // solid (default)
  return bg.solidColor ? { backgroundColor: bg.solidColor } : {};
}
