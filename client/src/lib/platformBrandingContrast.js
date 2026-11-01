import { contrastRatio } from './canvasA11y.js';

export const DEFAULT_PLATFORM_TEXT_COLOR = '#94a3b8';

export function platformBrandingTextColor(branding) {
  const background = branding?.backgroundColor || '#000000';
  const configured = branding?.textColor || DEFAULT_PLATFORM_TEXT_COLOR;
  const ratio = contrastRatio(configured, background);
  // Unknown CSS colours cannot be judged by this parser.
  if (ratio == null || ratio >= 4.5) return configured;
  return [DEFAULT_PLATFORM_TEXT_COLOR, '#475569', '#ffffff', '#000000']
    .find(color => contrastRatio(color, background) >= 4.5) || configured;
}
