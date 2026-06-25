// Shared resolution of a tenant "button style" (the Button Style Creator slots
// stored on `branding_config.button_styles.{primary,secondary,...}`) into plain
// CSS values. Mirrors the resolution used by the canvas block renderer and the
// public header so a tenant's Primary button style can be reused elsewhere
// (e.g. branded pagination buttons) without duplicating the parsing logic.

// Build a CSS `background` value from a background-config object. Supports the
// solid form, the multi-stop `gradientStops` form, and the legacy
// `gradientStart`/`gradientEnd` form.
function backgroundCss(bgConfig, fallbackColor) {
  if (!bgConfig) return fallbackColor;

  if (bgConfig.type === 'solid') {
    return bgConfig.solidColor || fallbackColor;
  }

  if (Array.isArray(bgConfig.gradientStops) && bgConfig.gradientStops.length >= 2) {
    const angle = bgConfig.gradientAngle ?? 90;
    const stops = [...bgConfig.gradientStops]
      .sort((a, b) => a.position - b.position)
      .map((stop) => `${stop.color} ${stop.position}%`)
      .join(', ');
    return `linear-gradient(${angle}deg, ${stops})`;
  }

  if (bgConfig.gradientStart && bgConfig.gradientEnd) {
    const directionToAngle = {
      'to right': 90, 'to left': 270, 'to bottom': 180,
      'to top': 0, 'to bottom right': 135, 'to bottom left': 225,
    };
    const angle = directionToAngle[bgConfig.gradientDirection] || 90;
    return `linear-gradient(${angle}deg, ${bgConfig.gradientStart} 0%, ${bgConfig.gradientEnd} 100%)`;
  }

  if (bgConfig.solidColor) return bgConfig.solidColor;

  return fallbackColor;
}

// Resolve a tenant button-style slot from a branding payload. Accepts the flat
// `buttonStyles` field (exposed by /api/public/tenant-branding) and the nested
// `brandingConfig.button_styles` fallback used by older payloads.
export function resolveTenantButtonStyle(branding, key = 'primary') {
  const styles =
    branding?.buttonStyles ||
    branding?.brandingConfig?.button_styles ||
    null;
  if (!styles) return null;
  return styles[key] || null;
}

// Resolve a button-style config object into the primitive CSS values needed to
// paint a button (normal + hover). Returns null when no config is supplied so
// callers can keep their existing default appearance.
export function resolveTenantButtonStyleValues(cfg) {
  if (!cfg) return null;

  const fallback = '#3b82f6';
  const background = backgroundCss(cfg.background || {}, fallback);

  const hover = cfg.hover || {};
  const hasHover = hover && (hover.type || hover.gradientStops || hover.gradientStart || hover.solidColor);
  const hoverBackground = hasHover ? backgroundCss(hover, background) : background;

  const textColor = cfg.textColor || '#FFFFFF';
  const hoverTextColor = cfg.hoverTextColor || textColor;

  const border = cfg.border || {};
  const borderWidth = border.width ?? cfg.borderWidth ?? 0;
  const borderStyle = border.style || cfg.borderStyle || 'solid';
  const borderColor = border.color || cfg.borderColor || 'transparent';

  const radius = cfg.radius ?? 0;

  return {
    background,
    color: textColor,
    hoverBackground,
    hoverColor: hoverTextColor,
    radius,
    borderWidth,
    borderStyle,
    borderColor,
  };
}

// Build React inline-style objects (normal + hover) from a button-style config.
// Used by the shadcn-Button-based pagination controls. Returns null when no
// config is supplied.
export function getTenantButtonStyleCss(cfg) {
  const v = resolveTenantButtonStyleValues(cfg);
  if (!v) return null;

  const base = {
    borderWidth: v.borderWidth ? `${v.borderWidth}px` : '0',
    borderStyle: v.borderWidth ? v.borderStyle : 'none',
    borderColor: v.borderColor,
    borderRadius: `${v.radius}px`,
  };

  return {
    normal: { ...base, background: v.background, color: v.color },
    hover: { ...base, background: v.hoverBackground, color: v.hoverColor },
  };
}
