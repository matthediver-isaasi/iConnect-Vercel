// AESP demo tenant — engagement & content seed (Task: SIGs, committees,
// events + registrations, membership application form, conference feedback
// survey, CMS pages, news, knowledge resources and persona activity trails).
//
// Called from demo-seeds/aesp/definition.mjs AFTER members are persisted, so
// every plan carries plan.memberId. All writes go through ctx.upsert (direct
// supabase-js with the service key) — no entity API, no workflows, no emails,
// no payment-provider calls. All RNG is consumed in a sequential planning
// phase from a dedicated stream so member data stays byte-stable.

import { createRng, pmap } from '../engine.mjs';
import { buildNeutralDesign } from '../../api/_lib/canvasLayoutEngine.js';
import { scoreSubmission } from '../../api/_lib/surveyScoring.js';

// ---------------------------------------------------------------------------
// Static definitions
// ---------------------------------------------------------------------------
const SIGS = [
  { name: 'Carbon & Net Zero', target: 35, blurb: 'Practitioners working on carbon accounting, reduction strategy and net-zero delivery across every sector.' },
  { name: 'Biodiversity', target: 25, blurb: 'Ecologists and biodiversity specialists sharing practice on habitat assessment, BNG and nature recovery.' },
  { name: 'Environmental Impact Assessment', target: 20, blurb: 'EIA practitioners discussing screening, scoping, case law and effective environmental statements.' },
  { name: 'ESG & Corporate Sustainability', target: 30, blurb: 'Members embedding sustainability in corporate strategy, reporting and investor engagement.' },
  { name: 'Renewable Energy', target: 22, blurb: 'Professionals supporting the consenting, construction and operation of renewable energy projects.' },
  { name: 'Sustainable Construction', target: 18, blurb: 'Built-environment members advancing low-carbon materials, circular design and responsible construction.' },
];

const COMMITTEES = [
  { name: 'AESP Council', size: 9, roles: ['President', 'Vice President', 'Immediate Past President', 'Treasurer', 'Council Member'], officer: ['President', 'Vice President', 'Immediate Past President', 'Treasurer'], fill: 'Council Member', blurb: 'The governing council of AESP, responsible for strategy, governance and financial oversight.' },
  { name: 'Professional Standards Committee', size: 7, roles: ['Chair', 'Vice Chair', 'Committee Member'], officer: ['Chair', 'Vice Chair'], fill: 'Committee Member', blurb: 'Oversees the member code of conduct, professional review and complaints procedures.' },
  { name: 'Education & CPD Committee', size: 7, roles: ['Chair', 'Vice Chair', 'Committee Member'], officer: ['Chair', 'Vice Chair'], fill: 'Committee Member', blurb: 'Shapes the CPD framework, accredits training and supports early-career development.' },
  { name: 'Events Committee', size: 6, roles: ['Chair', 'Vice Chair', 'Committee Member'], officer: ['Chair', 'Vice Chair'], fill: 'Committee Member', blurb: 'Plans the annual conference, regional events and the webinar programme.' },
  { name: 'Membership Committee', size: 6, roles: ['Chair', 'Vice Chair', 'Committee Member'], officer: ['Chair', 'Vice Chair'], fill: 'Committee Member', blurb: 'Reviews membership applications, grade criteria and member benefits.' },
  { name: 'Sustainability Policy Committee', size: 6, roles: ['Chair', 'Vice Chair', 'Committee Member'], officer: ['Chair', 'Vice Chair'], fill: 'Committee Member', blurb: 'Coordinates AESP responses to consultations and public policy positions.' },
];

// Historical simple events (daysAgo, type, price, target bookings).
const PAST_EVENTS = [
  { key: 'annual-conference-2025', title: 'AESP Annual Conference 2025', tag: 'Conference', daysAgo: 340, days: 2, location: 'ICC Birmingham', online: false, price: 275, seats: 350, bookings: 48, summary: 'Two days of keynotes, workshops and networking for the environmental profession.' },
  { key: 'scope-3-webinar', title: 'Scope 3 Emissions: Getting Started', tag: 'Webinar', daysAgo: 200, days: 0, location: 'Online', online: true, price: 0, bookings: 44, summary: 'A practical introduction to measuring and reporting value-chain emissions.' },
  { key: 'bng-in-practice', title: 'Biodiversity Net Gain in Practice', tag: 'Workshop', daysAgo: 260, days: 0, location: 'Leeds', online: false, price: 95, seats: 40, bookings: 21, summary: 'Hands-on workshop applying the statutory biodiversity metric to real schemes.' },
  { key: 'esg-reporting-update', title: 'ESG Reporting Update Webinar', tag: 'Webinar', daysAgo: 150, days: 0, location: 'Online', online: true, price: 0, bookings: 36, summary: 'What the latest UK and EU disclosure requirements mean for members.' },
  { key: 'eia-case-law', title: 'EIA Case Law Update', tag: 'Webinar', daysAgo: 120, days: 0, location: 'Online', online: true, price: 0, bookings: 28, summary: 'Annual round-up of environmental impact assessment case law and its implications.' },
  { key: 'sustainable-construction-visit', title: 'Sustainable Construction Site Visit', tag: 'Networking', daysAgo: 90, days: 0, location: 'Manchester', online: false, price: 0, seats: 25, bookings: 18, summary: 'Guided tour of a flagship low-carbon commercial development.' },
  { key: 'carbon-literacy-day', title: 'Carbon Literacy Training Day', tag: 'CPD Training', daysAgo: 75, days: 0, location: 'London', online: false, price: 150, seats: 20, bookings: 16, summary: 'Accredited full-day carbon literacy training for practitioners.' },
  { key: 'spring-networking', title: "Spring Members' Networking Evening", tag: 'Networking', daysAgo: 55, days: 0, location: 'Bristol', online: false, price: 0, seats: 60, bookings: 24, summary: 'Informal evening of networking with fellow members in the South West.' },
  { key: 'net-zero-getting-started', title: 'Getting Started with Net Zero Strategy', tag: 'Webinar', daysAgo: 40, days: 0, location: 'Online', online: true, price: 0, bookings: 32, summary: 'Foundations of a credible organisational net-zero strategy.' },
];

// Upcoming simple events (the conference is a complex event, defined inline).
const UPCOMING_EVENTS = [
  { key: 'net-zero-strategy-delivery', title: 'Net Zero: From Strategy to Delivery', tag: 'Webinar', daysAhead: 21, days: 0, location: 'Online', online: true, price: 0, bookings: 40, membersOnly: true, summary: 'Members-only webinar on turning net-zero commitments into delivery programmes.' },
  { key: 'bng-masterclass', title: 'Biodiversity Net Gain Masterclass', tag: 'CPD Training', daysAhead: 35, days: 0, location: 'Birmingham (hybrid)', online: false, price: 120, seats: 30, bookings: 18, summary: 'Half-day CPD masterclass on advanced biodiversity net gain assessment.' },
  { key: 'early-careers-networking', title: 'Early Careers Networking Evening — Manchester', tag: 'Networking', daysAhead: 28, days: 0, location: 'Manchester', online: false, price: 0, seats: 50, bookings: 22, audience: ['student', 'graduate'], summary: 'Free evening for student and graduate members to meet peers and mentors.' },
  { key: 'eia-practitioner-workshop', title: 'Environmental Impact Assessment Practitioner Workshop', tag: 'Professional Training', daysAhead: 49, days: 0, location: 'Leeds', online: false, price: 180, seats: 24, bookings: 14, summary: 'Full-day professional training for practising EIA coordinators.' },
  { key: 'agm-2026', title: 'AESP Annual General Meeting 2026', tag: 'Governance', daysAhead: 95, days: 0, location: 'Birmingham & online', online: false, price: 0, bookings: 12, membersOnly: true, summary: 'The formal annual general meeting of the association. Members only.' },
];

const NEWS = [
  { slug: 'state-of-profession-survey-2026', title: 'AESP launches 2026 State of the Sustainability Profession survey', daysAgo: 12, tags: ['Research'], body: ['AESP has opened its annual State of the Sustainability Profession survey, gathering data on salaries, skills and career progression across the environmental sector.', 'Results will be published in the autumn and shared free of charge with all members.'] },
  { slug: 'conference-2026-programme', title: 'Annual Conference 2026 programme announced', daysAgo: 25, tags: ['Events'], body: ['The full programme for the AESP Annual Conference 2026 in Birmingham is now live, featuring keynotes on nature markets, adaptation and the future of ESG assurance.', 'Early-bird member rates are available until the end of the month.'] },
  { slug: 'new-biodiversity-sig-chair', title: 'New Biodiversity SIG Chair appointed', daysAgo: 48, tags: ['Community'], body: ['The Biodiversity Special Interest Group has appointed a new Chair to lead its programme of webinars, site visits and practice notes for the coming year.', 'The SIG welcomes new members from all grades.'] },
  { slug: 'mentoring-programme-applications', title: 'Applications open for the AESP mentoring programme', daysAgo: 70, tags: ['Careers'], body: ['Applications are now open for the next cohort of the AESP mentoring programme, matching early-career members with experienced practitioners.', 'Both mentors and mentees can register interest through the member portal.'] },
  { slug: 'environmental-careers-week', title: 'Environmental Careers Week launches', daysAgo: 95, tags: ['Careers'], body: ['AESP is partnering with universities across the UK for Environmental Careers Week, a series of talks and panels introducing students to careers in the profession.', 'Student membership is free to attendees for the first year.'] },
  { slug: 'net-zero-reporting-guidance', title: 'AESP publishes guidance on corporate net-zero reporting', daysAgo: 120, tags: ['Guidance'], body: ['New AESP guidance helps members navigate corporate net-zero disclosure expectations, from transition plans to scope 3 boundaries.', 'The guide is available to all members in the Knowledge Hub.'] },
  { slug: 'consultation-response-planning-reform', title: 'AESP responds to planning reform consultation', daysAgo: 145, tags: ['Policy'], body: ['The Sustainability Policy Committee has submitted the association\u2019s response to the government consultation on environmental assessment reform.', 'The full response is available to members.'] },
  { slug: 'cpd-framework-refresh', title: 'Refreshed CPD framework takes effect', daysAgo: 170, tags: ['CPD'], body: ['AESP\u2019s refreshed CPD framework is now in effect, keeping the 30-hour annual expectation while giving members more flexibility over structured learning.', 'Updated CPD guidance is available in the Knowledge Hub.'] },
];

const RESOURCES = [
  { slug: 'cpd-guidance', title: 'AESP CPD Guidance', isPublic: false, desc: 'How the AESP CPD framework works: the 30-hour annual expectation, structured vs self-directed learning, and how to record activity.' },
  { slug: 'code-of-conduct', title: 'Member Code of Conduct', isPublic: true, desc: 'The professional and ethical standards expected of every AESP member, and how concerns are handled.' },
  { slug: 'net-zero-practitioner-guide', title: 'Net Zero Practitioner Guide', isPublic: false, desc: 'A practical guide to scoping, measuring and delivering organisational net-zero strategies.' },
  { slug: 'bng-briefing', title: 'Biodiversity Net Gain Briefing', isPublic: false, desc: 'Briefing note on statutory biodiversity net gain: metric, exemptions and emerging practice.' },
  { slug: 'environmental-careers-guide', title: 'Environmental Careers Guide', isPublic: true, desc: 'Routes into the environmental profession, typical roles and the skills employers look for.' },
  { slug: 'mentoring-handbook', title: 'Mentoring Handbook', isPublic: false, desc: 'Handbook for mentors and mentees taking part in the AESP mentoring programme.' },
];

// ---------------------------------------------------------------------------
// Membership application form fields + steering rules
// ---------------------------------------------------------------------------
const YEARS_OPTIONS = ['0\u20132 years', '3\u20139 years', '10\u201319 years', '20+ years'];

function applicationFormFields() {
  const t = (id, type, label, extra = {}) => ({ id, type, label, ...extra });
  return [
    t('af_instructions', 'instructions', 'About this application', { content: '<p>Apply to join the Association of Environmental &amp; Sustainability Professionals. Based on your answers, we will recommend the membership grade that fits you best. The Membership Committee reviews every application.</p>' }),
    t('af_full_name', 'text', 'Full name', { required: true, placeholder: 'e.g. Jane Smith' }),
    t('af_email', 'email', 'Email address', { required: true }),
    t('af_phone', 'tel', 'Telephone', { required: false }),
    t('af_address', 'textarea', 'Address', { required: false }),
    t('af_employment_status', 'select', 'Current employment status', { required: true, options: ['Employed', 'Self-employed', 'Studying full-time', 'Studying part-time', 'Career break', 'Retired'] }),
    t('af_employer', 'text', 'Employer', {}),
    t('af_job_title', 'text', 'Job title', {}),
    t('af_studying', 'boolean', 'Are you currently studying a relevant subject?', { required: true, default_value: false }),
    t('af_qualification', 'text', 'Highest qualification (or qualification in progress)', {}),
    t('af_subject', 'text', 'Subject', {}),
    t('af_institution', 'text', 'Institution', {}),
    t('af_completion_date', 'date', 'Graduation / expected completion date', {}),
    t('af_years_experience', 'select', 'Years working in environmental/sustainability roles', { required: true, options: YEARS_OPTIONS }),
    t('af_responsibilities', 'textarea', 'Current professional responsibilities', { placeholder: 'Briefly describe your current role and responsibilities.' }),
    // Grade recommendations — hidden until the steering rules reveal one.
    t('af_rec_student', 'instructions', 'Recommended grade: Student Member', { starts_hidden: true, content: '<p><strong>Recommended grade: Student Member (\u00a335/year).</strong> As a current student of a relevant subject you qualify for our student grade.</p>' }),
    t('af_rec_graduate', 'instructions', 'Recommended grade: Graduate Member', { starts_hidden: true, content: '<p><strong>Recommended grade: Graduate Member (\u00a385/year).</strong> With under three years\u2019 experience the graduate grade supports your early career.</p>' }),
    t('af_rec_professional', 'instructions', 'Recommended grade: Professional Member', { starts_hidden: true, content: '<p><strong>Recommended grade: Professional Member, MAESP (\u00a3175/year).</strong> Your experience suggests the full professional grade.</p>' }),
    t('af_rec_fellow', 'instructions', 'Recommended route: Fellowship review', { starts_hidden: true, content: '<p><strong>Recommended route: Fellow, FAESP (\u00a3245/year).</strong> With 20+ years\u2019 experience your application will be considered for Fellowship review.</p>' }),
  ];
}

function applicationFormRules() {
  const vis = (id, conditions, target) => ({
    id,
    rule_type: 'visibility',
    logic: 'AND',
    conditions,
    actions: [{ id: `action_vis_${id}`, action_type: 'visibility', field_states: { [target]: { visible: true, enabled: null } } }],
  });
  const studyingTrue = { field_id: 'af_studying', operator: 'equals', value: true };
  const studyingFalse = { field_id: 'af_studying', operator: 'equals', value: false };
  const yearsEq = (v) => ({ field_id: 'af_years_experience', operator: 'equals', value: v });
  return [
    vis('rule_rec_student', [studyingTrue], 'af_rec_student'),
    vis('rule_rec_graduate', [studyingFalse, yearsEq(YEARS_OPTIONS[0])], 'af_rec_graduate'),
    vis('rule_rec_professional_a', [studyingFalse, yearsEq(YEARS_OPTIONS[1])], 'af_rec_professional'),
    vis('rule_rec_professional_b', [studyingFalse, yearsEq(YEARS_OPTIONS[2])], 'af_rec_professional'),
    vis('rule_rec_fellow', [studyingFalse, yearsEq(YEARS_OPTIONS[3])], 'af_rec_fellow'),
  ];
}

// ---------------------------------------------------------------------------
// Survey (AESP Annual Conference Feedback)
// ---------------------------------------------------------------------------
function surveyFields() {
  const star = (id, label, category) => ({
    id, type: 'score', label, required: true, score_style: 'stars', score_min: 1, score_max: 5,
    reporting_name: label, reporting_category: category, include_in_overall: true, weight: 1,
  });
  return [
    star('sv_overall', 'Overall conference rating', 'Overall'),
    star('sv_speakers', 'Quality of speakers', 'Content'),
    star('sv_relevance', 'Relevance of sessions', 'Content'),
    star('sv_venue', 'Venue', 'Venue'),
    {
      id: 'sv_return', type: 'score', label: 'Likelihood of attending next year', required: true,
      score_style: 'numbers', score_min: 1, score_max: 10,
      reporting_name: 'Likelihood of attending next year', reporting_category: 'Loyalty',
      include_in_overall: true, weight: 1,
    },
    { id: 'sv_comments', type: 'textarea', label: 'Any other comments?', required: false },
  ];
}

const SURVEY_COMMENTS = [
  'Excellent programme this year — the net-zero workshop was a highlight.',
  'Great networking opportunities. Lunch queues were a bit long.',
  'Would love more content on adaptation next year.',
  'First conference and I found it very welcoming.',
  'Venue was easy to reach and well laid out.',
  '',
  '',
];

// ---------------------------------------------------------------------------
// Canvas pages
// ---------------------------------------------------------------------------
function pageSpecs() {
  const P = (s) => `<p>${s}</p>`;
  return [
    {
      slug: 'home', title: 'Home', order: 0,
      spec: {
        hero: { headline: 'The professional home of environmental and sustainability practice', subheadline: 'AESP supports over 6,500 members across the UK environmental profession — from students to Fellows.', ctaLabel: 'Become a member', ctaHref: '/membership', cta2Label: 'Explore events', cta2Href: '/Events', bgImageUrl: '' },
        intro: { strapline: 'Supporting the environmental profession since 1988', html: P('The Association of Environmental &amp; Sustainability Professionals is the UK membership body for people working across environmental science, sustainability, carbon management, ESG and environmental consultancy.'), h: 90 },
        sections: [
          { heading: 'What we do', type: 'cards', columns: 3, cardH: 300, cards: [
            { icon: 'GraduationCap', heading: 'Professional development', body: 'A practical CPD framework, accredited training and a mentoring programme that supports every career stage.', cta: 'Learn more', ctaHref: '/professional-development' },
            { icon: 'Users', heading: 'Community', body: 'Six special interest groups, regional networking and an active committee structure led by members.', cta: 'Find your group', ctaHref: '/about-aesp' },
            { icon: 'BookOpen', heading: 'Knowledge', body: 'Guidance, briefings and the Knowledge Hub — trusted resources written by practitioners, for practitioners.', cta: 'Visit the hub', ctaHref: '/knowledge-hub' },
          ] },
          { heading: 'Membership grades', type: 'text', html: P('From Student to Fellow, AESP has a grade for every stage of an environmental career. Our application takes around ten minutes and recommends the right grade for you.'), h: 80, cta: { label: 'Apply for membership', href: '/membership' } },
        ],
        closingHero: { headline: 'Ready to join the profession\u2019s community?', subheadline: 'Membership starts from \u00a335 a year.', ctaLabel: 'Apply now', ctaHref: '/membership', bgImageUrl: '' },
      },
    },
    {
      slug: 'about-aesp', title: 'About AESP', order: 1,
      spec: {
        hero: { headline: 'About AESP', subheadline: 'A member-led professional body founded in 1988.', bgImageUrl: '' },
        sections: [
          { heading: 'Who we are', type: 'text', html: P('AESP represents professionals working across environmental science, sustainability, carbon management, ESG and consultancy. We are governed by an elected Council and run by members through six committees.'), h: 90 },
          { heading: 'Our committees', type: 'columns', columns: [
            { h3: 'Governance', html: '<ul><li>AESP Council</li><li>Professional Standards Committee</li><li>Membership Committee</li></ul>', h: 130 },
            { h3: 'Programmes', html: '<ul><li>Education &amp; CPD Committee</li><li>Events Committee</li><li>Sustainability Policy Committee</li></ul>', h: 130 },
          ] },
          { heading: 'Special interest groups', type: 'text', html: P('Members shape the profession through six special interest groups: Carbon &amp; Net Zero, Biodiversity, Environmental Impact Assessment, ESG &amp; Corporate Sustainability, Renewable Energy and Sustainable Construction.'), h: 90 },
        ],
      },
    },
    {
      slug: 'membership', title: 'Membership', order: 2,
      spec: {
        hero: { headline: 'Join AESP', subheadline: 'Five grades. One community. Membership from \u00a335 a year.', ctaLabel: 'Apply for membership', ctaHref: '/form/apply-for-aesp-membership', bgImageUrl: '' },
        sections: [
          { heading: 'Membership grades', type: 'cards', columns: 3, cardH: 280, cards: [
            { heading: 'Student — \u00a335', body: 'For anyone studying a relevant subject full or part time.' },
            { heading: 'Graduate — \u00a385', body: 'For early-career professionals with under three years\u2019 experience.' },
            { heading: 'Professional — \u00a3175', body: 'Full professional grade with the MAESP post-nominal.' },
            { heading: 'Fellow — \u00a3245', body: 'For senior, recognised practitioners. FAESP post-nominal.' },
            { heading: 'Retired — \u00a370', body: 'Stay connected to the profession after your career.' },
          ] },
          { heading: 'How to apply', type: 'text', html: P('Complete the online application and we will recommend the grade that fits your experience. Applications are reviewed by the Membership Committee, normally within ten working days.'), h: 80, cta: { label: 'Start your application', href: '/form/apply-for-aesp-membership' } },
        ],
      },
    },
    {
      slug: 'professional-development', title: 'Professional Development', order: 3,
      spec: {
        hero: { headline: 'Professional development', subheadline: 'CPD, training and mentoring to grow your career.', bgImageUrl: '' },
        sections: [
          { heading: 'CPD at AESP', type: 'text', html: P('AESP members commit to 30 hours of CPD each calendar year, of which 10 hours should be structured learning. Our CPD guidance in the Knowledge Hub explains what counts and how to plan your year.'), h: 90 },
          { heading: 'Ways to learn', type: 'columns', columns: [
            { h3: 'Training & events', html: '<ul><li>Accredited CPD masterclasses</li><li>Practitioner workshops</li><li>Free member webinars</li></ul>', h: 130 },
            { h3: 'Mentoring', html: '<ul><li>Structured mentor matching</li><li>Support for early-career members</li><li>Recognition for mentors</li></ul>', h: 130 },
          ] },
        ],
      },
    },
    {
      slug: 'knowledge-hub', title: 'Knowledge Hub', order: 4,
      spec: {
        hero: { headline: 'Knowledge Hub', subheadline: 'Guidance, briefings and practice notes for the environmental profession.', ctaLabel: 'Browse resources', ctaHref: '/Resources', bgImageUrl: '' },
        sections: [
          { heading: 'What you\u2019ll find', type: 'text', html: P('The Knowledge Hub brings together AESP guidance including CPD guidance, the Member Code of Conduct, the Net Zero Practitioner Guide and biodiversity briefings. Most resources are exclusive to members.'), h: 90, cta: { label: 'Go to the resource library', href: '/Resources' } },
        ],
      },
    },
    {
      slug: 'policy-advocacy', title: 'Policy & Advocacy', order: 5,
      spec: {
        hero: { headline: 'Policy &amp; advocacy', subheadline: 'The profession\u2019s voice in environmental policy.', bgImageUrl: '' },
        sections: [
          { heading: 'How we influence', type: 'text', html: P('Through the Sustainability Policy Committee, AESP responds to government consultations, briefs parliamentarians and publishes position papers on the issues that matter to the profession — from environmental assessment reform to corporate net-zero reporting.'), h: 100 },
        ],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
export async function seedEngagement(ctx, { plans, adminEmail }) {
  const { sb, tenantId, dates, upsert, log } = ctx;
  const rng = createRng('aesp-v1:engagement');
  const persona = (key) => plans.find((p) => p.demoKey === key);
  const sarah = persona('sarah-mitchell');
  const james = persona('james-walker');
  const emily = persona('emily-foster');

  const activeMembers = plans.filter((p) => p.memberId && p.memberStatus === 'active' && p.grade);
  const byGrade = (g) => activeMembers.filter((p) => p.grade === g);
  const seniorPool = rng.shuffle([...byGrade('fellow'), ...byGrade('professional')]);
  const bookingRef = (slug, i) => `DEMO-${slug.slice(0, 18).toUpperCase().replace(/[^A-Z0-9]/g, '')}-${String(i + 1).padStart(3, '0')}`;

  // ==== 1. Special interest groups =========================================
  const sigIds = {};
  let sigAssignments = 0;
  for (const sig of SIGS) {
    const group = await upsert('member_group', { name: sig.name }, {
      description: `${sig.name} Special Interest Group`,
      about_the_group: sig.blurb,
      who_is_it_for: 'Open to all AESP members with an interest in this area.',
      roles: ['Chair', 'Vice Chair', 'Member'],
      default_self_join_role: 'Member',
      allow_self_join: true,
      is_active: true,
    });
    sigIds[sig.name] = group.id;

    // Deterministic membership: interest-matched members first, then fill.
    const matched = activeMembers.filter((p) => (p.interests || []).includes(sig.name));
    const rest = rng.shuffle(activeMembers.filter((p) => !matched.includes(p)));
    const roster = [...rng.shuffle(matched), ...rest].slice(0, sig.target);
    // Sarah Mitchell must be in Carbon & Net Zero (activity trail).
    if (sig.name === 'Carbon & Net Zero' && sarah?.memberId && !roster.some((p) => p.memberId === sarah.memberId)) {
      roster[roster.length - 1] = sarah;
    }
    const assignments = roster.map((p, i) => ({
      memberId: p.memberId,
      role: i === 0 ? 'Chair' : i === 1 ? 'Vice Chair' : 'Member',
    }));
    await pmap(assignments, (a) =>
      upsert('member_group_assignment', { group_id: group.id, member_id: a.memberId }, { group_role: a.role }), 8);
    sigAssignments += assignments.length;
  }
  ctx.setCount('sig_groups', SIGS.length);
  ctx.setCount('sig_assignments', sigAssignments);

  // ==== 2. Committees =======================================================
  let committeeAssignments = 0;
  const committeeUsage = new Map(); // memberId -> count, keeps overlap believable
  for (const c of COMMITTEES) {
    const group = await upsert('member_group', { name: c.name }, {
      description: c.blurb,
      about_the_group: c.blurb,
      roles: c.roles,
      allow_self_join: false,
      is_active: true,
    });
    const pool = seniorPool.filter((p) => (committeeUsage.get(p.memberId) || 0) < 2);
    const roster = [];
    // James Walker is President of Council.
    if (c.name === 'AESP Council' && james?.memberId) roster.push(james);
    for (const p of pool) {
      if (roster.length >= c.size) break;
      if (!roster.some((r) => r.memberId === p.memberId)) roster.push(p);
    }
    const assignments = roster.map((p, i) => ({
      memberId: p.memberId,
      role: i < c.officer.length ? c.officer[i] : c.fill,
      isAdmin: i === 0,
    }));
    for (const a of assignments) committeeUsage.set(a.memberId, (committeeUsage.get(a.memberId) || 0) + 1);
    await pmap(assignments, (a) =>
      upsert('member_group_assignment', { group_id: group.id, member_id: a.memberId },
        { group_role: a.role, is_group_admin: a.isAdmin }), 8);
    committeeAssignments += assignments.length;
  }
  ctx.setCount('committees', COMMITTEES.length);
  ctx.setCount('committee_assignments', committeeAssignments);

  // ==== 3. Events (simple) + bookings ======================================
  // Plan phase (all RNG here), then parallel persistence.
  const eventPlans = [];
  const planEvent = (def, startDate, isPast) => {
    const endDate = new Date(startDate.getTime() + (def.days ? def.days * 86400000 : 0) + 2 * 3600000);
    const audiencePool = def.audience
      ? activeMembers.filter((p) => def.audience.includes(p.grade))
      : activeMembers;
    const roster = rng.shuffle(audiencePool).slice(0, def.bookings);
    const bookings = roster.map((p, i) => {
      // Mixed states: past events get attended / no-show / cancelled;
      // upcoming events are confirmed with an occasional cancellation.
      let status = 'confirmed';
      let checkedIn = false;
      if (isPast) {
        const roll = rng.next();
        if (roll < 0.10) status = 'cancelled';
        else if (roll < 0.24) checkedIn = false; // no-show: confirmed, never checked in
        else checkedIn = true;                   // attended
      } else if (rng.chance(0.05)) {
        status = 'cancelled';
      }
      const paid = def.price > 0 && status !== 'cancelled';
      return {
        plan: p,
        i,
        status,
        checkedInAt: isPast && checkedIn && status === 'confirmed'
          ? new Date(startDate.getTime() + rng.int(5, 90) * 60000).toISOString()
          : null,
        paymentMethod: paid ? (rng.chance(0.65) ? 'card' : 'account') : null,
        createdAt: new Date(startDate.getTime() - rng.int(5, 45) * 86400000).toISOString(),
      };
    });
    eventPlans.push({ def, startDate, endDate, isPast, bookings });
  };
  for (const def of PAST_EVENTS) planEvent(def, dates.daysAgo(def.daysAgo), true);
  for (const def of UPCOMING_EVENTS) planEvent(def, dates.daysAhead(def.daysAhead), false);

  // Sarah Mitchell must have attended the historic net-zero webinar (trail).
  const nzPlan = eventPlans.find((e) => e.def.key === 'net-zero-getting-started');
  if (sarah?.memberId && nzPlan && !nzPlan.bookings.some((b) => b.plan.memberId === sarah.memberId)) {
    nzPlan.bookings[0] = {
      plan: sarah, i: 0, status: 'confirmed',
      checkedInAt: new Date(nzPlan.startDate.getTime() + 6 * 60000).toISOString(),
      paymentMethod: null,
      createdAt: new Date(nzPlan.startDate.getTime() - 12 * 86400000).toISOString(),
    };
  }

  const eventIdByKey = {};
  let bookingCount = 0;
  for (const ep of eventPlans) {
    const { def } = ep;
    const event = await upsert('event', { slug: `demo-${def.key}` }, {
      title: def.title,
      program_tag: def.tag,
      event_type: def.tag,
      summary: def.summary,
      description: `<p>${def.summary}</p>${def.membersOnly ? '<p>This event is open to AESP members only.</p>' : ''}`,
      status: 'published',
      start_date: ep.startDate.toISOString(),
      end_date: ep.endDate.toISOString(),
      location: def.location,
      is_online: !!def.online,
      timezone: 'Europe/London',
      ticket_price: def.price,
      available_seats: def.seats ?? null,
      is_unlimited_registration: def.seats == null,
      is_sample: true,
      is_featured: !ep.isPast && def.key === 'net-zero-strategy-delivery',
    });
    eventIdByKey[def.key] = event.id;
    await pmap(ep.bookings, (b) =>
      upsert('booking', { event_id: event.id, member_id: b.plan.memberId }, {
        attendee_email: b.plan.email,
        attendee_first_name: b.plan.first,
        attendee_last_name: b.plan.last,
        attendee_job_title: b.plan.job,
        organization_id: null,
        event_name: def.title,
        ticket_price: def.price,
        total_cost: b.status === 'cancelled' ? 0 : def.price,
        payment_method: b.paymentMethod,
        booking_reference: bookingRef(def.key, b.i),
        status: b.status,
        checked_in_at: b.checkedInAt,
        created_at: b.createdAt,
      }), 8);
    bookingCount += ep.bookings.length;
  }
  ctx.setCount('events', eventPlans.length);
  ctx.setCount('bookings', bookingCount);

  // ==== 4. Annual Conference 2026 (complex event, capacity 350) ============
  const confStart = dates.daysAhead(75);
  const confEnd = new Date(confStart.getTime() + 86400000 + 8 * 3600000);
  const conf = await upsert('complex_event', { slug: 'demo-aesp-annual-conference-2026' }, {
    title: 'AESP Annual Conference 2026',
    summary: 'Two days of keynotes, workshops and networking for the environmental profession.',
    description: '<p>The flagship event of the AESP calendar: two days in Birmingham covering net zero, nature recovery, ESG assurance and the future of the profession. Open to members and non-members.</p>',
    status: 'published',
    event_type: 'Conference',
    program_tag: 'Conference',
    start_date: confStart.toISOString(),
    end_date: confEnd.toISOString(),
    location: 'ICC Birmingham',
    timezone: 'Europe/London',
    available_seats: 350,
    is_unlimited_registration: false,
    is_online: false,
  });
  const tcMember = await upsert('complex_event_ticket_class', { complex_event_id: conf.id, name: 'Member Delegate' }, {
    price: 295, is_free: false, visibility_mode: 'members_only',
    available_count: 300, is_unlimited_tickets: false, all_tracks: true, display_order: 0,
  });
  const tcPublic = await upsert('complex_event_ticket_class', { complex_event_id: conf.id, name: 'Non-member Delegate' }, {
    price: 395, is_free: false, visibility_mode: 'members_and_public',
    available_count: 50, is_unlimited_tickets: false, all_tracks: true, display_order: 1,
  });

  const confRoster = rng.shuffle(activeMembers).slice(0, 46);
  const confBookings = confRoster.map((p, i) => ({
    plan: p, i,
    cancelled: rng.chance(0.06),
    method: rng.chance(0.7) ? 'card' : 'invoice',
    createdAt: new Date(dates.now.getTime() - rng.int(1, 30) * 86400000).toISOString(),
  }));
  await pmap(confBookings, (b) =>
    upsert('complex_event_booking', { event_id: conf.id, member_id: b.plan.memberId }, {
      booking_reference: bookingRef('conf2026', b.i),
      attendee_email: b.plan.email,
      attendee_first_name: b.plan.first,
      attendee_last_name: b.plan.last,
      attendee_job_title: b.plan.job,
      ticket_class_id: tcMember.id,
      ticket_class_name: 'Member Delegate',
      ticket_price: 295,
      payment_method: b.method,
      payment_status: b.cancelled ? 'refunded' : 'paid',
      total_paid: b.cancelled ? 0 : 295,
      currency: 'GBP',
      status: b.cancelled ? 'cancelled' : 'confirmed',
      created_at: b.createdAt,
    }), 8);
  ctx.setCount('conference_bookings', confBookings.length);
  void tcPublic;

  // ==== 5. Membership application form + Emily Foster's submission ========
  const appForm = await upsert('form', { slug: 'apply-for-aesp-membership' }, {
    name: 'Apply for AESP Membership',
    description: 'Membership application for the Association of Environmental & Sustainability Professionals.',
    fields: applicationFormFields(),
    visibility_rules: applicationFormRules(),
    is_active: true,
    is_application_form: true,
    application_level: 'member',
    auto_create_entity: false,
    require_authentication: false,
    submit_button_text: 'Submit application',
    success_message: 'Thank you — your application has been received. The Membership Committee will be in touch within ten working days.',
    layout_type: 'standard',
  });

  if (emily?.memberId) {
    await upsert('form_submission', { form_id: appForm.id, idempotency_key: 'demo-aesp-application-emily-foster' }, {
      form_name: 'Apply for AESP Membership',
      submitted_by_email: emily.email,
      submitted_by_name: `${emily.first} ${emily.last}`,
      created_member_id: emily.memberId,
      status: 'new',
      created_date: dates.daysAgo(4).toISOString(),
      submission_data: {
        af_full_name: 'Emily Foster',
        af_email: emily.email,
        af_phone: '07700 900123',
        af_address: 'Leeds, West Yorkshire',
        af_employment_status: 'Employed',
        af_employer: 'Northbridge Sustainability Partners',
        af_job_title: 'Environmental Advisor',
        af_studying: false,
        af_qualification: 'MSc Environmental Management',
        af_subject: 'Environmental Management',
        af_institution: 'University of Leeds',
        af_years_experience: YEARS_OPTIONS[1],
        af_responsibilities: 'ESG reporting, environmental compliance audits and client sustainability strategy support.',
      },
    });
  }

  // Sarah Mitchell's historical (approved) application — real submission row.
  if (sarah?.memberId) {
    await upsert('form_submission', { form_id: appForm.id, idempotency_key: 'demo-aesp-application-sarah-mitchell' }, {
      form_name: 'Apply for AESP Membership',
      submitted_by_email: sarah.email,
      submitted_by_name: `${sarah.first} ${sarah.last}`,
      created_member_id: sarah.memberId,
      status: 'actioned',
      status_updated_by: adminEmail,
      status_updated_at: new Date(sarah.joinDate.getTime() + 6 * 86400000).toISOString(),
      processing_notes: 'Approved — Professional Member. Membership payment received.',
      created_date: sarah.joinDate.toISOString(),
      submission_data: {
        af_full_name: 'Sarah Mitchell',
        af_email: sarah.email,
        af_employment_status: 'Employed',
        af_employer: 'Greenstone Environmental Consulting',
        af_job_title: 'Environmental Consultant',
        af_studying: false,
        af_years_experience: YEARS_OPTIONS[1],
        af_responsibilities: 'Carbon assessments and environmental permitting for commercial clients.',
      },
    });
    // Group activity feed row (same shape the app writes on joins).
    await upsert('member_group_activity', { member_id: sarah.memberId, group_id: sigIds['Carbon & Net Zero'], action: 'joined' }, {
      group_name: 'Carbon & Net Zero',
      actor_email: sarah.email,
    });
  }

  // ==== 6. Conference feedback survey + responses ==========================
  const svFields = surveyFields();
  const surveySettings = {
    status: 'published',
    current_version: 1,
    response_identity: 'identified',
    anonymity_threshold: 3,
    intro_text: 'Thank you for attending the AESP Annual Conference 2025 — tell us how it went.',
    thank_you_text: 'Thanks for your feedback. See you next year!',
  };
  const surveyForm = await upsert('form', { slug: 'aesp-annual-conference-feedback' }, {
    name: 'AESP Annual Conference Feedback',
    description: 'Post-event feedback for the AESP Annual Conference 2025.',
    form_type: 'survey',
    fields: svFields,
    visibility_rules: [],
    is_active: true,
    survey_settings: surveySettings,
    submit_button_text: 'Submit feedback',
  });
  const version = await upsert('survey_version', { form_id: surveyForm.id, version_number: 1 }, {
    fields: svFields,
    pages: [],
    visibility_rules: [],
    survey_settings: surveySettings,
    published_by: adminEmail,
  }, { insertOnly: true });

  const conf2025Id = eventIdByKey['annual-conference-2025'];
  const conf2025Plan = eventPlans.find((e) => e.def.key === 'annual-conference-2025');
  const respondents = conf2025Plan.bookings.filter((b) => b.checkedInAt).slice(0, 26);
  // Plan responses deterministically (skew positive, with spread).
  const versionSnapshot = { fields: svFields, pages: [], visibility_rules: [] };
  const responsePlans = respondents.map((b, i) => {
    const base = rng.weighted([{ value: 5, weight: 40 }, { value: 4, weight: 38 }, { value: 3, weight: 16 }, { value: 2, weight: 6 }]);
    const jitter = () => Math.max(1, Math.min(5, base + rng.int(-1, 1)));
    const data = {
      sv_overall: { score: base },
      sv_speakers: { score: jitter() },
      sv_relevance: { score: jitter() },
      sv_venue: { score: jitter() },
      sv_return: { score: Math.max(1, Math.min(10, base * 2 + rng.int(-2, 0))) },
    };
    const comment = rng.pick(SURVEY_COMMENTS);
    if (comment) data.sv_comments = comment;
    return { b, i, data, createdAt: new Date(conf2025Plan.endDate.getTime() + rng.int(1, 6) * 86400000).toISOString() };
  });

  const assignment = await upsert('event_survey_assignment', { form_id: surveyForm.id, event_id: conf2025Id }, {
    survey_version_id: version.id,
    survey_version_number: 1,
    event_type: 'event',
    event_title: 'AESP Annual Conference 2025',
    event_start_date: conf2025Plan.startDate.toISOString(),
    status: 'active',
    access_mode: 'authenticated',
    token: 'demo-aesp-conf-2025-feedback',
    // Cached response fields are derived AFTER the responses are inserted:
    // an AFTER INSERT trigger on form_submission increments response_count,
    // so pre-seeding it would double-count on a fresh install.
    response_count: 0,
    created_by: adminEmail,
    first_response_at: null,
    last_response_at: null,
  });

  await pmap(responsePlans, async (r) => {
    // Score exactly as the app does (same engine, same snapshot rules).
    const scored = scoreSubmission(versionSnapshot, r.data);
    if (scored.errors.length) throw new Error(`[seed] survey scoring failed: ${scored.errors.join('; ')}`);
    const submission = await upsert('form_submission', { form_id: surveyForm.id, idempotency_key: `demo-survey-conf2025-${r.b.plan.demoKey}` }, {
      form_name: 'AESP Annual Conference Feedback',
      submitted_by_email: r.b.plan.email,
      submitted_by_name: `${r.b.plan.first} ${r.b.plan.last}`,
      created_member_id: r.b.plan.memberId,
      event_id: conf2025Id,
      survey_assignment_id: assignment.id,
      survey_version_id: version.id,
      survey_score_weighted: scored.overallWeighted,
      survey_score_unweighted: scored.overallUnweighted,
      is_anonymous: false,
      status: 'actioned',
      created_date: r.createdAt,
      submission_data: r.data,
    });
    for (const a of scored.answers) {
      await upsert('survey_answer', { submission_id: submission.id, field_id: a.field_id }, {
        form_id: surveyForm.id,
        survey_version_id: version.id,
        reporting_name: a.reporting_name,
        reporting_category: a.reporting_category,
        raw_score: a.raw_score,
        is_na: a.is_na,
        normalised_score: a.normalised_score,
        weight: a.weight,
        weighted_contribution: a.weighted_contribution,
        included_in_overall: a.included_in_overall,
      });
    }
  }, 6);

  // Derive the assignment's cached response fields from the actual rows
  // (exactly once, after insert) and assert consistency: the AFTER INSERT
  // trigger bumps response_count on fresh inserts but not on reseed updates.
  const { data: respRows, error: respErr } = await sb.from('form_submission')
    .select('created_date')
    .eq('tenant_id', tenantId)
    .eq('survey_assignment_id', assignment.id);
  if (respErr) throw new Error(`[seed] survey response readback failed: ${respErr.message}`);
  if (respRows.length !== responsePlans.length) {
    throw new Error(`[seed] survey response count mismatch: expected ${responsePlans.length}, found ${respRows.length}`);
  }
  const respDates = respRows.map((r) => r.created_date).sort();
  const { error: aggErr } = await sb.from('event_survey_assignment')
    .update({
      response_count: respRows.length,
      first_response_at: respDates[0] || null,
      last_response_at: respDates[respDates.length - 1] || null,
    })
    .eq('id', assignment.id)
    .eq('tenant_id', tenantId);
  if (aggErr) throw new Error(`[seed] survey assignment aggregate update failed: ${aggErr.message}`);
  ctx.setCount('survey_responses', responsePlans.length);

  // ==== 7. Canvas pages + navigation =======================================
  const pages = pageSpecs();
  for (const p of pages) {
    const design = buildNeutralDesign(p.spec);
    await upsert('i_edit_page', { slug: p.slug, builder_type: 'canvas' }, {
      title: p.title,
      description: `AESP ${p.title} page (demo content).`,
      status: 'published',
      layout_type: 'public',
      canvas_design: design,
      published_at: dates.daysAgo(30).toISOString(),
    });
  }
  const NAV = [
    ['Home', 'home'],
    ['About AESP', 'about-aesp'],
    ['Membership', 'membership'],
    ['Professional Development', 'professional-development'],
    ['Events', 'Events'],
    ['Knowledge Hub', 'knowledge-hub'],
    ['News & Insights', 'News'],
    ['Policy & Advocacy', 'policy-advocacy'],
  ];
  for (const [i, [title, url]] of NAV.entries()) {
    await upsert('navigation_item', { title, location: 'top_nav' }, {
      url, link_type: 'internal', display_order: i, is_active: true, open_in_new_tab: false,
    });
  }
  // Deactivate provision-default top-nav items that aren't part of the demo
  // nav (idempotent; leaves the rows in place for the tenant owner).
  const navTitles = NAV.map(([t]) => t);
  const { error: navErr } = await sb.from('navigation_item')
    .update({ is_active: false })
    .eq('tenant_id', tenantId)
    .eq('location', 'top_nav')
    .not('title', 'in', `(${navTitles.map((t) => `"${t}"`).join(',')})`);
  if (navErr) throw new Error(`[seed] deactivate default nav failed: ${navErr.message}`);
  ctx.setCount('canvas_pages', pages.length);
  ctx.setCount('nav_items', NAV.length);

  // ==== 8. News + knowledge resources ======================================
  for (const n of NEWS) {
    await upsert('news_post', { slug: `demo-${n.slug}` }, {
      title: n.title,
      summary: n.body[0],
      content: n.body.map((s) => `<p>${s}</p>`).join(''),
      status: 'published',
      published_date: dates.daysAgo(n.daysAgo).toISOString(),
      author_name: 'AESP Communications',
      tags: n.tags,
    });
  }
  for (const [i, r] of RESOURCES.entries()) {
    await upsert('resource', { title: r.title }, {
      description: r.desc,
      resource_type: 'external_link',
      target_url: `https://aesp.example.com/resources/${r.slug}`,
      open_in_new_tab: true,
      status: 'active',
      is_public: r.isPublic,
      is_sample: true,
      release_date: dates.isoDate(dates.daysAgo(60 + i * 25)),
      author_name: 'AESP',
      tags: ['Guidance'],
    });
  }
  ctx.setCount('news_posts', NEWS.length);
  ctx.setCount('resources', RESOURCES.length);

  log(`[seed] AESP engagement: ${SIGS.length} SIGs (${sigAssignments} members), ${COMMITTEES.length} committees (${committeeAssignments} members), ${eventPlans.length} events + conference, ${bookingCount + confBookings.length} bookings, ${responsePlans.length} survey responses, ${pages.length} pages, ${NEWS.length} news, ${RESOURCES.length} resources.`);
}
