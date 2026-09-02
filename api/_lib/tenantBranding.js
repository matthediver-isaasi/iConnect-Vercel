import { mergeMicrositeConfig, micrositeBrandingValue } from './microsites.js';
import { resolveEffectiveCanvasFooter } from './canvasFooters.js';

/**
 * Build the public tenant-branding payload (the `branding` object returned by
 * /api/public/tenant-branding). When `microsite` is provided, the microsite's
 * header/footer/logo/branding overrides are merged over the tenant defaults —
 * any field the microsite leaves empty falls back to the tenant value.
 *
 * Shared by the branding endpoint and the SSR layer so the object the client
 * reads from the injected global is byte-identical to what it would otherwise
 * fetch (no second repaint when the real fetch lands).
 */
export function buildTenantBrandingPayload(tenantData, microsite = null, effectiveFooter = null) {
  const buttonStyles = tenantData.branding_config?.button_styles || {};

  const tenantSettings = tenantData.settings || {};
  const allowSearchIndexing = tenantSettings.allow_search_indexing === true;
  const ga4MeasurementId = tenantSettings.ga4_measurement_id || null;

  const headerConfig = microsite
    ? mergeMicrositeConfig(tenantData.header_config, microsite.header_config)
    : (tenantData.header_config || {});
  // Explicit inheritance means the main configured footer byte-for-byte, even
  // when a microsite retains an old configured override for later reuse.
  const footerConfig = microsite
    ? (microsite.footer_source === 'inherit'
      ? (tenantData.footer_config || {})
      : mergeMicrositeConfig(tenantData.footer_config, microsite.footer_config))
    : (tenantData.footer_config || {});

  const msBrand = (key) => micrositeBrandingValue(microsite, key);
  let brandingConfig = tenantData.branding_config || {};
  if (microsite) {
    const headerIconColor = msBrand('headerSocialIconColor');
    const footerIconColor = msBrand('footerSocialIconColor');
    // Task #2628: search-results page overrides (base font + type-label colour).
    // microsite value → tenant value falls out naturally: only splice when the
    // microsite overrides the key, otherwise the tenant value already present in
    // brandingConfig stands.
    const searchFont = msBrand('searchResultsFont');
    const searchTypeColor = msBrand('searchResultsTypeLabelColor');
    if (headerIconColor || footerIconColor || searchFont || searchTypeColor) {
      brandingConfig = {
        ...brandingConfig,
        ...(headerIconColor ? { headerSocialIconColor: headerIconColor } : {}),
        ...(footerIconColor ? { footerSocialIconColor: footerIconColor } : {}),
        ...(searchFont ? { searchResultsFont: searchFont } : {}),
        ...(searchTypeColor ? { searchResultsTypeLabelColor: searchTypeColor } : {}),
      };
    }
  }

  return {
    id: tenantData.id,
    name: tenantData.name,
    slug: tenantData.slug,
    logoUrl: (msBrand('logo_url') || microsite?.logo_url || tenantData.logo_url),
    headerLogoUrl: (msBrand('header_logo_url') || microsite?.logo_url || tenantData.header_logo_url),
    faviconUrl: tenantData.favicon_url,
    primaryColor: msBrand('primary_color') || tenantData.primary_color || '#5C0085',
    secondaryColor: msBrand('secondary_color') || tenantData.secondary_color,
    tagline: msBrand('tagline') || tenantData.tagline,
    description: msBrand('description') || tenantData.description || null,
    socialImageUrl: msBrand('social_image_url') || tenantData.social_image_url || null,
    headerConfig,
    footerConfig,
    footerSource: effectiveFooter?.source === 'canvas' ? 'canvas' : 'configured',
    canvasFooter: effectiveFooter?.source === 'canvas' ? effectiveFooter.footer : null,
    microsite: microsite ? {
      id: microsite.id,
      name: microsite.name,
      pathPrefix: microsite.path_prefix,
      logoUrl: microsite.logo_url || null,
      homePageId: microsite.home_page_id || null,
    } : null,
    brandingConfig,
    platformBranding: tenantData.platform_branding || { showPlatformBranding: true },
    buttonStyles: buttonStyles,
    allowSearchIndexing: allowSearchIndexing,
    ga4MeasurementId: ga4MeasurementId,
  };
}

/**
 * Async public/SSR entry point. Canvas footer resolution is kept beside the
 * legacy branding merge so both delivery paths make the same fallback choice.
 */
export async function resolveTenantBrandingPayload(tenantData, microsite = null) {
  const effectiveFooter = await resolveEffectiveCanvasFooter(tenantData, microsite);
  return buildTenantBrandingPayload(tenantData, microsite, effectiveFooter);
}
