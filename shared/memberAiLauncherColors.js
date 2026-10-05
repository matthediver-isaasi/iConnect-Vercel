export const MEMBER_AI_HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Text-only overrides must not opt the launcher into custom-background styling.
export function resolveMemberAiLauncherStyle({ backgroundColor, textColor } = {}) {
  const text = typeof textColor === "string" && MEMBER_AI_HEX_COLOR.test(textColor) ? textColor : "";
  if (typeof backgroundColor !== "string" || !MEMBER_AI_HEX_COLOR.test(backgroundColor)) {
    return text ? { color: text } : undefined;
  }
  const channels = [1, 3, 5].map(index => parseInt(backgroundColor.slice(index, index + 2), 16) / 255);
  const luminance = channels.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const light = luminance > 0.179;
  const hoverColor = `#${channels.map(v => {
    const original = Math.round(v * 255);
    return Math.round(original * 0.88 + (light ? 0 : 255 * 0.12)).toString(16).padStart(2, "0");
  }).join("")}`;
  return { "--ai-bg": backgroundColor, color: text || (light ? "#111827" : "#ffffff"), "--ai-hover": hoverColor };
}
