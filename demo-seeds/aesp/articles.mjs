// AESP demo tenant — /Articles (blog) content seed.
//
// Called from demo-seeds/aesp/definition.mjs AFTER members are persisted (so
// author personas carry plan.memberId) and after engagement content. All
// writes go through ctx.upsert (direct supabase-js with the service key) —
// no entity API, no workflows, no emails.
//
// Provenance: blog_post rows are is_sample=true with a 'demo-' slug prefix
// (double-gated, matching demo-seeds/article-images.mjs). Categories are
// resource_category rows applying to "Articles"; each article denormalises
// the subcategory names it belongs to into blog_post.subcategories, which is
// what both /Articles pages filter on.
//
// All RNG is consumed sequentially from a dedicated stream
// ('aesp-v1:articles') during planning so earlier seed sections stay
// byte-stable and persistence order cannot affect the data.

import { createRng, pmap } from '../engine.mjs';

// ---------------------------------------------------------------------------
// Categories (resource_category rows applying to Articles)
// ---------------------------------------------------------------------------
const ARTICLE_CATEGORIES = [
  {
    name: 'Practice & Technical',
    description: 'In-depth practice notes and technical insight from working environmental professionals.',
    subcategories: ['Carbon & Net Zero', 'Biodiversity & Nature', 'EIA & Planning', 'ESG & Reporting'],
    displayOrder: 1,
  },
  {
    name: 'Careers & Development',
    description: 'Career journeys, professional development and advice for every membership grade.',
    subcategories: ['Career Stories', 'CPD & Skills', 'Mentoring'],
    displayOrder: 2,
  },
  {
    name: 'Policy & Opinion',
    description: 'Analysis of policy developments and personal perspectives from across the profession.',
    subcategories: ['Policy Analysis', 'Opinion'],
    displayOrder: 3,
  },
];

// ---------------------------------------------------------------------------
// Guest writer (fictional, reserved example.com domain)
// ---------------------------------------------------------------------------
const GUEST_WRITER = {
  fullName: 'Dr Miriam Okonkwo',
  email: 'miriam.okonkwo@guest.aesp.example.com',
  organization: 'Independent climate policy researcher',
  jobTitle: 'Climate Policy Researcher',
  biography:
    'Dr Miriam Okonkwo is an independent researcher and writer on UK and international climate policy. ' +
    'She previously led the climate adaptation programme at a national research institute and writes ' +
    'regularly for professional audiences on the practical implications of climate legislation. ' +
    '(Fictional demo profile.)',
};

// ---------------------------------------------------------------------------
// Articles — authorKey references a persona demoKey from definition.mjs, or
// 'guest' for the guest writer. daysAgo staggers published dates over ~10
// months so the listing looks like a living publication.
// ---------------------------------------------------------------------------
const p = (s) => `<p>${s}</p>`;
const h2 = (s) => `<h2>${s}</h2>`;
const ul = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

const ARTICLES = [
  {
    slug: 'scope-3-boundaries-practical-guide',
    title: 'Getting Scope 3 boundaries right: a practical guide for consultants',
    authorKey: 'sarah-mitchell',
    subcategories: ['Carbon & Net Zero'],
    tags: ['Carbon', 'Net Zero', 'GHG Protocol'],
    daysAgo: 9,
    summary: 'Scope 3 boundary-setting is where most corporate carbon footprints go wrong. Sarah Mitchell shares a screening approach that stands up to assurance.',
    content:
      p('Ask three consultants to draw a Scope 3 boundary for the same business and you will usually get three different footprints. That is not a failure of the GHG Protocol — it is a failure of how we document the judgement calls the Protocol asks us to make.') +
      h2('Start with a full category screening') +
      p('Every engagement should begin with a documented screening of all fifteen Scope 3 categories, even the ones you expect to exclude. A one-page rationale per excluded category is the single best defence when the footprint reaches an assurance provider.') +
      ul([
        'Screen all fifteen categories, and record the rationale for every exclusion.',
        'Use spend-based estimates for the first pass — precision comes later.',
        'Agree materiality thresholds with the client before you calculate anything.',
      ]) +
      h2('Materiality is a conversation, not a percentage') +
      p('A five per cent threshold sounds objective until a client\u2019s use-phase emissions sit at four point nine. Talk through what the footprint will be used for — SBTi validation, CSRD disclosure, tendering — and set the boundary to survive that use.') +
      p('The consultants who get repeat work are not the ones with the cleverest emission factors. They are the ones whose boundaries never need to be re-drawn a year later.'),
  },
  {
    slug: 'bng-first-year-lessons',
    title: 'Biodiversity net gain, one year on: what the first schemes taught us',
    authorKey: 'aisha-rahman',
    subcategories: ['Biodiversity & Nature', 'EIA & Planning'],
    tags: ['Biodiversity', 'BNG', 'Planning'],
    daysAgo: 24,
    summary: 'From metric arguments to habitat bank contracts, Aisha Rahman reflects on a year of delivering mandatory biodiversity net gain on live schemes.',
    content:
      p('When mandatory biodiversity net gain arrived, most of the anxiety in our team was about the metric. A year of live schemes later, the metric turned out to be the easy part.') +
      h2('The metric is arithmetic; the strategy is not') +
      p('Once survey data is in, the statutory metric is mechanical. The genuinely difficult questions are strategic: should the scheme deliver units on-site at the cost of developable area, or contract with a habitat bank whose units may be cheaper but thirty miles away?') +
      h2('Three lessons from year one') +
      ul([
        'Engage the ecologist before the masterplan is fixed — retrofitting ten per cent gain into a finished layout is painful for everyone.',
        'Read habitat bank agreements as carefully as you read the metric; delivery risk sits in the contract, not the spreadsheet.',
        'Condition discharge takes longer than anyone budgets for. Start the habitat management plan early.',
      ]) +
      p('The schemes that went smoothly all had one thing in common: biodiversity was on the agenda at the first design team meeting, not the last.'),
  },
  {
    slug: 'esg-assurance-preparing-for-csrd',
    title: 'Preparing sustainability data for limited assurance: an ESG lead\u2019s checklist',
    authorKey: 'james-walker',
    subcategories: ['ESG & Reporting'],
    tags: ['ESG', 'Assurance', 'CSRD'],
    daysAgo: 41,
    summary: 'Limited assurance exposes weaknesses that annual reporting never did. James Walker sets out what to fix before the auditors arrive.',
    content:
      p('The first year a sustainability report goes through limited assurance is a humbling experience for most organisations. Data that looked robust in a glossy PDF suddenly needs an audit trail.') +
      h2('Where assurance findings cluster') +
      p('Across the engagements I have supported, the same three findings appear again and again: undocumented estimation methods, spreadsheet version chaos, and organisational boundaries that quietly differ between the carbon footprint and the financial statements.') +
      ul([
        'Write down every estimation method as if a stranger will have to reproduce it — because one will.',
        'Move critical calculations out of personal spreadsheets and into controlled, versioned workbooks.',
        'Reconcile your reporting boundary to the financial consolidation early, and document every divergence.',
      ]) +
      h2('Treat the dry run as non-negotiable') +
      p('A pre-assurance readiness review costs a fraction of a failed assurance engagement. Run one on last year\u2019s data before the real thing, and give the findings the same status as an internal audit action list.'),
  },
  {
    slug: 'graduate-to-consultant-first-two-years',
    title: 'From graduate to consultant: what I wish I\u2019d known in my first two years',
    authorKey: 'aisha-rahman',
    subcategories: ['Career Stories', 'CPD & Skills'],
    tags: ['Careers', 'Early Career'],
    daysAgo: 63,
    summary: 'Two years into consultancy, Aisha Rahman looks back at the habits that accelerated her development — and the worries that turned out not to matter.',
    content:
      p('Two years ago I walked into my first consultancy job convinced everyone would discover I knew nothing. Here is what I would tell that version of me.') +
      h2('Nobody expects you to know; they expect you to find out') +
      p('The skill that actually distinguishes good graduates is not technical knowledge — it is knowing how to frame a question, where to look first, and when to stop researching and ask.') +
      h2('Habits that compounded') +
      ul([
        'Keep a running log of every new method, regulation and acronym; review it monthly.',
        'Volunteer for site work early — field competence buys credibility faster than any report.',
        'Find a mentor outside your own team. The AESP mentoring programme matched me with someone whose advice reshaped my second year.',
      ]) +
      p('And record your CPD as you go. Reconstructing a year of development the week before a professional review is an experience I can\u2019t recommend.'),
  },
  {
    slug: 'climate-adaptation-policy-gap',
    title: 'The adaptation gap: why UK climate policy still under-serves resilience',
    authorKey: 'guest',
    subcategories: ['Policy Analysis'],
    tags: ['Policy', 'Climate', 'Adaptation'],
    daysAgo: 82,
    summary: 'Guest writer Dr Miriam Okonkwo argues that the profession\u2019s focus on mitigation has left adaptation under-resourced, under-regulated and under-skilled.',
    content:
      p('For every pound of professional effort spent on decarbonisation, a fraction is spent preparing the same assets for the climate they will actually operate in. That imbalance is now a commercial risk as well as a policy failure.') +
      h2('Mitigation has a market; adaptation has a gap') +
      p('Net-zero targets created a fee-earning market almost overnight. Adaptation has no equivalent driver: no mandatory target, weak disclosure requirements, and benefits that accrue to whoever owns the asset decades from now.') +
      h2('What would close the gap') +
      ul([
        'Adaptation reporting obligations with the same teeth as emissions disclosure.',
        'Climate resilience as a standing design requirement in infrastructure consenting.',
        'A professional skills pipeline — the ecologists and engineers who can do this work are already over-committed.',
      ]) +
      p('The professionals reading this will do much of that work when it comes. The question is whether policy gives them the mandate before the damage makes the case instead.'),
  },
  {
    slug: 'eia-proportionate-environmental-statements',
    title: 'Proportionate EIA: writing environmental statements people can actually use',
    authorKey: 'james-walker',
    subcategories: ['EIA & Planning'],
    tags: ['EIA', 'Planning'],
    daysAgo: 108,
    summary: 'Environmental statements keep getting longer while decisions get no better. James Walker makes the case for ruthless proportionality.',
    content:
      p('The longest environmental statement I have reviewed ran to over eleven thousand pages. The planning officer who had to determine it had three weeks and two other majors on her desk.') +
      h2('Length is a transfer of risk, not a reduction of it') +
      p('Teams add material because leaving something out feels risky. But a statement nobody can navigate transfers the risk to the decision-maker — and invites challenge from whoever reads it most carefully, which is rarely the applicant.') +
      ul([
        'Scope out topics with confidence and document why; a good scoping opinion is your shield.',
        'Write the non-technical summary first, not last — it forces clarity about what actually matters.',
        'Cap technical appendices to what is genuinely relied upon in the assessment.',
      ]) +
      p('Proportionate assessment is not less rigorous. It is rigour applied where the significant effects actually are.'),
  },
  {
    slug: 'mentoring-both-directions',
    title: 'Mentoring works in both directions: reflections from twenty years of pairings',
    authorKey: 'james-walker',
    subcategories: ['Mentoring', 'Career Stories'],
    tags: ['Mentoring', 'Careers'],
    daysAgo: 132,
    summary: 'After two decades as an AESP mentor, James Walker on what senior professionals get wrong about mentoring — and what they gain from it.',
    content:
      p('I signed up as a mentor expecting to dispense advice. Twenty years and a dozen mentees later, I am certain I have learned more than I have taught.') +
      h2('The mentee sets the agenda') +
      p('The pairings that fail are almost always the ones where the mentor arrives with a curriculum. The useful sessions start with whatever is actually worrying the mentee that month — a difficult client, a stalled chartership application, a career fork.') +
      h2('What the mentor gets') +
      ul([
        'An unfiltered view of how early-career professionals actually experience the sector.',
        'Fluency in methods and tools that did not exist when you trained.',
        'The regular discipline of articulating judgement you normally exercise on autopilot.',
      ]) +
      p('If you are senior enough to be reading this and nodding, the AESP mentoring programme is short of mentors every single cohort. Register.'),
  },
  {
    slug: 'net-zero-transition-plans-credibility',
    title: 'Credible transition plans: separating strategy from wishful thinking',
    authorKey: 'daniel-brooks',
    subcategories: ['Carbon & Net Zero', 'ESG & Reporting'],
    tags: ['Net Zero', 'Transition Plans'],
    daysAgo: 155,
    summary: 'Most corporate transition plans are targets in search of a strategy. Daniel Brooks on the tests that separate credible plans from decorative ones.',
    content:
      p('A net-zero target is a sentence. A transition plan is supposed to be the evidence that the sentence is true. Too many plans read like the sentence rewritten at greater length.') +
      h2('Three credibility tests') +
      ul([
        'Capital alignment: does planned investment actually map to the abatement the plan claims?',
        'Dependency honesty: are grid decarbonisation and supplier action assumptions stated, quantified and stress-tested?',
        'Governance: does anyone\u2019s remuneration change when a milestone is missed?',
      ]) +
      h2('Where consultants add real value') +
      p('Our job is not to make the plan look credible. It is to make the gaps visible early enough for the client to close them — and to be candid when the arithmetic does not support the ambition.') +
      p('Clients rarely thank you for that candour in the first meeting. They almost always do by the third year.'),
  },
  {
    slug: 'cpd-thirty-hours-that-count',
    title: 'Thirty hours that count: getting real value from your CPD year',
    authorKey: 'sarah-mitchell',
    subcategories: ['CPD & Skills'],
    tags: ['CPD', 'Professional Development'],
    daysAgo: 187,
    summary: 'CPD hours are easy to accumulate and easy to waste. Sarah Mitchell shares a simple structure for a development year that actually develops you.',
    content:
      p('Under the refreshed AESP CPD framework the thirty-hour expectation has not changed — but the flexibility has. That flexibility rewards members who plan, and quietly penalises those who scramble in December.') +
      h2('Plan against a gap, not a calendar') +
      p('Start the year by naming two or three genuine capability gaps. Every CPD choice then has a test: does this close a gap, or is it just the nearest webinar?') +
      ul([
        'Anchor the year on one substantial structured element — a course, a qualification module, a secondment.',
        'Log reflections within a week while the learning is fresh; a sentence of reflection beats an hour of unexamined attendance.',
        'Count the informal work: mentoring, committee service and peer review are all legitimate development.',
      ]) +
      p('The members who sail through professional review are never the ones with the most hours. They are the ones who can say what changed in their practice.'),
  },
  {
    slug: 'renewables-consenting-community-engagement',
    title: 'Beyond the exhibition hall: community engagement that changes renewable schemes for the better',
    authorKey: 'sarah-mitchell',
    subcategories: ['EIA & Planning', 'Opinion'],
    tags: ['Renewable Energy', 'Engagement', 'Planning'],
    daysAgo: 216,
    summary: 'Statutory consultation is a floor, not a strategy. Sarah Mitchell on engagement approaches that improved the schemes she has consented.',
    content:
      p('Every renewable energy developer says they engage communities. Walk into most consultation events, though, and you find three display boards, a comments box and a scheme that will not change whatever gets written on the cards.') +
      h2('Engagement that is designed to change the scheme') +
      p('The projects I am proudest of consented faster because engagement started while the layout could still move. Turbine positions shifted, construction routes changed, and a community benefit fund was shaped by residents rather than announced to them.') +
      ul([
        'Go early enough that feedback can alter the design — and say so explicitly.',
        'Publish what changed as a result of consultation; nothing builds trust faster.',
        'Resource the follow-up. An unanswered question at exhibition becomes an objection at committee.',
      ]) +
      p('Communities are not an obstacle on the consenting path. Handled honestly, they are the best design reviewers a scheme will ever get.'),
  },
  // Drafts (admin/editor view only — never on the public or member listings).
  {
    slug: 'circular-economy-construction-materials',
    title: 'Circular thinking on site: material passports and the reuse economy',
    authorKey: 'daniel-brooks',
    subcategories: ['Carbon & Net Zero'],
    tags: ['Circular Economy', 'Construction'],
    daysAgo: 2,
    status: 'draft',
    summary: 'Material passports promise a reuse revolution in construction. Daniel Brooks examines what it will take to move from pilots to practice.',
    content:
      p('Draft in progress — structural reuse case studies to be added after site interviews.') +
      h2('The pilot-to-practice gap') +
      p('Material passports work beautifully in funded pilots. The unresolved questions are commercial: who warrants a reused beam, who insures it, and whose balance sheet carries the stored materials between projects?'),
  },
  {
    slug: 'water-quality-catchment-partnerships',
    title: 'Catchment partnerships: what actually moves the needle on water quality',
    authorKey: 'aisha-rahman',
    subcategories: ['Biodiversity & Nature', 'Policy Analysis'],
    tags: ['Water', 'Catchments'],
    daysAgo: 5,
    status: 'draft',
    summary: 'Catchment-scale partnerships are the fashionable answer to water quality. A look at the evidence for what works — draft pending peer review.',
    content:
      p('Draft — awaiting review comments from the Sustainability Policy Committee before publication.') +
      h2('Partnerships are necessary, not sufficient') +
      p('The catchments showing measurable improvement combine partnership governance with two harder ingredients: sustained monitoring budgets and at least one partner with regulatory teeth.'),
  },
];

// ---------------------------------------------------------------------------
// Seed entry point
// ---------------------------------------------------------------------------
export async function seedArticles(ctx, { plans }) {
  const { tenantId, dates, upsert, log } = ctx;
  const rng = createRng('aesp-v1:articles');

  // -- Categories (active resource categories applying to Articles) --------
  for (const cat of ARTICLE_CATEGORIES) {
    await upsert('resource_category', { name: cat.name }, {
      description: cat.description,
      subcategories: cat.subcategories,
      display_order: cat.displayOrder,
      is_active: true,
      applies_to_content_types: ['Articles'],
    });
  }

  // -- Guest writer ----------------------------------------------------------
  const guestWriter = await upsert('guest_writer', { email: GUEST_WRITER.email }, {
    full_name: GUEST_WRITER.fullName,
    organization: GUEST_WRITER.organization,
    job_title: GUEST_WRITER.jobTitle,
    biography: GUEST_WRITER.biography,
    is_active: true,
  });

  // -- Author resolution (fill-null-safe against missing personas) ----------
  const planByKey = Object.fromEntries((plans || []).filter((pl) => pl.demoKey).map((pl) => [pl.demoKey, pl]));

  // -- Plan phase: consume all RNG sequentially ------------------------------
  const articlePlans = ARTICLES.map((a) => {
    // Stagger publish times within the day deterministically.
    const publishedAt = new Date(dates.daysAgo(a.daysAgo).getTime() - rng.int(0, 9 * 3600) * 1000);
    const authorPlan = a.authorKey !== 'guest' ? planByKey[a.authorKey] : null;
    if (a.authorKey !== 'guest' && !authorPlan?.memberId) {
      log(`[seed] warning: article '${a.slug}' author persona '${a.authorKey}' has no member id — seeding without author linkage`);
    }
    return {
      def: a,
      slug: `demo-${a.slug}`,
      status: a.status || 'published',
      publishedAt,
      authorId: authorPlan?.memberId || null,
      guestWriterId: a.authorKey === 'guest' ? guestWriter.id : null,
    };
  });

  // -- Persist phase ----------------------------------------------------------
  await pmap(articlePlans, async (ap) => {
    const a = ap.def;
    const post = await upsert('blog_post', { slug: ap.slug }, {
      title: a.title,
      summary: a.summary,
      content: a.content,
      status: ap.status,
      published_date: ap.status === 'published' ? ap.publishedAt.toISOString() : null,
      author_id: ap.authorId,
      guest_writer_id: ap.guestWriterId,
      subcategories: a.subcategories,
      tags: a.tags,
      is_sample: true,
    });
    // Keep the co-author join table consistent with the primary author
    // (display_order 0), matching what the app writes when a post is saved.
    if (ap.authorId || ap.guestWriterId) {
      await upsert('blog_post_author', { blog_post_id: post.id, display_order: 0 }, {
        author_id: ap.authorId,
        guest_writer_id: ap.guestWriterId,
      });
    }
  }, 6);

  const published = articlePlans.filter((ap) => ap.status === 'published').length;
  ctx.setCount('articles', ARTICLES.length);
  ctx.setCount('articles_published', published);
  ctx.setCount('article_categories', ARTICLE_CATEGORIES.length);
  log(`[seed] AESP articles: ${published} published + ${ARTICLES.length - published} draft(s), ${ARTICLE_CATEGORIES.length} categories, 1 guest writer.`);
}
