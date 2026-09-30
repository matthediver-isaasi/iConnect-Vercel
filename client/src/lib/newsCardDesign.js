import { resolveCardAccentBar } from './cardAccentBar.js';

export const NEWS_CARD_SETTING_KEYS = {
  ctaRadius: 'news_card_cta_radius',
  dividerMode: 'news_card_image_divider_mode',
  dividerWeight: 'news_card_image_divider_weight',
  dividerColor: 'news_card_image_divider_color',
};

export const NEWS_CARD_CTA_RADIUS_MAX = 64;
export const NEWS_CARD_DIVIDER_WEIGHT_MAX = 12;
export const DEFAULT_NEWS_CARD_DIVIDER_WEIGHT = 3;

export function isValidNewsCardColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim());
}

function getSettingValue(settings, key) {
  if (!Array.isArray(settings)) return undefined;
  return settings.find((setting) => setting?.setting_key === key)?.setting_value;
}

function getBoundedInteger(value, { min, max }) {
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return null;
  return number;
}

export function resolveNewsCardDesign(settings, branding) {
  const inheritedDivider = resolveCardAccentBar(branding);
  const modeValue = getSettingValue(settings, NEWS_CARD_SETTING_KEYS.dividerMode);
  const dividerMode = ['show', 'hide'].includes(modeValue) ? modeValue : 'inherit';
  const ctaRadius = getBoundedInteger(
    getSettingValue(settings, NEWS_CARD_SETTING_KEYS.ctaRadius),
    { min: 0, max: NEWS_CARD_CTA_RADIUS_MAX },
  );
  const dividerWeight = getBoundedInteger(
    getSettingValue(settings, NEWS_CARD_SETTING_KEYS.dividerWeight),
    { min: 1, max: NEWS_CARD_DIVIDER_WEIGHT_MAX },
  ) ?? DEFAULT_NEWS_CARD_DIVIDER_WEIGHT;
  const storedColor = getSettingValue(settings, NEWS_CARD_SETTING_KEYS.dividerColor)?.trim();
  const dividerColor = isValidNewsCardColor(storedColor) ? storedColor : inheritedDivider.color;

  if (dividerMode === 'hide') {
    return {
      ctaRadius,
      divider: { enabled: false, color: dividerColor, weight: dividerWeight },
    };
  }

  if (dividerMode === 'show') {
    return {
      ctaRadius,
      divider: { enabled: true, color: dividerColor, weight: dividerWeight },
    };
  }

  return {
    ctaRadius,
    divider: {
      enabled: inheritedDivider.enabled,
      color: inheritedDivider.color,
      weight: DEFAULT_NEWS_CARD_DIVIDER_WEIGHT,
    },
  };
}