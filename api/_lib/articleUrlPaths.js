function slugify(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export const BUILTIN_ARTICLE_ALIASES = ['articles', 'blogs', 'insights', 'posts', 'stories'];

export async function getArticleUrlConfig(supabaseClient, tenantId) {
  let displayName = 'Articles';
  let legacyUrlSlug = null;

  try {
    const { data: settings } = await supabaseClient
      .from('system_settings')
      .select('setting_key, setting_value')
      .eq('tenant_id', tenantId)
      .in('setting_key', ['article_display_name', 'article_url_slug']);

    if (settings) {
      for (const s of settings) {
        if (s.setting_key === 'article_display_name' && s.setting_value) {
          displayName = s.setting_value;
        } else if (s.setting_key === 'article_url_slug' && s.setting_value) {
          legacyUrlSlug = s.setting_value;
        }
      }
    }
  } catch (err) {
    console.error('[ArticleUrlPaths] Error loading settings:', err);
  }

  const displaySlug = slugify(displayName);
  const isCustomDisplay = displayName.toLowerCase() !== 'articles' && displaySlug && displaySlug !== 'articles';

  const canonicalBaseSlug = isCustomDisplay ? displaySlug : 'articles';
  const canonicalBasePath = `/${canonicalBaseSlug}`;
  const canonicalListPath = isCustomDisplay ? `/${canonicalBaseSlug}` : '/PublicArticles';

  const aliasSet = new Set(BUILTIN_ARTICLE_ALIASES);
  aliasSet.add(canonicalBaseSlug);
  if (legacyUrlSlug) aliasSet.add(legacyUrlSlug.replace(/^\/+/, '').toLowerCase());

  const supportedBasePaths = Array.from(aliasSet)
    .filter(Boolean)
    .map(s => `/${s}`);

  return {
    displayName,
    canonicalBaseSlug,
    canonicalBasePath,
    canonicalListPath,
    supportedBasePaths,
    isCustomDisplay,
    legacyUrlSlug,
  };
}
