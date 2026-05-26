// Task #1031 — Phase 2: contact form + notification email for iSaaSi tenant.
//
// - Creates a tenant-scoped email template (contact notification → admin)
// - Creates a public contact form with submission_emails wired to the template
//   and recipient = mat@teeone.co.uk
// - Appends a FORM_EMBED block to the iSaaSi home canvas page (id constant
//   below), positioned between the FAQ and the final CTA
//
// Idempotent: detects existing template/form/block by name/slug/id.
// Run: SUPABASE_URL=$DEST_SUPABASE_URL SUPABASE_SERVICE_KEY=$DEST_SUPABASE_KEY \
//      node scripts/provision-isaasi-contact.mjs

import { createClient } from '@supabase/supabase-js';

const TENANT_ID = 'ffde35e5-c692-476b-900e-c3ad323e4b32';
const PAGE_ID = '0e619e68-b807-4ecd-9b16-2f4db8fe2c5d';
const ADMIN_EMAIL = 'mat@teeone.co.uk';
const FORM_SLUG = 'contact';
const TEMPLATE_NAME = 'Contact form notification';
const EMBED_BLOCK_ID = 'sec-contact-form';

const sb = createClient(
  process.env.DEST_SUPABASE_URL,
  process.env.DEST_SUPABASE_KEY,
  { auth: { persistSession: false } },
);

async function ensureEmailTemplate() {
  const { data: existing } = await sb
    .from('email_template')
    .select('id')
    .eq('tenant_id', TENANT_ID)
    .eq('name', TEMPLATE_NAME)
    .maybeSingle();
  if (existing) {
    console.log(`[skip] email_template ${existing.id} exists`);
    return existing.id;
  }
  const subject = 'New iSaaSi contact form submission from {{name}}';
  const body = `<p>You have a new contact form submission via isaasi.co.uk.</p>
<table cellpadding="6" style="border-collapse:collapse;border:1px solid #e5e7eb">
  <tr><td><strong>Name</strong></td><td>{{name}}</td></tr>
  <tr><td><strong>Email</strong></td><td>{{email}}</td></tr>
  <tr><td><strong>Organisation</strong></td><td>{{organisation}}</td></tr>
  <tr><td><strong>Message</strong></td><td>{{message}}</td></tr>
</table>
<p style="color:#6b7280;font-size:12px">Sent automatically by iSaaSi iConnect.</p>`;

  const { data, error } = await sb
    .from('email_template')
    .insert({
      tenant_id: TENANT_ID,
      name: TEMPLATE_NAME,
      description: 'Notifies the iSaaSi admin when the public contact form is submitted.',
      subject,
      body,
      from_name: 'iSaaSi Website',
      from_email: null,
      reply_to: null,
      category: 'transactional',
      placeholders: ['name', 'email', 'organisation', 'message'],
      is_active: true,
    })
    .select('id')
    .single();
  if (error) throw new Error(`email_template insert: ${error.message}`);
  console.log(`[ok] email_template ${data.id} created`);
  return data.id;
}

async function ensureContactForm(templateId) {
  const { data: existing } = await sb
    .from('form')
    .select('id, fields')
    .eq('tenant_id', TENANT_ID)
    .eq('slug', FORM_SLUG)
    .maybeSingle();
  if (existing) {
    console.log(`[skip] contact form ${existing.id} exists`);
    return existing.id;
  }

  const pageId = 'page_contact_1';
  const fId = (n) => `field_contact_${n}`;
  const fields = [
    {
      id: fId('name'),
      type: 'text',
      label: 'Your name',
      placeholder: 'Jane Smith',
      required: true,
      page_id: pageId,
      column_index: 0,
      options: [],
    },
    {
      id: fId('email'),
      type: 'email',
      label: 'Email address',
      placeholder: 'jane@example.org',
      required: true,
      page_id: pageId,
      column_index: 0,
      options: [],
    },
    {
      id: fId('org'),
      type: 'text',
      label: 'Organisation',
      placeholder: 'Your membership organisation',
      required: false,
      page_id: pageId,
      column_index: 0,
      options: [],
    },
    {
      id: fId('msg'),
      type: 'textarea',
      label: 'How can we help?',
      placeholder: 'Tell us a bit about what you need…',
      required: true,
      page_id: pageId,
      column_index: 0,
      options: [],
    },
  ];

  const submissionEmails = [
    {
      id: 'email_contact_admin',
      template_id: templateId,
      recipient: ADMIN_EMAIL,
      cc: '',
      bcc: '',
      condition: null,
      field_mapping: {
        name: fId('name'),
        email: fId('email'),
        organisation: fId('org'),
        message: fId('msg'),
      },
      attach_invoice: false,
    },
  ];

  const { data, error } = await sb
    .from('form')
    .insert({
      tenant_id: TENANT_ID,
      name: 'Contact iSaaSi',
      description: 'Get in touch with the iSaaSi team for a free consult or any questions.',
      slug: FORM_SLUG,
      layout_type: 'single_page',
      fields,
      pages: [{ id: pageId, title: 'Contact' }],
      submit_button_text: 'Send message',
      success_message:
        "Thanks — we've received your message and the iSaaSi team will be in touch within one business day.",
      redirect_url: null,
      require_authentication: false,
      is_active: true,
      submission_count: 0,
      submission_emails: submissionEmails,
      blank_layout: false,
      allow_submitter_email_copy: false,
    })
    .select('id')
    .single();
  if (error) throw new Error(`form insert: ${error.message}`);
  console.log(`[ok] contact form ${data.id} created (slug=${FORM_SLUG})`);
  return data.id;
}

async function appendFormEmbedToCanvas() {
  const { data: page, error } = await sb
    .from('i_edit_page')
    .select('canvas_design')
    .eq('id', PAGE_ID)
    .single();
  if (error) throw new Error(`load page: ${error.message}`);
  const design = page.canvas_design;
  const section = design?.root?.sections?.[0];
  if (!section) throw new Error('canvas_design missing root section');
  const children = section.children || [];
  if (children.some((b) => b.id === EMBED_BLOCK_ID)) {
    console.log('[skip] form-embed block already present on canvas');
    return;
  }

  // Find the final CTA (sec-final-cta) and insert the contact form above it,
  // pushing it (and anything after) down by EMBED_H + GAP.
  const EMBED_H = 520;
  const GAP = 32;
  const finalIdx = children.findIndex((b) => b.id === 'sec-final-cta');
  const insertAt = finalIdx === -1 ? children.length : finalIdx;
  const finalY =
    finalIdx === -1
      ? Math.max(0, ...children.map((b) => (b.bp?.desktop?.y || 0) + (b.bp?.desktop?.h || 0))) + GAP
      : children[finalIdx].bp?.desktop?.y || 0;

  const embed = {
    id: EMBED_BLOCK_ID,
    type: 'form-embed',
    name: 'Contact form',
    locked: false,
    style: {
      background: '#FFFFFF',
      borderWidth: 1,
      borderColor: '#E5E7EB',
      borderRadius: 8,
      paddingTop: 24,
      paddingRight: 24,
      paddingBottom: 24,
      paddingLeft: 24,
    },
    a11y: { role: 'region', ariaLabel: 'Contact form' },
    content: {
      formSlug: FORM_SLUG,
      mode: 'inline',
      title: 'Get in touch',
      ctaLabel: '',
    },
    bp: {
      desktop: { x: 0, y: finalY, w: 1200, h: EMBED_H, hidden: false },
      tablet: {},
      mobile: {},
    },
  };

  // Shift the final-CTA (and any subsequent blocks) down
  const shift = EMBED_H + GAP;
  const shifted = children.map((b, i) => {
    if (i < insertAt) return b;
    if (!b.bp?.desktop) return b;
    return {
      ...b,
      bp: { ...b.bp, desktop: { ...b.bp.desktop, y: (b.bp.desktop.y || 0) + shift } },
    };
  });
  shifted.splice(insertAt, 0, embed);

  const newDesign = {
    ...design,
    root: {
      ...design.root,
      sections: [{ ...section, children: shifted }],
    },
  };

  const { error: updErr } = await sb
    .from('i_edit_page')
    .update({ canvas_design: newDesign })
    .eq('id', PAGE_ID);
  if (updErr) throw new Error(`update canvas: ${updErr.message}`);
  console.log('[ok] form-embed block appended to canvas');
}

async function main() {
  console.log('=== iSaaSi contact form provisioning ===');
  const tplId = await ensureEmailTemplate();
  await ensureContactForm(tplId);
  await appendFormEmbedToCanvas();
  console.log('\n=== DONE ===');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
