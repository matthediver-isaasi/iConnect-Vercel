const EMBEDDED_TENANT_FOOTER_CLASS = 'tenant-email-footer';

function normalizeDesign(designJson) {
  if (!designJson) return null;
  if (typeof designJson === 'string') {
    try {
      const parsed = JSON.parse(designJson);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof designJson === 'object' ? designJson : null;
}

function blocksContainType(blocks, type) {
  if (!Array.isArray(blocks)) return false;
  return blocks.some((block) => {
    if (!block || typeof block !== 'object') return false;
    if (block.type === type) return true;
    if (blocksContainType(block.children, type)) return true;
    return Array.isArray(block.columns)
      && block.columns.some((column) => blocksContainType(column?.blocks, type));
  });
}

// The visual builder emits this class on the MJML section containing a
// configured tenant footer. Match the generated structural marker only; footer
// wording is tenant-controlled and must never be used to infer its presence.
export function hasEmbeddedTenantFooter(html) {
  if (typeof html !== 'string' || !html) return false;
  const classAttributes = html.match(/\bclass\s*=\s*(?:"[^"]*"|'[^']*')/gi) || [];
  return classAttributes.some((attribute) => {
    const value = attribute.replace(/^[^=]*=\s*["']|["']$/g, '');
    return value.split(/\s+/).includes(EMBEDDED_TENANT_FOOTER_CLASS);
  });
}

export function getCampaignEmailComposition(campaign = {}) {
  const design = normalizeDesign(campaign.design_json);
  const hasUnsubscribeBlock = blocksContainType(design?.blocks, 'unsubscribe');
  const embeddedTenantFooter = hasEmbeddedTenantFooter(campaign.html_content);

  return {
    skipFooter: hasUnsubscribeBlock || embeddedTenantFooter,
    hasUnsubscribeBlock,
    hasEmbeddedTenantFooter: embeddedTenantFooter,
    contentWidth: design?.globalStyles?.contentWidth || null,
    slotValues: design?.slotValues && typeof design.slotValues === 'object'
      ? design.slotValues
      : null,
    hiddenSlots: Array.isArray(design?.hiddenSlots) && design.hiddenSlots.length > 0
      ? design.hiddenSlots.filter((token) => typeof token === 'string')
      : null,
    richSlots: Array.isArray(design?.richSlots) && design.richSlots.length > 0
      ? design.richSlots.filter((token) => typeof token === 'string')
      : null,
  };
}

const PREFERENCE_TOKEN_SOURCE = '\\{\\{\\s*(unsubscribe|communication_preferences)_(link|url)\\s*\\}\\}';
const PREFERENCE_TOKEN_RE = new RegExp(PREFERENCE_TOKEN_SOURCE, 'gi');
const STANDALONE_PREFERENCE_TOKEN_RE = new RegExp(`^\\s*${PREFERENCE_TOKEN_SOURCE}\\s*$`, 'i');

export function isStandaloneCampaignPreferencePlaceholder(value) {
  return typeof value === 'string' && STANDALONE_PREFERENCE_TOKEN_RE.test(value);
}

export function resolveCampaignPreferenceTokens(value, preferencesUrl, { renderer } = {}) {
  if (typeof value !== 'string' || !value || !preferencesUrl) {
    return { value, hadToken: false, hasUsableDestination: false };
  }
  const hadToken = PREFERENCE_TOKEN_RE.test(value);
  PREFERENCE_TOKEN_RE.lastIndex = 0;
  if (!hadToken) {
    return { value, hadToken: false, hasUsableDestination: false };
  }
  if (typeof renderer !== 'function') {
    throw new TypeError('Campaign preference resolution requires a trusted context renderer');
  }
  const resolved = renderer(value, preferencesUrl);
  return { ...resolved, hadToken };
}

export function campaignPreferenceFallback(preferencesUrl) {
  return `<p style="margin-top: 20px; font-size: 12px; color: #666; text-align: center;">
        <a href="${preferencesUrl}" style="color: #666;">Manage email preferences</a>
      </p>`;
}