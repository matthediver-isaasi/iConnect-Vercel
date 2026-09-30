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

// Knowledge Hub resources. `download` resources carry authored PDF content
// (generated + stored by demo-seeds/resource-pdfs.mjs at seed time); `video`
// resources embed real, stable YouTube videos (ids hardcoded — no search at
// seed time). Exported for the resource-pdfs test file.
export const RESOURCES = [
  {
    slug: 'cpd-guidance', title: 'AESP CPD Guidance', isPublic: false,
    desc: 'How the AESP CPD framework works: the 30-hour annual expectation, structured vs self-directed learning, and how to record activity.',
    pdf: {
      subtitle: 'Continuing professional development framework for AESP members — updated for the refreshed framework.',
      sections: [
        { heading: 'The CPD expectation', paragraphs: [
          'Every practising AESP member is expected to complete at least 30 hours of continuing professional development in each membership year. The expectation applies to Graduate Members, Professional Members (MAESP) and Fellows (FAESP); Student and Retired members are encouraged, but not required, to record CPD.',
          'The 30-hour figure is a minimum, not a target. Members working towards chartership, changing specialism or taking on new responsibilities will typically complete considerably more. What matters most is that your CPD is planned, relevant to your practice, and reflected upon.',
        ] },
        { heading: 'Structured and self-directed learning', paragraphs: [
          'At least 15 of your 30 hours must be structured learning: activity with defined learning objectives and some form of external input or assessment.',
          'The remaining hours may be self-directed: reading, research and informal learning that you plan and evaluate yourself.',
        ], bullets: [
          'Structured: accredited training courses, AESP webinars and conference sessions, formal mentoring (as mentor or mentee), university modules, assessed e-learning.',
          'Self-directed: technical reading, policy and consultation review, preparing talks or articles, structured on-the-job learning with recorded reflection.',
          'Not CPD: routine duties without new learning, unrecorded networking, repeating training you have already mastered.',
        ] },
        { heading: 'Planning your CPD year', paragraphs: [
          'Good CPD starts with a short plan. At the beginning of each membership year, identify two to four development objectives linked to your current role or your intended career direction, and note the activities you expect to use to meet them.',
          'Review the plan mid-year. Objectives change — a new project, a new regulation or a role change can all redirect your development needs. The plan is a working document, not a commitment you are audited against.',
        ] },
        { heading: 'Recording and reflection', paragraphs: [
          'Record each activity as soon as practical: the date, duration, type (structured or self-directed), and a short reflection — what you learned and how it changes your practice. Reflections of two or three sentences are sufficient; the discipline of writing them is the point.',
          'AESP audits a random sample of CPD records each year. Members selected for audit are asked to share their record and plan; the review is supportive, and the most common outcome is simply feedback on balance across activity types.',
        ] },
        { heading: 'Support from AESP', paragraphs: [
          'The Education & CPD Committee maintains a programme of free member webinars, an annual conference with recorded sessions, and the mentoring programme — all of which count as structured CPD. If you are unsure whether an activity qualifies, contact the membership team; a short description is normally enough for a same-week answer.',
        ] },
      ],
    },
  },
  {
    slug: 'code-of-conduct', title: 'Member Code of Conduct', isPublic: true,
    desc: 'The professional and ethical standards expected of every AESP member, and how concerns are handled.',
    pdf: {
      subtitle: 'The professional and ethical standards expected of every member of the Association of Environmental & Sustainability Professionals.',
      sections: [
        { heading: 'Purpose and scope', paragraphs: [
          'This Code sets out the standards of professional conduct expected of all AESP members, in every grade, wherever they practise. It exists to protect the public, the environment, the standing of the profession and members themselves.',
          'Membership of AESP is an undertaking to observe the Code. The Code applies to professional activity in employment, self-employment, voluntary roles and public statements made in a professional capacity.',
        ] },
        { heading: 'Professional integrity', bullets: [
          'Act honestly and impartially, and never knowingly mislead a client, employer, regulator or the public.',
          'Present environmental data, assessments and conclusions accurately, including uncertainty and limitations.',
          'Declare conflicts of interest promptly and withdraw from work where independence is compromised.',
          'Do not claim qualifications, experience or competence you do not hold.',
        ] },
        { heading: 'Competence and duty of care', bullets: [
          'Undertake only work you are competent to perform, or work under appropriate supervision.',
          'Keep knowledge and skills current through continuing professional development.',
          'Have proper regard for the health, safety and welfare of anyone affected by your work.',
          'Exercise a duty of care to the environment that goes beyond minimum legal compliance where practicable.',
        ] },
        { heading: 'Respect for others', paragraphs: [
          'Members must treat colleagues, clients, communities and the public with respect, and must not discriminate on any protected ground. Members holding positions of influence — employers, supervisors, mentors, committee members — carry a particular responsibility to support fair treatment and inclusion within the profession.',
        ] },
        { heading: 'Raising concerns and complaints', paragraphs: [
          'A member who believes another member has breached this Code may raise a concern with the Professional Standards Committee. Concerns are reviewed confidentially; where a case to answer exists, a panel that excludes anyone with a conflict of interest hears it.',
          'Sanctions range from advice and required training through to suspension or expulsion from membership. The member concerned has a right to be heard and a right of appeal to Council. Malicious or vexatious complaints are themselves a breach of this Code.',
        ] },
      ],
    },
  },
  {
    slug: 'net-zero-practitioner-guide', title: 'Net Zero Practitioner Guide', isPublic: false,
    desc: 'A practical guide to scoping, measuring and delivering organisational net-zero strategies.',
    pdf: {
      subtitle: 'A practical guide for members scoping, measuring and delivering credible organisational net-zero strategies.',
      sections: [
        { heading: 'What "net zero" means in practice', paragraphs: [
          'A credible organisational net-zero commitment means reducing greenhouse gas emissions across the full value chain to a residual level consistent with limiting warming to 1.5°C, and neutralising the residual with durable removals. It is not achieved by offsetting business-as-usual emissions.',
          'Practitioners should anchor client commitments to a recognised standard, and be explicit about target years, interim milestones and the boundary of the commitment.',
        ] },
        { heading: 'Setting the boundary', paragraphs: [
          'The most common failure in net-zero work is a boundary drawn around what is easy to measure rather than what is material. Begin with a screening exercise across all scope 3 categories; for most organisations a small number of categories — purchased goods and services, use of sold products, or investments — dominate the footprint.',
        ], bullets: [
          'Scope 1: direct emissions from owned or controlled sources.',
          'Scope 2: purchased electricity, heat and steam (report location- and market-based).',
          'Scope 3: all other value-chain emissions — typically 70–95% of the total footprint.',
        ] },
        { heading: 'Building the baseline', paragraphs: [
          'Choose a representative baseline year and document every estimation method and emission factor source. Spend-based estimates are acceptable for screening but should be progressively replaced with activity data in material categories. Record data quality alongside the numbers: a footprint is a management tool, and decision-makers need to know which figures they can lean on.',
        ] },
        { heading: 'From target to delivery', paragraphs: [
          'Turn the target into a costed abatement programme: an initiative pipeline with owners, capital requirements and expected reductions by year. Governance matters more than analysis at this stage — reductions happen when a named executive owns the trajectory and progress is reported with the same rigour as financial results.',
        ], bullets: [
          'Prioritise energy efficiency and electrification before procurement of residual offsets.',
          'Engage the supply chain early: supplier data programmes take two to three reporting cycles to mature.',
          'Publish progress annually against the interim milestones, including where you are behind.',
        ] },
        { heading: 'Common pitfalls', bullets: [
          'Announcing a target before the scope 3 screening is complete.',
          'Relying on market-based instruments to show reductions while location-based emissions rise.',
          'Treating carbon credits as a substitute for, rather than a complement to, abatement.',
          'Losing the baseline: undocumented methodology changes that make progress unverifiable.',
        ] },
      ],
    },
  },
  {
    slug: 'bng-briefing', title: 'Biodiversity Net Gain Briefing', isPublic: false,
    desc: 'Briefing note on statutory biodiversity net gain: metric, exemptions and emerging practice.',
    pdf: {
      subtitle: 'Briefing note for members on statutory biodiversity net gain in England: the metric, exemptions and emerging practice.',
      sections: [
        { heading: 'The statutory requirement', paragraphs: [
          'Statutory biodiversity net gain (BNG) requires most new development in England to deliver at least a 10% measurable improvement in biodiversity value, calculated using the statutory biodiversity metric and secured for at least 30 years.',
          'The requirement is discharged through a biodiversity gain plan approved by the local planning authority before development may lawfully commence.',
        ] },
        { heading: 'How the metric works', paragraphs: [
          'The statutory metric converts habitats into biodiversity units based on their size, distinctiveness, condition and strategic significance. Units are calculated separately for area habitats, hedgerows and watercourses — gains in one module cannot offset losses in another.',
        ], bullets: [
          'Baseline surveys must reflect the habitats present at the required date; degradation after that date is disregarded.',
          'Trading rules require like-for-like or better: losses of high-distinctiveness habitat need bespoke compensation.',
          'Creation and enhancement carry risk multipliers for difficulty, time to target condition and off-site distance.',
        ] },
        { heading: 'The mitigation hierarchy still applies', paragraphs: [
          'BNG supplements, and does not replace, the mitigation hierarchy: avoid, minimise, restore, then compensate. On-site provision is preferred; off-site units and, as a last resort, statutory biodiversity credits follow in that order. Practitioners should document the hierarchy reasoning in the gain plan — authorities increasingly test it.',
        ] },
        { heading: 'Emerging practice', bullets: [
          'Early baseline surveys de-risk programmes: retrospective baselining is the most common source of dispute.',
          'Habitat management and monitoring plans are maturing into standard 30-year documents with five-yearly review points.',
          'A functioning off-site unit market is developing; price discovery remains uneven between regions.',
          'Condition assessment is the metric\u2019s most subjective input — record the evidence behind every condition score.',
        ] },
      ],
    },
  },
  {
    slug: 'environmental-careers-guide', title: 'Environmental Careers Guide', isPublic: true,
    desc: 'Routes into the environmental profession, typical roles and the skills employers look for.',
    pdf: {
      subtitle: 'Routes into the environmental profession, typical roles, and the skills employers look for.',
      sections: [
        { heading: 'A profession, many routes in', paragraphs: [
          'People join the environmental profession from environmental science and ecology degrees, from engineering, geography, law and economics, and increasingly through mid-career moves from other sectors. There is no single "correct" entry route: employers consistently value demonstrable skills and genuine engagement over any particular qualification title.',
        ] },
        { heading: 'Where environmental professionals work', bullets: [
          'Consultancy: multidisciplinary assessment, ESG advisory, carbon and ecology services for developer and corporate clients.',
          'Industry and infrastructure: in-house environment, sustainability and compliance teams in energy, construction, water, transport and manufacturing.',
          'Public sector: local authority planning and environment teams, regulators and government departments.',
          'NGOs, charities and research: conservation delivery, campaigning, environmental monitoring and academia.',
        ] },
        { heading: 'Typical early-career roles', paragraphs: [
          'Graduate schemes in consultancy and industry usually rotate through two or three technical teams over two years. Common first roles include graduate environmental consultant, assistant ecologist, junior carbon analyst, environmental compliance officer and sustainability coordinator.',
          'Fieldwork-heavy roles (ecology, land condition, air quality monitoring) tend to be seasonal in workload; office-based analytical roles (carbon, ESG reporting) follow corporate reporting cycles. Try both early if you can.',
        ] },
        { heading: 'Skills employers ask for', bullets: [
          'Technical grounding in at least one specialism, with awareness of neighbouring disciplines.',
          'Data confidence: spreadsheets as a minimum; GIS, Python or R are strong differentiators.',
          'Clear writing — most environmental work is ultimately delivered as a written report.',
          'Commercial awareness: budgets, deadlines and client relationships matter from day one.',
          'Site experience and a full driving licence widen options considerably for field roles.',
        ] },
        { heading: 'How AESP can help', paragraphs: [
          'Student membership is inexpensive and includes the Knowledge Hub, the mentoring programme and member rates for events. The annual Environmental Careers Week connects students with practitioners across the UK, and the AESP job board lists vacancies from graduate to director level. Professional membership and, later, Fellowship provide a recognised marker of competence as your career develops.',
        ] },
      ],
    },
  },
  {
    slug: 'mentoring-handbook', title: 'Mentoring Handbook', isPublic: false,
    desc: 'Handbook for mentors and mentees taking part in the AESP mentoring programme.',
    pdf: {
      subtitle: 'Handbook for mentors and mentees taking part in the AESP mentoring programme.',
      sections: [
        { heading: 'About the programme', paragraphs: [
          'The AESP mentoring programme matches early-career members with experienced practitioners for a structured 12-month mentoring relationship. Matching considers specialism, sector and the mentee\u2019s stated goals; mentors and mentees are introduced by the membership team and agree their own meeting pattern.',
          'Mentoring is a development relationship, not line management, sponsorship or technical review. The mentee owns the agenda; the mentor contributes experience, perspective and challenge.',
        ] },
        { heading: 'Expectations of mentees', bullets: [
          'Set two or three specific goals for the year and share them at the first meeting.',
          'Prepare for each session: a short note of what has happened and what you want to discuss.',
          'Own your actions between meetings — the value of mentoring is in what you do afterwards.',
          'Give your mentor honest feedback about what is and is not helping.',
        ] },
        { heading: 'Expectations of mentors', bullets: [
          'Offer around one hour a month, protected in the diary, for twelve months.',
          'Listen first; ask questions before offering answers. Your experience is context, not instruction.',
          'Keep confidences. What is discussed in mentoring stays in mentoring, within the safeguarding limits below.',
          'Know your limits: signpost to specialist, HR or professional standards routes when a topic needs them.',
        ] },
        { heading: 'The first meeting and the agreement', paragraphs: [
          'Use the first meeting to agree how you will work together: frequency, format, confidentiality and what each of you expects. Record this in the one-page mentoring agreement — it prevents most of the problems the programme team ever sees, which are almost always mismatched expectations rather than mismatched people.',
        ] },
        { heading: 'When things need to change', paragraphs: [
          'Either party may pause or end the relationship at any time, without blame, by telling the programme team — re-matching is routine and carries no stigma. Structured CPD hours may be claimed by both mentors and mentees for prepared mentoring sessions and associated reflection.',
        ] },
      ],
    },
  },
];

// Video resources — real, stable YouTube videos on relevant topics, embedded
// with the standard iframe code (the format the Resource Management admin UI
// stores for `video` resources). Ids hardcoded; visibility mixed like the
// document set. Exported for tests.
export const VIDEO_RESOURCES = [
  {
    slug: 'why-biodiversity-matters', title: 'Why Biodiversity Matters', isPublic: true,
    youtubeId: 'GK_vRtHJZu4', tags: ['Biodiversity', 'Video'],
    desc: 'TED-Ed explainer on why biodiversity is so important for healthy ecosystems — useful background for members starting BNG work.',
  },
  {
    slug: 'climate-change-101', title: 'Climate Change 101', isPublic: false,
    youtubeId: 'EtW2rrLHs08', tags: ['Carbon & Net Zero', 'Video'],
    desc: 'National Geographic\u2019s concise primer on the science of climate change — a member briefing for client conversations about net zero.',
  },
  {
    slug: 'causes-and-effects-of-climate-change', title: 'Causes and Effects of Climate Change', isPublic: false,
    youtubeId: 'G4H1N_yXBiA', tags: ['Carbon & Net Zero', 'Video'],
    desc: 'Short National Geographic overview of the drivers and impacts of climate change, for members building presentations and training.',
  },
];

// Job board postings — environmental/sustainability vacancies at the seeded
// demo employers. Postings reuse the employer's generated logo (fetched at
// persist time); statuses are mixed so the admin management page demos well:
// 'active' (public board), 'pending_approval', 'rejected', and two active
// postings whose closing_date is already past (admin shows them as expired /
// archived; the public board filters them out).
//
// Provenance: job_posting has NO is_sample column. Seeded postings are
// identified by (a) the manifest record list (reset removes exactly these
// rows) and (b) their reserved-domain contact_email (@aesp.example.com),
// which can never belong to a real posting. Idempotency key = title
// (tenant-scoped; titles below are unique).
export const JOB_POSTINGS = [
  { title: 'Senior Environmental Consultant', org: 'Greenstone Environmental Consulting', location: 'Bristol', salary: '£45,000 – £55,000', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 6, closesIn: 24, status: 'active', featured: true, method: 'url',
    summary: 'Lead multidisciplinary environmental assessments for infrastructure and development clients across the South West.',
    points: ['Manage EIA coordination across a varied project portfolio', 'Mentor graduate consultants and review technical deliverables', 'Chartered or near-chartered with 5+ years\u2019 consultancy experience'] },
  { title: 'Carbon & Net Zero Analyst', org: 'CarbonWise Consulting', location: 'London (hybrid)', salary: '£38,000 – £46,000', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 4, closesIn: 30, status: 'active', featured: false, method: 'url',
    summary: 'Deliver corporate carbon footprints, science-based targets and transition plans for FTSE and mid-market clients.',
    points: ['GHG Protocol scope 1\u20133 accounting and data analysis', 'Support SBTi target validation submissions', 'Strong Excel/Python data skills preferred'] },
  { title: 'Principal Ecologist', org: 'TerraNova Environmental Planning', location: 'Cambridge', salary: '£52,000 – £60,000', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 12, closesIn: 18, status: 'active', featured: true, method: 'email',
    summary: 'Direct our growing ecology team, leading biodiversity net gain strategy and protected-species work nationwide.',
    points: ['Lead BNG assessments using the statutory metric', 'Full CIEEM membership and protected-species licences desirable', 'Line management of a team of six ecologists'] },
  { title: 'Sustainability Manager', org: 'Evergreen Housing Group', location: 'Nottingham', salary: '£48,000 – £54,000', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 9, closesIn: 27, status: 'active', featured: false, method: 'url',
    summary: 'Own the decarbonisation programme for a 20,000-home social housing portfolio, from retrofit strategy to resident engagement.',
    points: ['Deliver the SHDF-funded retrofit pipeline', 'Report against Sustainability Reporting Standard for Social Housing', 'Experience of PAS 2035 retrofit projects an advantage'] },
  { title: 'Environmental Compliance Officer', org: 'Bluewater Utilities', location: 'Exeter', salary: '£34,000 – £40,000', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 15, closesIn: 21, status: 'active', featured: false, method: 'email',
    summary: 'Keep our water treatment and network operations compliant with environmental permits and discharge consents.',
    points: ['Manage environmental permit compliance and reporting', 'Investigate pollution incidents and drive corrective actions', 'Knowledge of EPR and WRA regimes essential'] },
  { title: 'Graduate Environmental Scientist', org: 'Northbridge Sustainability Partners', location: 'Leeds', salary: '£26,000 – £29,000', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 3, closesIn: 35, status: 'active', featured: false, method: 'url',
    summary: 'Join our two-year graduate scheme rotating through air quality, land condition and sustainability advisory teams.',
    points: ['Structured training with chartership support', 'Site work across the north of England', '2:1 or above in an environmental discipline'] },
  { title: 'EIA Project Manager', org: 'Meridian Infrastructure Group', location: 'Birmingham', salary: '£50,000 – £58,000', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 8, closesIn: 26, status: 'active', featured: false, method: 'url',
    summary: 'Coordinate environmental statements for major rail and highways schemes within our in-house consenting team.',
    points: ['Manage multidisciplinary EIA inputs on NSIP projects', 'Extensive stakeholder and regulator engagement', 'DCO experience strongly preferred'] },
  { title: 'Renewable Energy Consents Officer', org: 'Arcfield Renewable Energy', location: 'Aberdeen (hybrid)', salary: '£42,000 – £50,000', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 11, closesIn: 33, status: 'active', featured: false, method: 'email',
    summary: 'Progress onshore wind and battery storage consents through the Scottish planning system.',
    points: ['Prepare and manage Section 36 and TCPA applications', 'Coordinate environmental survey programmes', 'Knowledge of Scottish consenting regimes essential'] },
  { title: 'Air Quality Specialist', org: 'ClearSky Air Quality Trust', location: 'Cardiff', salary: '£36,000 – £42,000', type: 'Full-time', hours: 'Flexible', postedDaysAgo: 14, closesIn: 20, status: 'active', featured: false, method: 'email',
    summary: 'Lead monitoring campaigns and community air quality projects across South Wales for an independent charity.',
    points: ['Design and run ambient monitoring networks', 'Produce accessible public reports and briefings', 'Dispersion modelling (ADMS) experience welcome'] },
  { title: 'Environmental Planner', org: 'Westborough City Council', location: 'Westborough', salary: '£37,000 – £43,000 (Grade 9)', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 7, closesIn: 22, status: 'active', featured: false, method: 'url',
    summary: 'Advise planning officers and members on environmental matters across a busy urban authority.',
    points: ['Review EIA screening/scoping and consultation responses', 'Shape local plan environmental policy', 'Local government experience desirable, not essential'] },
  { title: 'Part-time Sustainability Coordinator', org: 'Wildmoor Conservation Trust', location: 'York', salary: '£28,000 – £32,000 pro rata', type: 'Part-time', hours: 'Part-time', postedDaysAgo: 10, closesIn: 28, status: 'active', featured: false, method: 'email',
    summary: 'Coordinate the Trust\u2019s own environmental footprint programme across our reserves and visitor centres (3 days/week).',
    points: ['Track and report carbon, waste and water performance', 'Support volunteers delivering site improvements', 'Flexible working pattern by agreement'] },
  { title: 'ESG Reporting Contract Analyst', org: 'FutureEarth Advisory', location: 'Edinburgh (remote-friendly)', salary: '£350 – £425/day', type: 'Contract', hours: 'Full-time', postedDaysAgo: 5, closesIn: 16, status: 'active', featured: false, method: 'url',
    summary: 'Six-month contract supporting CSRD readiness engagements for European clients through the reporting season.',
    points: ['Double materiality assessments and gap analyses', 'ESRS datapoint mapping and disclosure drafting', 'Immediate start preferred'] },
  // Pending approval — visible only on the admin management page.
  { title: 'Assistant Ecologist (Seasonal)', org: 'Calder Environmental Services', location: 'Halifax', salary: '£24,000 – £27,000', type: 'Temporary', hours: 'Full-time', postedDaysAgo: 1, closesIn: 40, status: 'pending_approval', featured: false, method: 'email',
    summary: 'Seasonal fieldwork role supporting protected-species surveys through the 2027 survey season.',
    points: ['Great crested newt and bat survey assistance', 'Full UK driving licence required', 'Fixed term April to September'] },
  { title: 'Head of Environment', org: 'Harbourview Ports Ltd', location: 'Liverpool', salary: '£70,000 – £80,000 + car allowance', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 2, closesIn: 38, status: 'pending_approval', featured: false, method: 'url',
    summary: 'Senior leadership role owning environmental strategy, compliance and net-zero delivery across our port estates.',
    points: ['Board-level reporting on environmental performance', 'Lead a team of twelve across three sites', 'Marine licensing experience highly desirable'] },
  // Rejected example for the admin view.
  { title: 'Door-to-door Energy Sales Executive', org: null, companyName: 'BrightSwitch Energy Sales', location: 'Nationwide', salary: 'Commission only', type: 'Full-time', hours: 'Flexible', postedDaysAgo: 5, closesIn: 30, status: 'rejected', featured: false, method: 'url',
    summary: 'Commission-based residential energy switching sales role.',
    points: ['Uncapped commission', 'No experience necessary'] },
  // Active but already past closing_date — admin shows these as expired/archived.
  { title: 'Waste & Resources Manager', org: 'Kelbrook District Council', location: 'Kelbrook', salary: '£44,000 – £49,000', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 55, closesIn: -6, status: 'active', featured: false, method: 'url',
    summary: 'Manage the council\u2019s waste collection contracts and circular-economy programme.',
    points: ['Contract management of collection and disposal services', 'Drive recycling performance improvement', 'WAMITAB or CIWM qualification desirable'] },
  { title: 'Research Fellow — Climate Adaptation', org: 'North Midlands University', location: 'Stoke-on-Trent', salary: '£39,000 – £45,000 (Grade 7)', type: 'Full-time', hours: 'Full-time', postedDaysAgo: 60, closesIn: -12, status: 'active', featured: false, method: 'email',
    summary: 'Three-year post-doctoral fellowship researching urban climate adaptation and nature-based solutions.',
    points: ['Publish in leading environmental journals', 'Co-supervise PhD students', 'PhD in a relevant discipline required'] },
];

function jobDescriptionHtml(j, companyName) {
  const bullets = j.points.map((p) => `<li>${p}</li>`).join('');
  return `<p>${j.summary}</p><h3>About the role</h3><ul>${bullets}</ul>` +
    `<p>${companyName} is an equal-opportunities employer. This is a fictional demonstration vacancy seeded for the AESP demo tenant \u2014 applications are not monitored.</p>`;
}

/**
 * Pure planning helper (exported for tests): expands JOB_POSTINGS into
 * upsert-ready rows. All RNG runs here, sequentially, from the dedicated
 * 'aesp-v1:jobs' stream — so member/event data stays byte-stable and re-runs
 * produce identical postings.
 *
 * orgsByName: { [name]: { id, logo_url } } — seeded demo orgs from the DB.
 * activeMembers: plans with memberId/orgName/email (posting attribution).
 */
export function planJobPostings({ rng, dates, orgsByName, activeMembers }) {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return JOB_POSTINGS.map((j) => {
    const org = j.org ? orgsByName[j.org] : null;
    const companyName = j.org || j.companyName;
    // Attribute member posts to a deterministic active member at the employer.
    const candidates = j.org ? activeMembers.filter((p) => p.orgName === j.org) : [];
    const poster = candidates.length ? candidates[rng.int(0, candidates.length - 1)] : null;
    const contactEmail = poster ? poster.email : `recruitment.${slug(companyName)}@aesp.example.com`;
    const closing = dates.daysAhead(j.closesIn);
    return {
      match: { title: j.title },
      row: {
        description: jobDescriptionHtml(j, companyName),
        company_name: companyName,
        company_logo_url: org?.logo_url || null,
        location: j.location,
        salary_range: j.salary,
        job_type: j.type,
        hours: j.hours,
        application_method: j.method,
        application_value: j.method === 'email'
          ? contactEmail
          : `https://careers.aesp.example.com/${slug(companyName)}/${slug(j.title)}`,
        contact_name: poster ? `${poster.first} ${poster.last}` : `${companyName} Recruitment`,
        contact_email: contactEmail,
        posted_by_member_id: poster?.memberId || null,
        posted_by_organization_id: org?.id || null,
        posted_by_organization_name: org ? j.org : null,
        is_member_post: !!poster,
        status: j.status,
        featured: j.featured,
        closing_date: dates.isoDate(closing),
        expiry_date: dates.isoDate(closing),
        created_date: dates.daysAgo(j.postedDaysAgo).toISOString(),
      },
    };
  });
}

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
  // Knowledge Hub resources: real downloadable PDFs (generated + stored via
  // the shared engine helper) and embedded YouTube videos. Upserting by title
  // converts any old dummy external_link rows from earlier seed versions in
  // place — no duplicates left behind.
  const { seedDemoResourcePdfs, youtubeEmbedCode } = await import('../resource-pdfs.mjs');
  const pdfFiles = await seedDemoResourcePdfs({
    ctx,
    items: RESOURCES,
    brand: {
      orgName: 'AESP',
      primaryColor: '#174A3A',
      accentColor: '#D5A642',
      footer: 'Association of Environmental & Sustainability Professionals — fictional demonstration document',
    },
    uploadedBy: 'hannah.clarke@aesp.example.com',
  });
  for (const [i, r] of RESOURCES.entries()) {
    const file = pdfFiles.get(r.slug);
    await upsert('resource', { title: r.title }, {
      description: r.desc,
      resource_type: 'download',
      target_url: file.url,
      open_in_new_tab: true,
      status: 'active',
      is_public: r.isPublic,
      is_sample: true,
      release_date: dates.isoDate(dates.daysAgo(60 + i * 25)),
      author_name: 'AESP',
      tags: ['Guidance'],
    });
  }
  for (const [i, v] of VIDEO_RESOURCES.entries()) {
    await upsert('resource', { title: v.title }, {
      description: v.desc,
      resource_type: 'video',
      target_url: youtubeEmbedCode(v.youtubeId, v.title),
      open_in_new_tab: true,
      status: 'active',
      is_public: v.isPublic,
      is_sample: true,
      release_date: dates.isoDate(dates.daysAgo(30 + i * 20)),
      author_name: 'AESP',
      tags: v.tags,
    });
  }
  ctx.setCount('news_posts', NEWS.length);
  ctx.setCount('resources', RESOURCES.length + VIDEO_RESOURCES.length);
  ctx.setCount('resource_pdfs', pdfFiles.size);

  // ==== 9. Job board ========================================================
  // Dedicated RNG stream so postings never disturb earlier sections' draws.
  // Logos are reused from the org-logo pass (organization.logo_url); postings
  // whose employer has no logo yet simply render with the fallback icon.
  const { data: orgRows, error: orgErr } = await sb
    .from('organization')
    .select('id, name, logo_url')
    .eq('tenant_id', tenantId)
    .eq('is_sample', true)
    .limit(2000);
  if (orgErr) throw new Error(`[seed] job board org lookup failed: ${orgErr.message}`);
  const orgsByName = Object.fromEntries((orgRows || []).map((o) => [o.name, o]));
  const jobPlans = planJobPostings({
    rng: createRng('aesp-v1:jobs'),
    dates,
    orgsByName,
    activeMembers,
  });
  await pmap(jobPlans, (jp) => upsert('job_posting', jp.match, jp.row), 8);
  ctx.setCount('job_postings', jobPlans.length);

  log(`[seed] AESP engagement: ${SIGS.length} SIGs (${sigAssignments} members), ${COMMITTEES.length} committees (${committeeAssignments} members), ${eventPlans.length} events + conference, ${bookingCount + confBookings.length} bookings, ${responsePlans.length} survey responses, ${pages.length} pages, ${NEWS.length} news, ${RESOURCES.length + VIDEO_RESOURCES.length} resources (${pdfFiles.size} PDFs, ${VIDEO_RESOURCES.length} videos), ${jobPlans.length} job postings.`);
}
