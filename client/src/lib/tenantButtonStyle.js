// Shared tenant button-style resolution helpers.
//
// Two related feature areas use this module:
//   1. Branded shadcn-Button surfaces (e.g. pagination buttons) — the
//      "config-based" API: resolveTenantButtonStyle(branding, key),
//      resolveTenantButtonStyleValues(cfg), getTenantButtonStyleCss(cfg).
//   2. Canvas blocks and content-card CTA buttons — the "variant-based" API:
//      resolveTenantButtonStyle(variant, branding), isTenantButtonVariant,
//      bgCssFromConfig, buildTenantButtonInlineStyle, TENANT_BUTTON_DEFAULT_SIZE.
//
// The variant-based helpers were originally defined privately inside the Canvas
// block registry (`client/src/components/canvas/blocks/registry.jsx`) and are
// extracted here so the same tenant Primary/Secondary styling can be reused
// outside Canvas (content-card CTAs) without dragging in the whole registry.
// Keep these behaviourally identical to the Canvas versions — the registry now
// imports from this module, so any change here affects Canvas blocks too.
//
// The button-style slots themselves are produced by the Button Style Creator
// and stored on `branding_config.button_styles.{primary,secondary,...}`.

// Build a CSS `background` string from a background-config object. Supports the
// solid form, the multi-stop `gradientStops` form, and the legacy
// `gradientStart`/`gradientEnd` form. Used by the config-based API.
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

// Default size for tenant button variants — matches the `lg` canvas button
// dimensions (h-10 px-5 text-base) so a tenant whose stored
// `button_styles.{primary,secondary}` has no `size` block still renders at
// sensible CTA proportions.
export const TENANT_BUTTON_DEFAULT_SIZE = {
  paddingX: 20,
  paddingY: 8,
  fontSize: 16,
  iconSize: 18,
};

// Compute a CSS background style object from a button_styles bg/hover config
// (the shape produced by the Button Style Creator at `/ButtonElements`).
// Returns null when the config is missing so callers can fall back to a
// default.
export function bgCssFromConfig(bgConfig) {
  if (!bgConfig) return null;
  // Explicit transparent type — no fill, regardless of any stale
  // `solidColor` / `gradientStops` left on the object.
  if (bgConfig.type === 'transparent') {
    return { backgroundColor: 'transparent' };
  }
  if (bgConfig.type === 'solid') {
    return { backgroundColor: bgConfig.solidColor || 'transparent' };
  }
  const stops = bgConfig.gradientStops;
  if (Array.isArray(stops) && stops.length >= 2) {
    const angle = bgConfig.gradientAngle ?? 90;
    const parts = [...stops]
      .sort((a, b) => a.position - b.position)
      .map((s) => `${s.color} ${s.position}%`)
      .join(', ');
    return { background: `linear-gradient(${angle}deg, ${parts})` };
  }
  if (bgConfig.gradientStart && bgConfig.gradientEnd) {
    return {
      background: `linear-gradient(90deg, ${bgConfig.gradientStart} 0%, ${bgConfig.gradientEnd} 100%)`,
    };
  }
  if (bgConfig.solidColor) {
    return { backgroundColor: bgConfig.solidColor };
  }
  return null;
}

// Resolve a tenant button-style slot from a branding payload. Supports BOTH
// historical call shapes so existing callers keep working:
//   - config-based:  resolveTenantButtonStyle(branding, key = 'primary')
//                    (used by pagination / shadcn-Button surfaces)
//   - variant-based: resolveTenantButtonStyle(variant, branding)
//                    where variant is 'tenant-primary' / 'tenant-secondary' /
//                    'tenant:<key>' (used by Canvas blocks + content-card CTAs)
// Disambiguated by the type of the first argument: a string is the variant
// form, anything else (object/null) is the branding form.
export function resolveTenantButtonStyle(arg1, arg2) {
  let branding;
  let key;

  if (typeof arg1 === 'string') {
    // Variant form: (variant, branding)
    const variant = arg1;
    branding = arg2;
    if (variant === 'tenant-primary') key = 'primary';
    else if (variant === 'tenant-secondary') key = 'secondary';
    else if (variant.startsWith('tenant:')) key = variant.slice('tenant:'.length);
    else return null;
  } else {
    // Config form: (branding, key)
    branding = arg1;
    key = arg2 || 'primary';
  }

  if (!key) return null;
  // `buttonStyles` is the flat field exposed by /api/public/tenant-branding;
  // older payloads expose it nested as `brandingConfig.button_styles`.
  const styles =
    branding?.buttonStyles ||
    branding?.brandingConfig?.button_styles ||
    null;
  if (!styles) return null;
  return styles[key] || null;
}

// True for any variant that should be rendered via the inline-style tenant
// button path (legacy `tenant-primary` / `tenant-secondary` plus the
// free-form `tenant:<key>` form).
export function isTenantButtonVariant(variant) {
  return (
    variant === 'tenant-primary' ||
    variant === 'tenant-secondary' ||
    (typeof variant === 'string' && variant.startsWith('tenant:'))
  );
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

// Build the inline style object for a tenant button style. Mirrors the tenant
// path in the Canvas Hero CTA button: background/hover, text colour, radius,
// border, and (optionally) padding + font size from the style's size block.
// `applySize: false` keeps the caller's own sizing (e.g. fixed square icon
// buttons) while still applying colour/border/radius.
export function buildTenantButtonInlineStyle(style, { hovered = false, applySize = true } = {}) {
  if (!style) return {};
  const baseline = { ...TENANT_BUTTON_DEFAULT_SIZE, ...(style.size || {}) };
  const bg = bgCssFromConfig(hovered ? style.hover : style.background) || {};
  const border = style.border || {};
  const textColor = hovered
    ? style.hoverTextColor || style.textColor || '#ffffff'
    : style.textColor || '#ffffff';
  const inline = {
    ...bg,
    color: textColor,
    borderRadius: `${style.radius ?? 6}px`,
    border:
      border.width > 0
        ? `${border.width}px ${border.style || 'solid'} ${border.color || '#000000'}`
        : 'none',
    transition: 'background-color 0.2s ease, color 0.2s ease, background 0.2s ease',
  };
  if (applySize) {
    inline.paddingTop = baseline.paddingY;
    inline.paddingBottom = baseline.paddingY;
    inline.paddingLeft = baseline.paddingX;
    inline.paddingRight = baseline.paddingX;
    inline.fontSize = baseline.fontSize;
    inline.lineHeight = 1;
  }
  return inline;
}
