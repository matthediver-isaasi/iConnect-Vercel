const ACTION_PRESENTATIONS = new Set(['button', 'gradient_button']);

export function generatePublicHeaderButtonBackground(bgConfig, fallbackColor = '#3b82f6') {
  if (!bgConfig) return fallbackColor;
  if (bgConfig.type === 'solid') return bgConfig.solidColor || fallbackColor;
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
      'to right': 90,
      'to left': 270,
      'to bottom': 180,
      'to top': 0,
      'to bottom right': 135,
      'to bottom left': 225,
    };
    const angle = directionToAngle[bgConfig.gradientDirection] || 90;
    return `linear-gradient(${angle}deg, ${bgConfig.gradientStart} 0%, ${bgConfig.gradientEnd} 100%)`;
  }
  return fallbackColor;
}

export function getPublicHeaderButtonStyles(buttonStyleConfig) {
  if (!buttonStyleConfig) return null;
  const background = generatePublicHeaderButtonBackground(buttonStyleConfig.background || {}, '#3b82f6');
  const hover = buttonStyleConfig.hover || {};
  const hoverBackground = hover.type || hover.gradientStops || hover.gradientStart || hover.solidColor
    ? generatePublicHeaderButtonBackground(hover, background)
    : background;
  const border = buttonStyleConfig.border || {};
  const borderWidth = border.width ?? buttonStyleConfig.borderWidth ?? 0;
  const baseStyle = {
    borderWidth: borderWidth ? `${borderWidth}px` : '0',
    borderStyle: borderWidth ? (border.style || buttonStyleConfig.borderStyle || 'solid') : 'none',
    borderColor: border.color || buttonStyleConfig.borderColor || 'transparent',
    borderRadius: `${buttonStyleConfig.radius || 0}px`,
  };
  const textColor = buttonStyleConfig.textColor || '#FFFFFF';
  return {
    normal: { ...baseStyle, background, color: textColor },
    hover: {
      ...baseStyle,
      background: hoverBackground,
      color: buttonStyleConfig.hoverTextColor || textColor,
    },
  };
}

function collectNavigationItems(navigationItems) {
  const roots = Array.isArray(navigationItems)
    ? navigationItems
    : [
        ...(navigationItems?.topNav || []),
        ...(navigationItems?.mainNav || []),
      ];
  const collected = [];
  const seen = new Set();

  const visit = (item) => {
    if (!item || typeof item !== 'object') return;
    const identity = item.id == null ? item : `id:${String(item.id)}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    collected.push(item);
    if (Array.isArray(item.children)) item.children.forEach(visit);
  };

  roots.forEach(visit);
  return collected;
}

export function getPublicHeaderActionDestination(item) {
  if (!item) return null;
  const url = item.url || item.link_url;
  if (item.link_type === 'form_modal') {
    return item.form_slug
      ? { type: 'form', formSlug: item.form_slug }
      : null;
  }
  if (item.link_type === 'external') {
    return url
      ? {
          type: 'external',
          href: url,
          target: item.open_in_new_tab ? '_blank' : '_self',
          rel: item.open_in_new_tab ? 'noopener noreferrer' : undefined,
        }
      : null;
  }
  if (item.link_type === 'internal') {
    return url ? { type: 'internal', page: url } : null;
  }
  return null;
}

export function isEligiblePublicHeaderAction(item) {
  if (!getPublicHeaderActionDestination(item)) return false;
  return item.link_type === 'form_modal' ||
    item.display_type === 'button' ||
    ACTION_PRESENTATIONS.has(item.highlight_style);
}

/**
 * Returns public header actions which can be safely offered by a settings
 * selector. Input may be the flat public navigation response or PublicHeader's
 * `{ topNav, mainNav }` tree.
 */
export function getEligiblePublicHeaderActions(navigationItems) {
  return collectNavigationItems(navigationItems).filter(isEligiblePublicHeaderAction);
}

/**
 * Resolves a configured action for a guest surface. An explicit id selects any
 * eligible header action. With no id, auto-resolution is deliberately
 * conservative: exactly one eligible button named "Join" must exist.
 */
export function selectPublicHeaderAction(navigationItems, { navigationItemId } = {}) {
  const eligible = getEligiblePublicHeaderActions(navigationItems);
  if (navigationItemId !== undefined && navigationItemId !== null && navigationItemId !== '') {
    const requestedId = String(navigationItemId);
    return eligible.find((item) => String(item.id) === requestedId) || null;
  }

  const joinActions = eligible.filter(
    (item) => {
      const label = item.title ?? item.label;
      return typeof label === 'string' && label.trim().toLocaleLowerCase() === 'join';
    },
  );
  return joinActions.length === 1 ? joinActions[0] : null;
}
