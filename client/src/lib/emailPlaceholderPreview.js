/**
 * Email Placeholder Preview
 *
 * Resolves a placeholder token (with {{}} or [[]] syntax) to an example value
 * for the Email Placeholders reference page. Falls back to a built-in fixture
 * when no real sample data is available.
 *
 * Mirrors substitution logic from:
 *   - api/_lib/emailService.js          (replacePlaceholders)
 *   - api/_lib/workflows.js             (processSpecialPlaceholders, set_password_url)
 *   - api/_lib/eventConfirmationEmail.js, api/cron/send-event-reminders.js
 *
 * Special placeholders ({{set_password_url}}, {{communication_preferences_link}})
 * render a representative HTML snippet rather than a real link.
 */

export const FIXTURE_SAMPLE_DATA = {
  source: 'fixture',
  member: {
    id: 'mem_8421',
    first_name: 'Alex',
    last_name: 'Morgan',
    full_name: 'Alex Morgan',
    email: 'alex.morgan@example.com',
    phone: '+44 20 7946 0011',
  },
  organization: {
    id: 'org_3187',
    name: 'Acme Industries Ltd',
    invoicing_email: 'finance@acme.example.com',
    phone: '+44 20 7946 0044',
  },
  tenant: {
    name: 'iConnect',
    base_url: 'https://app.example.com',
  },
  contract: {
    name: 'Sponsorship Agreement 2026',
    sign_url: 'https://app.example.com/contracts/sign/preview-token',
    days_remaining: 5,
    days_since_sent: 2,
    signer: {
      first_name: 'Alex',
      last_name: 'Morgan',
      full_name: 'Alex Morgan',
      email: 'alex.morgan@example.com',
    },
    applicant: { full_name: 'Acme Industries Ltd' },
  },
  due_diligence: {
    status: 'in_review',
    stage: 'Initial Review',
    score: 82,
    risk_level: 'Low',
    form_name: 'Vendor Due Diligence 2026',
    reviewer: 'Jamie Patel',
    review_date: '24 March 2026',
    custom_message: 'Please confirm your latest insurance certificate.',
    owner: 'Jamie Patel',
    owner_email: 'jamie.patel@iconnect.example',
    submission: {
      id: 'sub_5512',
      application_uid: 'APP-2026-0188',
      workflow_status: 'in_review',
      due_diligence_score: 82,
      risk_level: 'Low',
    },
  },
  meeting: {
    type: 'Discovery Call',
    duration: '30 minutes',
    title: 'Discovery Call with Alex',
    date: 'Monday, 4 May 2026',
    time: '10:00',
    end_time: '10:30',
    timezone: 'Europe/London',
    agent_name: 'Jamie Patel',
    booking_url: 'https://app.example.com/book/discovery',
    booking_link:
      '<a href="https://app.example.com/book/discovery" style="color: #0066cc; text-decoration: underline;">Book a meeting</a>',
    attendee_name: 'Alex Morgan',
    attendee_email: 'alex.morgan@example.com',
    attendee_notes: 'Looking forward to discussing the proposal.',
    zoom_join_url: 'https://zoom.us/j/9876543210',
    zoom_password: 'iConnect26',
    teams_join_url: 'https://teams.microsoft.com/l/meetup-join/preview',
  },
  event: {
    id: 'evt_4490',
    title: 'Spring Conference 2026',
    name: 'Spring Conference 2026',
    date: 'Monday, 4 May 2026',
    location: 'Royal Geographical Society, London',
    track_name: 'Plenary, Innovation Track',
    zoom_link: 'https://zoom.us/j/1112223333',
    session_schedule:
      '<ul><li>10:00 — Welcome (Plenary)</li><li>11:00 — Innovation Panel</li></ul>',
    session_zoom_links:
      '<ul><li>Welcome — <a href="https://zoom.us/j/111">Join</a></li><li>Innovation Panel — <a href="https://zoom.us/j/222">Join</a></li></ul>',
  },
  booking: {
    id: 'bkg_7720',
    reference: 'BKG-2026-0488',
    ticket_class: 'Standard',
    ticket_price: '£249.00',
    total_cost: '£249.00',
    offer_discount_description: 'Early bird saving',
    offer_discount_amount: '£25.00',
    track_name: 'Plenary, Innovation Track',
  },
  attendee: {
    first_name: 'Alex',
    last_name: 'Morgan',
    email: 'alex.morgan@example.com',
  },
  inviter: {
    first_name: 'Jamie',
    last_name: 'Patel',
    full_name: 'Jamie Patel',
    email: 'jamie.patel@iconnect.example',
  },
  invite: {
    link: 'https://app.example.com/invite/accept?token=preview',
    invitee_email: 'newmember@example.com',
  },
  job_posting: { status: 'Published' },
  socials: {
    linkedin_url: 'https://www.linkedin.com/company/iconnect',
    twitter_url: 'https://twitter.com/iconnect',
    facebook_url: 'https://www.facebook.com/iconnect',
    instagram_url: 'https://www.instagram.com/iconnect',
    youtube_url: 'https://www.youtube.com/@iconnect',
  },
  links: {
    set_password_url:
      'https://app.example.com/auth/reset-password?token=PREVIEW&email=alex.morgan%40example.com',
    communication_preferences_url:
      'https://app.example.com/email-preferences?t=PREVIEW',
  },
};

function nowIso() {
  return new Date().toISOString();
}

function nowDate() {
  return new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function nowDateTime() {
  return new Date().toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Merge a real-data sample bundle (from the API) on top of the fixture so that
 * any fields the API could not provide still get sensible defaults.
 */
function pickDefined(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const nested = pickDefined(v);
      if (Object.keys(nested).length > 0) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function deepMergeWithFixture(fixture, real) {
  if (!real || typeof real !== 'object' || Array.isArray(real)) return fixture;
  const out = { ...fixture };
  for (const [k, v] of Object.entries(real)) {
    if (v === null || v === undefined || v === '') continue;
    if (
      typeof v === 'object' &&
      !Array.isArray(v) &&
      fixture[k] &&
      typeof fixture[k] === 'object' &&
      !Array.isArray(fixture[k])
    ) {
      out[k] = deepMergeWithFixture(fixture[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function mergeSampleData(real) {
  if (!real || typeof real !== 'object') return FIXTURE_SAMPLE_DATA;
  const cleaned = pickDefined(real);
  const merged = deepMergeWithFixture(FIXTURE_SAMPLE_DATA, cleaned);
  if (real.source) merged.source = real.source;
  if (real.sources) merged.sources = real.sources;
  return merged;
}

/**
 * Strip {{...}} or [[...]] wrappers and lower-case the contents.
 */
function normalizeToken(token) {
  if (!token) return '';
  return token.replace(/^\{\{|\}\}$|^\[\[|\]\]$/g, '').trim().toLowerCase();
}

/**
 * Build the lookup table mapping a normalised placeholder key to a resolver.
 * Each resolver returns either:
 *   - { kind: 'text', value: string }
 *   - { kind: 'html', value: string }
 *   - { kind: 'placeholder', value: string }   (e.g. requires runtime data)
 */
function buildResolverMap(s) {
  const m = s.member;
  const o = s.organization;
  const t = s.tenant;
  const c = s.contract;
  const dd = s.due_diligence;
  const sub = dd.submission;
  const meet = s.meeting;
  const ev = s.event;
  const bk = s.booking;
  const at = s.attendee;
  const inv = s.inviter;
  const social = s.socials;
  const links = s.links;

  const safe = (value) => (value === null || value === undefined ? '—' : String(value));
  const text = (value) => ({ kind: 'text', value: safe(value) });
  const html = (value) => ({ kind: 'html', value: safe(value) });
  const placeholder = (value) => ({ kind: 'placeholder', value: safe(value) });

  const setPasswordHtml = `<a href="${links.set_password_url}" style="color: #0066cc; text-decoration: underline;">Set your password</a>`;
  const commsLinkHtml = `<a href="${links.communication_preferences_url}" style="color: #666;">Manage communication preferences</a>`;

  return {
    // Member
    'member.id': text(m.id),
    'member.full_name': text(m.full_name),
    'member.first_name': text(m.first_name),
    'member.last_name': text(m.last_name),
    'member.email': text(m.email),
    'member.phone': text(m.phone),
    member_full_name: text(m.full_name),
    member_first_name: text(m.first_name),
    member_last_name: text(m.last_name),
    member_email: text(m.email),
    first_name: text(m.first_name),
    last_name: text(m.last_name),
    full_name: text(m.full_name),
    name: text(m.full_name),
    email: text(m.email),

    // Organisation
    'organization.id': text(o.id),
    'organization.name': text(o.name),
    'organization.invoicing_email': text(o.invoicing_email),
    'organization.phone': text(o.phone),
    organization_id: text(o.id),
    organization_name: text(o.name),
    'tenant.name': text(t.name),
    tenant_name: text(t.name),

    // Contracts
    'contract.name': text(c.name),
    contract_name: text(c.name),
    'signer.name': text(c.signer.full_name),
    'signer.first_name': text(c.signer.first_name),
    'signer.last_name': text(c.signer.last_name),
    'signer.email': text(c.signer.email),
    signer_name: text(c.signer.full_name),
    signer_first_name: text(c.signer.first_name),
    signer_last_name: text(c.signer.last_name),
    signer_email: text(c.signer.email),
    sign_url: text(c.sign_url),
    signing_url: text(c.sign_url),
    days_remaining: text(c.days_remaining),
    days_since_sent: text(c.days_since_sent),
    'applicant.name': text(c.applicant.full_name),

    // Due Diligence
    due_diligence_status: text(dd.status),
    due_diligence_stage: text(dd.stage),
    due_diligence_score: text(dd.score),
    due_diligence_risk_level: text(dd.risk_level),
    due_diligence_form_name: text(dd.form_name),
    due_diligence_reviewer: text(dd.reviewer),
    due_diligence_review_date: text(dd.review_date),
    custom_message: text(dd.custom_message),
    dd_owner: text(dd.owner),
    dd_owner_email: text(dd.owner_email),
    recipient_name: text(m.full_name),
    recipient_first_name: text(m.first_name),
    recipient_last_name: text(m.last_name),
    recipient_email: text(m.email),
    'recipient.name': text(m.full_name),
    'recipient.first_name': text(m.first_name),
    'recipient.last_name': text(m.last_name),
    'recipient.email': text(m.email),
    'submission.id': text(sub.id),
    'submission.application_uid': text(sub.application_uid),
    'submission.workflow_status': text(sub.workflow_status),
    'submission.due_diligence_score': text(sub.due_diligence_score),
    'submission.risk_level': text(sub.risk_level),

    // Meetings & Bookings
    meeting_type: text(meet.type),
    duration: text(meet.duration),
    agent_name: text(meet.agent_name),
    booking_url: text(meet.booking_url),
    booking_link: html(meet.booking_link),
    attendee_name: text(meet.attendee_name),
    attendee_email: text(meet.attendee_email),
    attendee_notes: text(meet.attendee_notes),
    meeting_title: text(meet.title),
    meeting_date: text(meet.date),
    meeting_time: text(meet.time),
    meeting_end_time: text(meet.end_time),
    meeting_timezone: text(meet.timezone),
    zoom_join_url: text(meet.zoom_join_url),
    zoom_password: text(meet.zoom_password),
    teams_join_url: text(meet.teams_join_url),

    // Event Confirmation & Reminder
    'attendee.first_name': text(at.first_name),
    'attendee.last_name': text(at.last_name),
    'attendee.email': text(at.email),
    'event.name': text(ev.name),
    'event.title': text(ev.title),
    'event.date': text(ev.date),
    'event.location': text(ev.location),
    'booking.id': text(bk.id),
    'booking.reference': text(bk.reference),
    'booking.booking_reference': text(bk.reference),
    booking_id: text(bk.id),
    booking_reference: text(bk.reference),
    'booking.ticket_class': text(bk.ticket_class),
    'booking.ticket_price': text(bk.ticket_price),
    'booking.total_cost': text(bk.total_cost),
    'booking.offer_discount_description': text(bk.offer_discount_description),
    'booking.offer_discount_amount': text(bk.offer_discount_amount),
    'booking.track_name': text(bk.track_name),
    track_name: text(bk.track_name),
    zoom_link: text(ev.zoom_link),
    session_schedule: html(ev.session_schedule),
    session_zoom_links: html(ev.session_zoom_links),

    // Form Submissions (pattern tokens)
    '<field_id>':
      placeholder('Submitted value for the field with that UUID (e.g. "Investment Banking")'),
    '<field_label>':
      placeholder('Submitted value for the field with that label (e.g. "Investment Banking")'),
    'record.<field>':
      placeholder('Value of <field> on the workflow trigger record (e.g. "Approved")'),

    // Workflow Triggers & Invites
    invite_link: text(s.invite.link),
    inviter_name: text(inv.full_name),
    invitee_email: text(s.invite.invitee_email),
    'job_posting.status': text(s.job_posting.status),
    current_date: text(nowDate()),
    current_datetime: text(nowDateTime()),

    // System & Links
    set_password_url: html(setPasswordHtml),
    communication_preferences_link: html(commsLinkHtml),
    communication_preferences_url: text(links.communication_preferences_url),
    timestamp: text(nowIso()),

    // Footer & Socials
    linkedin_url: text(social.linkedin_url),
    twitter_url: text(social.twitter_url),
    facebook_url: text(social.facebook_url),
    instagram_url: text(social.instagram_url),
    youtube_url: text(social.youtube_url),
  };
}

/**
 * Resolve a single placeholder token to a preview value.
 * Returns { kind, value } where kind is 'text' | 'html' | 'placeholder'.
 */
export function resolvePlaceholderPreview(token, sampleData = FIXTURE_SAMPLE_DATA) {
  const map = buildResolverMap(sampleData);
  const key = normalizeToken(token);
  if (key in map) return map[key];
  return null;
}

/**
 * Apply a per-section record override on top of the merged base sample.
 * Returns a new sample bundle with the relevant slice replaced so that all
 * placeholders in that section resolve against the picked record. Sections we
 * don't recognise just return the unchanged base sample.
 *
 * Recognised categories:
 *   - 'Member'                          -> { member, recipient_*, attendee }
 *   - 'Organisation'                    -> { organization }
 *   - 'Contracts'                       -> { contract }
 *   - 'Event Confirmation & Reminder'   -> { event, booking, attendee }
 *
 * `record` shape per category:
 *   - Member:        { id, first_name, last_name, full_name, email, phone }
 *   - Organisation:  { id, name, invoicing_email, phone }
 *   - Contracts:     { id, name?, days_since_sent?, signer: { ... } }
 *   - Event:         { id, title, name, date, location, booking?, attendee? }
 */
export function buildCategorySample(baseSample, category, record) {
  if (!record || !baseSample) return baseSample;
  const out = { ...baseSample };
  switch (category) {
    case 'Member': {
      out.member = { ...baseSample.member, ...record };
      out.attendee = {
        ...baseSample.attendee,
        first_name: record.first_name ?? baseSample.attendee.first_name,
        last_name: record.last_name ?? baseSample.attendee.last_name,
        email: record.email ?? baseSample.attendee.email,
      };
      return out;
    }
    case 'Organisation': {
      out.organization = { ...baseSample.organization, ...record };
      return out;
    }
    case 'Contracts': {
      const baseContract = baseSample.contract || {};
      const baseSigner = baseContract.signer || {};
      out.contract = {
        ...baseContract,
        ...record,
        signer: { ...baseSigner, ...(record.signer || {}) },
      };
      return out;
    }
    case 'Event Confirmation & Reminder': {
      out.event = {
        ...baseSample.event,
        id: record.id ?? baseSample.event.id,
        title: record.title ?? baseSample.event.title,
        name: record.name ?? record.title ?? baseSample.event.name,
        date: record.date ?? baseSample.event.date,
        location: record.location ?? baseSample.event.location,
      };
      // Reset booking/attendee whenever the event changes so we never silently
      // carry placeholders forward from a different event. If the picked event
      // has its own booking/attendee, use that; otherwise fall back to the
      // built-in fixture values rather than the API's "most recent" booking.
      out.booking = record.booking
        ? { ...FIXTURE_SAMPLE_DATA.booking, ...record.booking }
        : { ...FIXTURE_SAMPLE_DATA.booking };
      out.attendee = record.attendee
        ? { ...FIXTURE_SAMPLE_DATA.attendee, ...record.attendee }
        : { ...FIXTURE_SAMPLE_DATA.attendee };
      return out;
    }
    case 'Meetings & Bookings': {
      out.meeting = { ...baseSample.meeting, ...record };
      return out;
    }
    case 'Due Diligence': {
      const baseDd = baseSample.due_diligence || {};
      const baseSub = baseDd.submission || {};
      out.due_diligence = {
        ...baseDd,
        ...record,
        submission: { ...baseSub, ...(record.submission || {}) },
      };
      return out;
    }
    default:
      return baseSample;
  }
}

/**
 * Sections that support per-record selection on the reference page.
 * Other categories (Form Submissions, System & Links, Footer & Socials,
 * Workflow Triggers & Invites) are tenant-wide / pattern-only and do not
 * get a dropdown.
 */
export const RECORD_PICKER_CATEGORIES = [
  'Member',
  'Organisation',
  'Contracts',
  'Event Confirmation & Reminder',
  'Meetings & Bookings',
  'Due Diligence',
];

/**
 * The list field on the API response that drives each picker.
 */
export const CATEGORY_LIST_KEY = {
  Member: 'members',
  Organisation: 'organizations',
  Contracts: 'contracts',
  'Event Confirmation & Reminder': 'events',
  'Meetings & Bookings': 'meetings',
  'Due Diligence': 'due_diligence_submissions',
};

/**
 * Render a short label for a record in a category dropdown.
 */
export function labelForRecord(category, record) {
  if (!record) return '';
  switch (category) {
    case 'Member': {
      const name = record.full_name || [record.first_name, record.last_name].filter(Boolean).join(' ');
      if (name && record.email && name !== record.email) return `${name} — ${record.email}`;
      return name || record.email || record.id || 'Unnamed member';
    }
    case 'Organisation':
      return record.name || record.id || 'Unnamed organisation';
    case 'Contracts': {
      const signer = record.signer?.full_name;
      if (record.name && signer) return `${record.name} — ${signer}`;
      return record.name || signer || record.id || 'Unnamed contract';
    }
    case 'Event Confirmation & Reminder': {
      const title = record.title || record.name;
      if (title && record.date) return `${title} — ${record.date}`;
      return title || record.id || 'Unnamed event';
    }
    case 'Meetings & Bookings': {
      const stem = record.type || record.title || 'Meeting';
      const when = [record.date, record.time].filter(Boolean).join(' ');
      const attendee = record.attendee_name || record.attendee_email;
      const head = attendee ? `${stem} — ${attendee}` : stem;
      return when ? `${head} (${when})` : head;
    }
    case 'Due Diligence': {
      const head = record.form_name || 'Due diligence';
      const ref = record.submission?.application_uid;
      const status = record.status || record.stage;
      const tail = [ref, status].filter(Boolean).join(' · ');
      return tail ? `${head} — ${tail}` : head;
    }
    default:
      return record.id || '';
  }
}

/**
 * Build a small human-readable description of where the sample data came from.
 */
export function describeSampleSources(sampleData) {
  if (!sampleData || sampleData.source !== 'real') {
    return 'Built-in sample data';
  }
  const sources = sampleData.sources || {};
  const parts = [];
  if (sources.member) parts.push(`recent member (${sources.member})`);
  if (sources.organization) parts.push(`recent organisation (${sources.organization})`);
  if (sources.event) parts.push(`recent event (${sources.event})`);
  if (sources.booking) parts.push(`recent booking (${sources.booking})`);
  if (sources.contract) parts.push(`recent contract (${sources.contract})`);
  if (parts.length === 0) return 'Built-in sample data';
  return `Resolved against ${parts.join(', ')}. Missing fields use built-in samples.`;
}
