export const isListColor = value => value === null || (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value));

export function listAppearance(color) {
  if (!color || !isListColor(color)) return {};
  const rgb = [1, 3, 5].map(offset => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  return { backgroundColor: color, color: luminance > .179 ? '#000000' : '#ffffff' };
}
