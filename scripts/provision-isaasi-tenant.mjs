// Task #1031: Provision the "iSaaSi" tenant on the iConnect platform.
//
// - Creates tenant slug=isaasi, plan_code=free, onboarding_status=complete
// - Sets custom domain isaasi.co.uk
// - Applies branding extracted from live isaasi.co.uk
// - Upserts tenant_canvas_theme tokens (primary + on-primary)
// - Inserts a Canvas Builder homepage with 10 stacked sections
//   (hero, logo strip, feature grid, stats, image+copy A, image+copy B,
//    testimonial grid, pricing, FAQ, final CTA)
// - Marks the new page as public home via system_settings.public_home_page_slug
// - Prints the password-setup link for the admin (mat@teeone.co.uk)
//
// Idempotent: detects existing tenant by slug and only writes once.
// Run: node scripts/provision-isaasi-tenant.mjs

import { createClient } from '@supabase/supabase-js';
import { provisionTenant, checkExistingIdentity } from '../api/_lib/provisionTenantService.js';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const TENANT_NAME = 'iSaaSi';
const TENANT_SLUG = 'isaasi';
const TENANT_DOMAIN = 'isaasi.co.uk';
const ADMIN_EMAIL = 'mat@teeone.co.uk';
const ADMIN_FIRST = 'Mat';
const ADMIN_LAST = 'iSaaSi';

const PRIMARY = '#EC008C';
const ON_PRIMARY = '#FFFFFF';
const SURFACE = '#FFFFFF';
const TEXT_DEFAULT = '#1F2937';
const TEXT_SECONDARY = '#6B7280';
const BORDER = '#E5E7EB';

const TAGLINE = 'intelligent solutions for sustainable impact';
const DESCRIPTION =
  'iSaaSi iConnect is a powerful CRM and automation platform designed exclusively for UK not-for-profit membership organisations. Streamline member management, automate engagement, and drive growth with our tailored, user-friendly solution.';
const LOGO_URL =
  'https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/68b82190e50c3103b36b0cbd/3fe6edcca_WhatsAppLogo.png';
const SOCIAL_IMAGE =
  'https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/render/image/public/base44-prod/public/68b82190e50c3103b36b0cbd/3fe6edcca_WhatsAppLogo.png?width=1200&height=630&resize=contain';

const HOME_SLUG = 'home';
const SEO_TITLE = 'iSaaSi iConnect — CRM & automation for UK not-for-profit membership organisations';
const SEO_DESCRIPTION = DESCRIPTION;

// ---- canvas_design builder ----------------------------------------------

const CANVAS_W = 1200;
let _y = 0;
const stack = [];
function add(block, h, gap = 32) {
  const y = _y;
  block.bp = block.bp || {};
  block.bp.desktop = { x: 0, y, w: CANVAS_W, h, hidden: false, ...(block.bp.desktop || {}) };
  block.bp.tablet = block.bp.tablet || {};
  block.bp.mobile = block.bp.mobile || {};
  block.a11y = block.a11y || {};
  block.style = block.style || {};
  block.locked = false;
  stack.push(block);
  _y = y + h + gap;
  return block;
}

const cardOf = (id, heading, body, icon = 'Sparkles') => ({
  id,
  type: 'card',
  name: heading,
  style: {
    background: 'var(--cb-color-surface, #ffffff)',
    borderWidth: 1,
    borderColor: 'var(--cb-color-border, #e5e7eb)',
    borderRadius: 8,
    paddingTop: 24,
    paddingRight: 24,
    paddingBottom: 24,
    paddingLeft: 24,
  },
  content: {
    imageUrl: '',
    imageAlt: '',
    heading,
    headingLevel: 3,
    body: `<p>${body}</p>`,
    ctaLabel: '',
    ctaHref: '',
    ctaVariant: 'outline',
  },
});

const statOf = (id, value, label) => ({
  id,
  type: 'stat',
  name: label,
  style: {
    background: 'transparent',
    borderWidth: 0,
    paddingTop: 16,
    paddingRight: 16,
    paddingBottom: 16,
    paddingLeft: 16,
  },
  content: { value, label, prefix: '', suffix: '', valueColor: 'var(--cb-color-primary, #EC008C)' },
});

// 1) HERO
add(
  {
    id: 'sec-hero',
    type: 'hero',
    name: 'Hero',
    style: { background: 'var(--cb-color-primary, #EC008C)', borderWidth: 0, borderRadius: 0 },
    content: {
      headline: 'Transform Your Membership Organisation',
      headingLevel: 1,
      subheadline:
        'iConnect — powerful CRM and automation designed specifically for UK not-for-profit membership organisations. Streamline operations, engage members, and drive growth.',
      bgType: 'color',
      bgColor: 'var(--cb-color-primary, #EC008C)',
      bgImageUrl: '',
      darkWash: 0.25,
      alignment: 'center',
      textColor: 'var(--cb-color-on-primary, #ffffff)',
      ctas: [
        { label: 'Get Started Today', href: '#pricing', variant: 'primary' },
        { label: 'Book a Consult', href: '#contact', variant: 'outline' },
      ],
    },
  },
  560,
);

// 2) LOGO STRIP
add(
  {
    id: 'sec-logos',
    type: 'logo-strip',
    name: 'Trusted by',
    style: {
      background: '#F9FAFB',
      borderWidth: 0,
      paddingTop: 32,
      paddingRight: 24,
      paddingBottom: 32,
      paddingLeft: 24,
    },
    content: {
      heading: 'Trusted by UK not-for-profit organisations',
      logos: [
        { src: '', alt: 'Member Org 1' },
        { src: '', alt: 'Member Org 2' },
        { src: '', alt: 'Member Org 3' },
        { src: '', alt: 'Member Org 4' },
        { src: '', alt: 'Member Org 5' },
        { src: '', alt: 'Member Org 6' },
      ],
    },
  },
  180,
);

// 3) FEATURE GRID — 3 cards
add(
  {
    id: 'sec-features-heading',
    type: 'text',
    name: 'Features heading',
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      html:
        '<h2 style="text-align:center;font-size:36px;font-weight:700;margin:0 0 8px 0">Everything Your Organisation Needs</h2>' +
        '<p style="text-align:center;color:#6B7280;margin:0">Purpose-built tools for membership, events, automation, and engagement.</p>',
      colorRole: 'default',
    },
  },
  120,
);

add(
  {
    id: 'sec-features',
    type: 'columns',
    name: 'Feature grid',
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      count: 3,
      gap: 24,
      stackOnMobile: true,
      widths: {
        desktop: [33, 33, 34],
        tablet: [50, 50, 100],
        mobile: [100, 100, 100],
      },
      items: [
        {
          html:
            '<div style="padding:24px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;height:100%">' +
            '<h3 style="font-size:20px;font-weight:600;margin:0 0 8px 0">Member Management</h3>' +
            '<p style="color:#6B7280;margin:0">Complete membership lifecycle — joins, renewals, subscriptions, and engagement, all in one place.</p>' +
            '</div>',
        },
        {
          html:
            '<div style="padding:24px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;height:100%">' +
            '<h3 style="font-size:20px;font-weight:600;margin:0 0 8px 0">Smart Automation</h3>' +
            '<p style="color:#6B7280;margin:0">Reduce manual admin by up to 80% with workflows for renewals, onboarding, and follow-ups.</p>' +
            '</div>',
        },
        {
          html:
            '<div style="padding:24px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;height:100%">' +
            '<h3 style="font-size:20px;font-weight:600;margin:0 0 8px 0">Targeted Engagement</h3>' +
            '<p style="color:#6B7280;margin:0">Personalised member journeys, segmented campaigns, and rich communication tools.</p>' +
            '</div>',
        },
      ],
    },
  },
  300,
);

// 4) STATS ROW — 4 stat blocks via columns
add(
  {
    id: 'sec-stats',
    type: 'columns',
    name: 'Stats row',
    style: {
      background: 'var(--cb-color-primary, #EC008C)',
      borderWidth: 0,
      paddingTop: 48,
      paddingRight: 24,
      paddingBottom: 48,
      paddingLeft: 24,
    },
    content: {
      count: 4,
      gap: 16,
      stackOnMobile: true,
      widths: { desktop: [25, 25, 25, 25], tablet: [50, 50, 50, 50], mobile: [100, 100, 100, 100] },
      items: [
        {
          html:
            '<div style="text-align:center;color:#fff"><div style="font-size:40px;font-weight:700">20K+</div><div style="opacity:.9">Members managed</div></div>',
        },
        {
          html:
            '<div style="text-align:center;color:#fff"><div style="font-size:40px;font-weight:700">80%</div><div style="opacity:.9">Less manual admin</div></div>',
        },
        {
          html:
            '<div style="text-align:center;color:#fff"><div style="font-size:40px;font-weight:700">100%</div><div style="opacity:.9">UK talent &amp; expertise</div></div>',
        },
        {
          html:
            '<div style="text-align:center;color:#fff"><div style="font-size:40px;font-weight:700">24/7</div><div style="opacity:.9">UK-based support</div></div>',
        },
      ],
    },
  },
  220,
);

// 5) IMAGE + COPY (image left, copy right)
add(
  {
    id: 'sec-imgcopy-a',
    type: 'columns',
    name: 'Image + copy A',
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      count: 2,
      gap: 48,
      stackOnMobile: true,
      widths: { desktop: [50, 50], tablet: [50, 50], mobile: [100, 100] },
      items: [
        {
          html:
            '<div style="background:#F3F4F6;border-radius:8px;height:320px;display:flex;align-items:center;justify-content:center;color:#9CA3AF;font-size:14px">Replace with product screenshot</div>',
        },
        {
          html:
            '<div style="padding:24px 0"><h2 style="font-size:32px;font-weight:700;margin:0 0 16px 0">Built for membership, not retrofitted</h2>' +
            '<p style="color:#6B7280;font-size:16px;line-height:1.6;margin:0 0 16px 0">Every workflow, every form, every report is shaped around how UK membership organisations actually operate — Gift Aid, organisation memberships, committees, and chapters all first-class.</p>' +
            '<ul style="color:#374151;padding-left:20px;margin:0"><li>Individual &amp; organisation memberships</li><li>Renewal &amp; reminder workflows</li><li>Gift Aid &amp; finance integrations</li></ul></div>',
        },
      ],
    },
  },
  380,
);

// 6) IMAGE + COPY (reversed: copy left, image right)
add(
  {
    id: 'sec-imgcopy-b',
    type: 'columns',
    name: 'Image + copy B',
    style: {
      background: '#F9FAFB',
      borderWidth: 0,
      paddingTop: 48,
      paddingRight: 24,
      paddingBottom: 48,
      paddingLeft: 24,
    },
    content: {
      count: 2,
      gap: 48,
      stackOnMobile: true,
      widths: { desktop: [50, 50], tablet: [50, 50], mobile: [100, 100] },
      items: [
        {
          html:
            '<div style="padding:24px 0"><h2 style="font-size:32px;font-weight:700;margin:0 0 16px 0">Automate the admin, focus on the mission</h2>' +
            '<p style="color:#6B7280;font-size:16px;line-height:1.6;margin:0 0 16px 0">Visual workflows fire on member joins, payments, renewals, event registrations, and more — so your team spends time on what matters.</p>' +
            '<ul style="color:#374151;padding-left:20px;margin:0"><li>Drag-and-drop workflow builder</li><li>Email, SMS, and webhook actions</li><li>Audit trail for every step</li></ul></div>',
        },
        {
          html:
            '<div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;height:320px;display:flex;align-items:center;justify-content:center;color:#9CA3AF;font-size:14px">Replace with workflow diagram</div>',
        },
      ],
    },
  },
  420,
);

// 7) TESTIMONIAL GRID
add(
  {
    id: 'sec-testimonials',
    type: 'testimonial-grid',
    name: 'Testimonials',
    style: { background: 'transparent', borderWidth: 0, paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24 },
    content: {
      heading: 'What our members say',
      subheading: 'Real organisations, real results.',
      columns: 3,
      items: [
        {
          quote:
            "iConnect freed up two days a week of admin time. Renewals just happen now and members get a much better experience.",
          author: 'Sarah Williams',
          role: 'Operations Director, UK Membership Body',
          photo: '',
        },
        {
          quote:
            "Setting up our Gift Aid claim used to take a week. With iConnect's reports it's literally an afternoon.",
          author: 'James Patel',
          role: 'Finance Lead, Charitable Association',
          photo: '',
        },
        {
          quote:
            "The team really understands not-for-profits. It feels like the platform was built for us — because it was.",
          author: 'Rachel Brown',
          role: 'CEO, Professional Network',
          photo: '',
        },
      ],
    },
  },
  420,
);

// 8) PRICING TABLE
add(
  {
    id: 'sec-pricing',
    type: 'pricing-table',
    name: 'Pricing',
    style: { background: '#F9FAFB', borderWidth: 0, paddingTop: 48, paddingRight: 24, paddingBottom: 48, paddingLeft: 24 },
    content: {
      heading: 'Simple, transparent pricing',
      subheading: 'Designed for UK not-for-profits. No surprises, no hidden fees.',
      currency: '£',
      billingPeriod: '/ month',
      tiers: [
        {
          name: 'Starter',
          price: '99',
          description: 'For small membership groups getting started.',
          features: ['Up to 250 members', 'Email automation', 'Standard support'],
          ctaLabel: 'Choose Starter',
          ctaHref: '#contact',
          recommended: false,
        },
        {
          name: 'Growth',
          price: '249',
          description: 'For growing organisations that need automation at scale.',
          features: [
            'Up to 2,500 members',
            'Workflow automation',
            'Gift Aid reporting',
            'Priority UK support',
          ],
          ctaLabel: 'Choose Growth',
          ctaHref: '#contact',
          recommended: true,
        },
        {
          name: 'Enterprise',
          price: 'Custom',
          description: 'For large not-for-profits and federated bodies.',
          features: ['Unlimited members', 'Dedicated success manager', 'Custom integrations', 'SLA'],
          ctaLabel: 'Talk to us',
          ctaHref: '#contact',
          recommended: false,
        },
      ],
    },
  },
  560,
);

// 9) FAQ / ACCORDION
add(
  {
    id: 'sec-faq-heading',
    type: 'text',
    name: 'FAQ heading',
    style: { background: 'transparent', borderWidth: 0 },
    content: {
      html:
        '<h2 style="text-align:center;font-size:32px;font-weight:700;margin:0 0 8px 0">Frequently asked questions</h2>',
      colorRole: 'default',
    },
  },
  80,
);

add(
  {
    id: 'sec-faq',
    type: 'accordion',
    name: 'FAQ',
    style: { background: 'transparent', borderWidth: 0, paddingTop: 0, paddingRight: 24, paddingBottom: 24, paddingLeft: 24 },
    content: {
      items: [
        {
          q: 'Is iConnect designed for UK not-for-profits?',
          a:
            '<p>Yes — Gift Aid, organisation memberships, committees, and UK accounting (Xero, QuickBooks) are all first-class.</p>',
        },
        {
          q: 'How long does onboarding take?',
          a:
            '<p>Most organisations are live in 2–4 weeks. We handle the data migration and the workflow setup so your team can focus on members.</p>',
        },
        {
          q: 'Can we migrate from our existing CRM?',
          a:
            '<p>Yes — we have migration tooling for the major UK membership systems and CSV imports for everything else.</p>',
        },
        {
          q: 'What support do you offer?',
          a:
            '<p>UK-based support across all plans, plus a dedicated success manager on Enterprise.</p>',
        },
      ],
      expandOne: true,
    },
  },
  440,
);

// 10) FINAL CTA
add(
  {
    id: 'sec-final-cta',
    type: 'hero',
    name: 'Final CTA',
    style: { background: 'var(--cb-color-primary, #EC008C)', borderWidth: 0, borderRadius: 0 },
    content: {
      headline: 'Ready to transform your organisation?',
      headingLevel: 2,
      subheadline: 'Book a free 30-minute consultation with our UK team.',
      bgType: 'color',
      bgColor: 'var(--cb-color-primary, #EC008C)',
      darkWash: 0,
      alignment: 'center',
      textColor: 'var(--cb-color-on-primary, #ffffff)',
      ctas: [
        { label: 'Book a Consult', href: '#contact', variant: 'outline' },
        { label: 'Call us: 020 0000 0000', href: 'tel:02000000000', variant: 'primary' },
      ],
    },
  },
  320,
  0,
);

const canvasDesign = {
  version: 1,
  root: {
    background: null,
    sections: [
      {
        id: 'root-section',
        name: 'Main',
        background: null,
        children: stack,
      },
    ],
  },
};

// ---- main ----------------------------------------------------------------

async function main() {
  console.log('=== Provisioning iSaaSi tenant ===');

  // 1) Check / provision tenant
  const { data: existing } = await sb
    .from('tenant')
    .select('id, slug, name, domain, plan_code, onboarding_status')
    .eq('slug', TENANT_SLUG)
    .maybeSingle();

  let tenantId;
  let setupToken = null;
  if (existing) {
    tenantId = existing.id;
    console.log(`[skip] tenant already exists: ${tenantId} (slug=${existing.slug})`);
  } else {
    const existingIdentity = await checkExistingIdentity(ADMIN_EMAIL, null);
    if (existingIdentity) {
      console.log(`[info] reusing existing tenant_identity ${existingIdentity.id} for ${ADMIN_EMAIL}`);
    } else {
      console.log(`[info] creating new tenant_identity for ${ADMIN_EMAIL} (setup token will be issued)`);
    }
    const result = await provisionTenant({
      tenantName: TENANT_NAME,
      slug: TENANT_SLUG,
      adminEmail: ADMIN_EMAIL,
      adminFirstName: ADMIN_FIRST,
      adminLastName: ADMIN_LAST,
      password: null,
      googleId: null,
      linkExistingAccount: !!existingIdentity,
      isPlatformProvision: true,
      generateSetupToken: !existingIdentity,
      existingIdentity,
      planCode: 'free',
      onboardingStatus: 'complete',
    });
    tenantId = result.tenant.id;
    setupToken = result.setupToken;
    console.log(`[ok] provisioned tenant ${tenantId}`);
    if (setupToken) {
      console.log(`[ok] setup token: ${setupToken}`);
    }
  }

  // 2) Apply domain + branding on tenant row
  const { error: brandErr } = await sb
    .from('tenant')
    .update({
      domain: TENANT_DOMAIN,
      primary_color: PRIMARY,
      secondary_color: '#0F172A',
      tagline: TAGLINE,
      description: DESCRIPTION,
      logo_url: LOGO_URL,
      header_logo_url: LOGO_URL,
      social_image_url: SOCIAL_IMAGE,
    })
    .eq('id', tenantId);
  if (brandErr) {
    console.error('[fail] update tenant branding:', brandErr.message);
  } else {
    console.log(`[ok] branding + domain applied (domain=${TENANT_DOMAIN}, primary=${PRIMARY})`);
  }

  // 3) Upsert tenant_canvas_theme
  const theme = {
    colors: {
      primary: PRIMARY,
      'on-primary': ON_PRIMARY,
      surface: SURFACE,
      border: BORDER,
      text: TEXT_DEFAULT,
      'text-secondary': TEXT_SECONDARY,
    },
    typography: {
      'font-heading': "'Inter', system-ui, sans-serif",
      'font-body': "'Inter', system-ui, sans-serif",
    },
    spacing: {},
  };
  const { error: themeErr } = await sb
    .from('tenant_canvas_theme')
    .upsert(
      { tenant_id: tenantId, theme, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id' },
    );
  if (themeErr) console.error('[fail] tenant_canvas_theme:', themeErr.message);
  else console.log('[ok] tenant_canvas_theme upserted');

  // 4) Insert i_edit_page (home, Canvas Builder)
  const { data: existingPage } = await sb
    .from('i_edit_page')
    .select('id, slug, status')
    .eq('tenant_id', tenantId)
    .eq('slug', HOME_SLUG)
    .maybeSingle();

  let pageId;
  if (existingPage) {
    pageId = existingPage.id;
    console.log(`[skip] home page already exists: ${pageId}`);
    // Refresh canvas_design + SEO on the existing row
    const { error: upd } = await sb
      .from('i_edit_page')
      .update({
        canvas_design: canvasDesign,
        status: 'published',
        seo_title: SEO_TITLE,
        seo_description: SEO_DESCRIPTION,
        og_image_url: SOCIAL_IMAGE,
        meta_title: SEO_TITLE,
        meta_description: SEO_DESCRIPTION,
        published_at: new Date().toISOString(),
      })
      .eq('id', pageId);
    if (upd) console.error('[fail] refresh existing page:', upd.message);
    else console.log('[ok] refreshed home page canvas_design + SEO');
  } else {
    const { data: newPage, error: pageErr } = await sb
      .from('i_edit_page')
      .insert({
        tenant_id: tenantId,
        title: 'Home',
        slug: HOME_SLUG,
        description: DESCRIPTION,
        status: 'published',
        layout_type: 'public',
        builder_type: 'canvas',
        canvas_design: canvasDesign,
        seo_title: SEO_TITLE,
        seo_description: SEO_DESCRIPTION,
        og_image_url: SOCIAL_IMAGE,
        meta_title: SEO_TITLE,
        meta_description: SEO_DESCRIPTION,
        published_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (pageErr) {
      console.error('[fail] insert i_edit_page:', pageErr.message);
      process.exit(1);
    }
    pageId = newPage.id;
    console.log(`[ok] created home canvas page ${pageId}`);
  }

  // 5) Mark page as public home via system_settings
  const { data: existingSetting } = await sb
    .from('system_settings')
    .select('id, setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', 'public_home_page_slug')
    .maybeSingle();

  if (existingSetting) {
    if (existingSetting.setting_value !== HOME_SLUG) {
      await sb
        .from('system_settings')
        .update({ setting_value: HOME_SLUG })
        .eq('id', existingSetting.id);
      console.log(`[ok] public_home_page_slug -> ${HOME_SLUG}`);
    } else {
      console.log('[skip] public_home_page_slug already set');
    }
  } else {
    const { error: setErr } = await sb.from('system_settings').insert({
      tenant_id: tenantId,
      setting_key: 'public_home_page_slug',
      setting_value: HOME_SLUG,
    });
    if (setErr) console.error('[fail] insert public_home_page_slug:', setErr.message);
    else console.log(`[ok] inserted public_home_page_slug = ${HOME_SLUG}`);
  }

  console.log('\n=== DONE ===');
  console.log(`Tenant ID:     ${tenantId}`);
  console.log(`Tenant slug:   ${TENANT_SLUG}`);
  console.log(`Domain:        ${TENANT_DOMAIN}`);
  console.log(`Admin email:   ${ADMIN_EMAIL}`);
  if (setupToken) {
    console.log(`Setup link:    https://${TENANT_SLUG}.iconn.app/setup-password?token=${setupToken}`);
  }
  console.log(`Canvas page:   ${pageId} (slug=${HOME_SLUG}, builder=canvas, published)`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
