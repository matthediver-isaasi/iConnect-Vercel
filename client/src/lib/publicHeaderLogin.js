// Login/member-area action styling shared by PublicHeader and inline
// member-only content prompts. Keeping the resolver in one place prevents
// microsite branding and button settings from drifting between the two.

const DEFAULT_LOGIN_BACKGROUND = '#5C0085';

function buildGradientFromStops(stops) {
  const valid = Array.isArray(stops)
    ? stops.filter((stop) => stop && typeof stop.color === 'string')
    : [];
  if (valid.length === 0) return DEFAULT_LOGIN_BACKGROUND;
  const sorted = [...valid].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  return `linear-gradient(to right, ${sorted.map((stop) => `${stop.color} ${Number(stop.position) || 0}%`).join(', ')})`;
}

/**
 * This intentionally mirrors PublicHeader's existing loginLink resolver.
 * `fallbackTextColor` is the color of the bar in which a plain-text action
 * appears; button labels continue to use their configured labelColor.
 */
export function resolvePublicHeaderLink(linkConfig, defaultLabel, fallbackTextColor = '#FFFFFF') {
  const asButton = !!linkConfig?.asButton;
  const background = linkConfig?.backgroundMode === 'gradient' &&
    Array.isArray(linkConfig?.gradientStops) &&
    linkConfig.gradientStops.length > 0
    ? buildGradientFromStops(linkConfig.gradientStops)
    : (linkConfig?.solidColor || DEFAULT_LOGIN_BACKGROUND);
  const buttonHeight = parseInt(linkConfig?.height, 10);
  const buttonWidth = parseInt(linkConfig?.width, 10);
  const buttonStyle = asButton
    ? {
        background,
        borderRadius: `${parseInt(linkConfig?.cornerRadius, 10) || 0}px`,
        borderWidth: `${parseInt(linkConfig?.borderWidth, 10) || 0}px`,
        borderStyle: linkConfig?.borderStyle || 'solid',
        borderColor: linkConfig?.borderColor || 'transparent',
        ...(buttonHeight > 0 ? { height: `${buttonHeight}px` } : {}),
        ...(buttonWidth > 0 ? { width: `${buttonWidth}px`, justifyContent: 'center' } : {}),
      }
    : {};
  const labelColor = (asButton && linkConfig?.labelColor) || fallbackTextColor;
  const label = typeof linkConfig?.label === 'string' && linkConfig.label.trim()
    ? linkConfig.label.trim()
    : defaultLabel;
  return { asButton, buttonStyle, labelColor, label };
}
