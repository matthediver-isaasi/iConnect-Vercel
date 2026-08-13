// AESP demo tenant definition (seed version aesp-v1).
//
// Association of Environmental & Sustainability Professionals — a fictional
// UK professional membership body. This module is pure data/config +
// generation logic; all persistence, safety, idempotency and manifest
// machinery lives in demo-seeds/engine.mjs.
//
// Everything here is fictional. All emails are on the reserved
// aesp.example.com domain (example.com is IANA-reserved and can never
// deliver mail). No real people are represented.

// ---------------------------------------------------------------------------
// Tenant identity & branding
// ---------------------------------------------------------------------------
const COLORS = {
  primary: '#174A3A',   // deep forest green
  secondary: '#8FAE98', // muted sage
  accent: '#D5A642',    // warm ochre
  dark: '#29332F',
  light: '#F5F6F2',
};

const DESCRIPTION =
  'AESP is a UK professional membership organisation supporting people working across environmental science, sustainability, carbon management, ESG, environmental consultancy and related disciplines. ' +
  'The organisation promotes professional standards, career development, continuing professional development, knowledge sharing, mentoring and collaboration across the environmental profession. ' +
  'Its membership ranges from students and graduates entering the profession through to senior consultants, academics, sustainability directors and recognised industry leaders.';

// ---------------------------------------------------------------------------
// Membership grades
// ---------------------------------------------------------------------------
const GRADES = [
  { key: 'student', name: 'Student Member', cost: 35, postNominal: null },
  { key: 'graduate', name: 'Graduate Member', cost: 85, postNominal: null },
  { key: 'professional', name: 'Professional Member', cost: 175, postNominal: 'MAESP' },
  { key: 'fellow', name: 'Fellow', cost: 245, postNominal: 'FAESP' },
  { key: 'retired', name: 'Retired Member', cost: 70, postNominal: null },
];
const gradeByKey = Object.fromEntries(GRADES.map(g => [g.key, g]));

// ---------------------------------------------------------------------------
// Employers (28 fictional organisations across sector types)
// ---------------------------------------------------------------------------
const ORGS = [
  ['Greenstone Environmental Consulting', 'Environmental consultancy', 'Bristol'],
  ['Northbridge Sustainability Partners', 'Environmental consultancy', 'Leeds'],
  ['Calder Environmental Services', 'Environmental consultancy', 'Halifax'],
  ['TerraNova Environmental Planning', 'Environmental consultancy', 'Cambridge'],
  ['CarbonWise Consulting', 'Environmental consultancy', 'London'],
  ['FutureEarth Advisory', 'ESG advisory', 'Edinburgh'],
  ['Meridian Infrastructure Group', 'Infrastructure & construction', 'Birmingham'],
  ['Henshaw Engineering', 'Engineering consultancy', 'Sheffield'],
  ['Ashdown Rail & Civils', 'Infrastructure & construction', 'Derby'],
  ['Fenwick Construction Group', 'Construction', 'Newcastle upon Tyne'],
  ['Westborough City Council', 'Local authority', 'Westborough'],
  ['Kelbrook District Council', 'Local authority', 'Kelbrook'],
  ['Glenmore Highlands Council', 'Local authority', 'Inverness'],
  ['Brynmawr Valleys Council', 'Local authority', 'Merthyr Tydfil'],
  ['North Midlands University', 'University', 'Stoke-on-Trent'],
  ['University of Carrickfern', 'University', 'Belfast'],
  ['Severnside University', 'University', 'Gloucester'],
  ['Arcfield Renewable Energy', 'Energy', 'Aberdeen'],
  ['Solent Tidal Power', 'Energy', 'Southampton'],
  ['Pennine Grid Services', 'Energy', 'Manchester'],
  ['Evergreen Housing Group', 'Housing', 'Nottingham'],
  ['Harbourview Ports Ltd', 'Transport & logistics', 'Liverpool'],
  ['Bluewater Utilities', 'Water utility', 'Exeter'],
  ['Wildmoor Conservation Trust', 'Charity / NGO', 'York'],
  ['ClearSky Air Quality Trust', 'Charity / NGO', 'Cardiff'],
  ['Department for Environmental Delivery', 'Central government', 'London'],
  ['National Land Remediation Agency', 'Public body', 'Warrington'],
  ['Orchard & Vale Foods plc', 'Corporate — food & agriculture', 'Hereford'],
];

// ---------------------------------------------------------------------------
// Name pools — diverse, natural-looking fictional UK names
// ---------------------------------------------------------------------------
const FIRST_NAMES = [
  'Amelia', 'Oliver', 'Priya', 'Kwame', 'Sophie', 'Tomasz', 'Niamh', 'Ibrahim',
  'Charlotte', 'Dylan', 'Mei', 'Callum', 'Fatima', 'George', 'Isla', 'Ravi',
  'Hannah', 'Marcus', 'Eleri', 'Sanjay', 'Lucy', 'Ewan', 'Zainab', 'Patrick',
  'Grace', 'Adebayo', 'Rhiannon', 'Liam', 'Yuki', 'Stephen', 'Aoife', 'Nathan',
  'Bethan', 'Omar', 'Freya', 'Douglas', 'Kirsty', 'Emeka', 'Megan', 'Harish',
  'Rosie', 'Connor', 'Leila', 'Gareth', 'Alice', 'Femi', 'Sian', 'Viktor',
  'Poppy', 'Jonathan', 'Anika', 'Fraser', 'Erin', 'Tariq', 'Holly', 'Cormac',
];
const LAST_NAMES = [
  'Hughes', 'Patel', 'Okafor', 'MacLeod', 'Williams', 'Kowalski', "O'Sullivan",
  'Begum', 'Turner', 'Price', 'Chen', 'Fletcher', 'Ahmed', 'Barnes', 'Douglas',
  'Sharma', 'Whitfield', 'Osei', 'Llewellyn', 'Nair', 'Harrington', 'Campbell',
  'Hussain', 'Doyle', 'Sinclair', 'Adeyemi', 'Morgan', 'Novak', 'Tanaka',
  'Prescott', 'Gallagher', 'Ellwood', 'Rees', 'Iqbal', 'Faulkner', 'Drummond',
  'Boateng', 'Vaughan', 'Rowntree', 'Chandra', 'Mercer', 'Kavanagh', 'Saleh',
  'Pemberton', 'Nwosu', 'Griffiths', 'Sokolova', 'Hartley', 'Bishop', 'Rahim',
];

const JOB_TITLES = {
  student: ['MSc Environmental Management Student', 'BSc Environmental Science Student', 'PhD Researcher — Ecology', 'MSc Sustainability Student'],
  graduate: ['Graduate Environmental Scientist', 'Graduate Sustainability Consultant', 'Assistant Ecologist', 'Junior Carbon Analyst', 'Graduate Environmental Engineer'],
  professional: ['Senior Environmental Consultant', 'Sustainability Manager', 'Principal Ecologist', 'Carbon Reduction Lead', 'ESG Analyst', 'Environmental Compliance Manager', 'EIA Project Manager', 'Air Quality Specialist', 'Waste & Resources Manager', 'Environmental Advisor'],
  fellow: ['Sustainability Director', 'Technical Director — Environment', 'Head of ESG', 'Professor of Environmental Science', 'Chief Sustainability Officer'],
  retired: ['Former Environmental Consultant', 'Retired Sustainability Director', 'Former Principal Ecologist'],
};

const REGIONS = ['London', 'South East', 'South West', 'Midlands', 'North West', 'North East', 'Yorkshire', 'Wales', 'Scotland', 'Northern Ireland'];
const INTERESTS = ['Carbon & Net Zero', 'Biodiversity', 'Environmental Impact Assessment', 'ESG & Corporate Sustainability', 'Renewable Energy', 'Sustainable Construction', 'Air Quality', 'Circular Economy'];
const QUALS = ['BSc Environmental Science', 'MSc Environmental Management', 'MSc Sustainability & Climate Change', 'BSc Geography', 'PhD Environmental Engineering', 'MEng Civil & Environmental Engineering', 'BSc Ecology'];

// Lifecycle states with rough proportions per the spec (§11).
const LIFECYCLES = [
  { value: 'active', weight: 55 },
  { value: 'recently_renewed', weight: 6 },
  { value: 'renewal_due_soon', weight: 8 },
  { value: 'overdue', weight: 5 },
  { value: 'pending_application', weight: 4 },
  { value: 'awaiting_payment', weight: 3 },
  { value: 'lapsed', weight: 6 },
  { value: 'cancelled', weight: 4 },
];

// ---------------------------------------------------------------------------
// Personas (§17, §37) — fixed, stable demo records
// ---------------------------------------------------------------------------
const PERSONAS = [
  { key: 'sarah-mitchell', first: 'Sarah', last: 'Mitchell', grade: 'professional', lifecycle: 'active', org: 'Greenstone Environmental Consulting', job: 'Senior Environmental Consultant', region: 'South West', years: 6, interests: ['Carbon & Net Zero', 'ESG & Corporate Sustainability'], joinYearsAgo: 6, login: true },
  { key: 'james-walker', first: 'James', last: 'Walker', title: 'Dr', grade: 'fellow', lifecycle: 'active', org: 'Meridian Infrastructure Group', job: 'Sustainability Director', region: 'Midlands', years: 22, interests: ['Carbon & Net Zero', 'Environmental Impact Assessment'], joinYearsAgo: 23, login: true },
  { key: 'aisha-rahman', first: 'Aisha', last: 'Rahman', grade: 'graduate', lifecycle: 'active', org: 'Calder Environmental Services', job: 'Graduate Environmental Scientist', region: 'Yorkshire', years: 1.5, interests: ['Biodiversity'], joinYearsAgo: 1.5, login: true },
  { key: 'chloe-evans', first: 'Chloe', last: 'Evans', grade: 'student', lifecycle: 'active', org: 'North Midlands University', job: 'MSc Environmental Management Student', region: 'Midlands', years: 0, interests: ['Sustainable Construction'], joinYearsAgo: 0.4, login: false },
  { key: 'peter-langford', first: 'Peter', last: 'Langford', grade: 'retired', lifecycle: 'active', org: null, job: 'Former Environmental Consultant', region: 'South East', years: 35, interests: ['Environmental Impact Assessment'], joinYearsAgo: 18, login: false },
  { key: 'daniel-brooks', first: 'Daniel', last: 'Brooks', grade: 'professional', lifecycle: 'overdue', org: 'CarbonWise Consulting', job: 'Sustainability Consultant', region: 'London', years: 9, interests: ['Carbon & Net Zero'], joinYearsAgo: 8, login: true },
  { key: 'emily-foster', first: 'Emily', last: 'Foster', grade: 'professional', lifecycle: 'awaiting_approval', org: 'Northbridge Sustainability Partners', job: 'Environmental Advisor', region: 'Yorkshire', years: 5, interests: ['ESG & Corporate Sustainability'], joinYearsAgo: 0, login: false },
];

// Admin personas (§37). Hannah Clarke is the tenant owner created by
// provisioning; Rebecca and Thomas are member-based admins with distinct
// role access levels.
const ADMIN_PERSONAS = [
  { key: 'rebecca-collins', first: 'Rebecca', last: 'Collins', job: 'Membership Manager', role: 'Membership Manager', region: 'Midlands' },
  { key: 'thomas-reed', first: 'Thomas', last: 'Reed', job: 'Events & CPD Manager', role: 'Events & CPD Manager', region: 'Midlands' },
];

const SIZES = { small: 120, medium: 1000, large: 6500 };

const definition = {
  key: 'aesp',
  version: 'aesp-v1',
  rngSeed: 'aesp-v1',
  defaultSize: 'small',
  tablesWithoutTenantColumn: ['member_preference_value'],
  tenant: {
    name: 'Association of Environmental & Sustainability Professionals',
    slug: 'aesp',
    adminEmail: 'hannah.clarke@aesp.example.com',
    adminFirstName: 'Hannah',
    adminLastName: 'Clarke',
    description: DESCRIPTION,
    tagline: 'Supporting the environmental profession since 1988',
    branding: {
      primary_color: COLORS.primary,
      secondary_color: COLORS.secondary,
      branding_config: {
        accent_color: COLORS.accent,
        dark_neutral: COLORS.dark,
        light_neutral: COLORS.light,
        established: 1988,
        head_office: 'Birmingham, United Kingdom',
        organisation_type: 'Professional membership body',
        represented_membership: 6500,
      },
    },
  },

  async seed(ctx) {
    const { sb, tenantId, rng, dates, upsert, log } = ctx;
    const targetMembers = SIZES[ctx.size] || SIZES.small;
    const thisYear = dates.year;

    // -- Roles for admin personas -----------------------------------------
    const roleMembershipMgr = await upsert('role', { name: 'Membership Manager' }, {
      description: 'Demo admin role: full membership & CRM administration, no events or platform settings.',
      is_admin: true, is_default: false, is_system: false,
      excluded_features: ['admin.role-management', 'admin.integrations', 'events.*'],
      default_landing_page: 'Dashboard',
    });
    const roleEventsMgr = await upsert('role', { name: 'Events & CPD Manager' }, {
      description: 'Demo admin role: events administration, no membership finance or platform settings.',
      is_admin: true, is_default: false, is_system: false,
      excluded_features: ['admin.role-management', 'admin.integrations', 'membership.*'],
      default_landing_page: 'Dashboard',
    });
    const { data: memberRoleRow } = await sb.from('role').select('id').eq('tenant_id', tenantId).eq('name', 'Member').maybeSingle();
    const memberRoleId = memberRoleRow?.id || null;

    // -- Preference fields (profile richness) ------------------------------
    const pfGrade = await upsert('preference_field', { name: 'membership_grade' }, {
      label: 'Membership Grade', field_type: 'dropdown', entity_scope: 'member',
      options: GRADES.map(g => g.name), is_active: true, display_order: 1,
      show_in_member_admin_list: true, show_in_member_admin_column: true, show_in_member_admin_filter: true,
    });
    const pfNumber = await upsert('preference_field', { name: 'membership_number' }, {
      label: 'Membership Number', field_type: 'text', entity_scope: 'member',
      is_active: true, display_order: 2, show_in_member_admin_list: true, show_in_member_admin_column: true,
    });
    const pfRegion = await upsert('preference_field', { name: 'uk_region' }, {
      label: 'Region', field_type: 'dropdown', entity_scope: 'member',
      options: [...REGIONS, 'International'], is_active: true, display_order: 3,
      is_filterable: true, show_in_member_admin_filter: true,
    });
    const pfYears = await upsert('preference_field', { name: 'years_experience' }, {
      label: 'Years of Experience', field_type: 'number', entity_scope: 'member', is_active: true, display_order: 4,
    });
    const pfInterests = await upsert('preference_field', { name: 'professional_interests' }, {
      label: 'Professional Interests', field_type: 'picklist', entity_scope: 'member',
      options: INTERESTS, is_active: true, display_order: 5, is_filterable: true,
    });
    const pfQuals = await upsert('preference_field', { name: 'qualifications' }, {
      label: 'Qualifications', field_type: 'text', entity_scope: 'member', is_active: true, display_order: 6,
    });
    const pfPostNominal = await upsert('preference_field', { name: 'post_nominals' }, {
      label: 'Post-nominals', field_type: 'text', entity_scope: 'member', is_active: true, display_order: 7,
    });

    // -- Membership tier configs (5 grades, flat price each) ---------------
    const tierConfigByGrade = {};
    for (const g of GRADES) {
      tierConfigByGrade[g.key] = await upsert('membership_tier_config', { name: `${g.name}${g.postNominal ? ` (${g.postNominal})` : ''}` }, {
        field_source: 'custom',
        structure_field_id: pfGrade.id,
        structure_match_value: g.name,
        structure_scope_type: 'member',
        pricing_model: 'flat',
        flat_cost: g.cost,
        currency: 'GBP',
        billing_period: 'annual',
        membership_start_month: 1,
        membership_start_day: 1,
        start_mode: 'immediate',
        effective_from: `${thisYear - 5}-01-01`,
        is_active: true,
        online_card_payment: true,
        auto_approve_fees: true,
        invoice_description: `AESP ${g.name} annual subscription`,
      });
    }

    // -- Communication categories ------------------------------------------
    const commCats = {};
    for (const [i, name] of ['General Newsletter', 'Event Updates', 'Professional Updates', 'Marketing Communications'].entries()) {
      commCats[name] = await upsert('communication_category', { name }, {
        description: `AESP ${name.toLowerCase()}`, is_active: true, is_public: true, display_order: i + 1,
      });
    }

    // -- Organisations -------------------------------------------------------
    const orgByName = {};
    for (const [name, sector, city] of ORGS) {
      orgByName[name] = await upsert('organization', { name }, {
        status: 'active', is_primary: false, is_sample: true,
        description: `${sector} — ${city}. Fictional demo employer seeded for the AESP demo tenant.`,
        address: `${city}, United Kingdom`,
      });
    }
    ctx.setCount('organizations', ORGS.length);

    // -- Member generation ----------------------------------------------------
    const usedEmails = new Set();
    const usedNames = new Set();
    let membershipNo = 10000 + rng.int(100, 400);
    const nextMembershipNo = () => { membershipNo += rng.int(3, 41); return `AESP-${membershipNo}`; };

    const emailFor = (first, last) => {
      let base = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '');
      let email = `${base}@aesp.example.com`;
      let n = 2;
      while (usedEmails.has(email)) email = `${base}${n++}@aesp.example.com`;
      usedEmails.add(email);
      return email;
    };

    // Build the full member plan: personas + admins + generated fill.
    const plans = [];

    for (const p of PERSONAS) {
      plans.push({
        demoKey: p.key,
        first: p.first, last: p.last, title: p.title || null,
        grade: p.grade, lifecycle: p.lifecycle,
        orgName: p.org, job: p.job, region: p.region,
        years: p.years, interests: p.interests,
        joinDate: new Date(dates.now.getTime() - p.joinYearsAgo * 365.25 * 86400000),
        login: !!p.login, isPersona: true,
      });
    }
    for (const a of ADMIN_PERSONAS) {
      plans.push({
        demoKey: a.key, first: a.first, last: a.last,
        grade: null, lifecycle: 'staff', orgName: null,
        job: a.job, region: a.region, adminRole: a.role,
        joinDate: new Date(dates.now.getTime() - 3 * 365.25 * 86400000),
        login: true, isPersona: true,
      });
    }

    const fillCount = Math.max(0, targetMembers - plans.length + 2); // ≈ target incl. personas
    const gradeWeights = [
      { value: 'student', weight: 15 }, { value: 'graduate', weight: 20 },
      { value: 'professional', weight: 55 }, { value: 'fellow', weight: 15 },
      { value: 'retired', weight: 10 },
    ];
    for (let i = 0; i < fillCount; i++) {
      let first, last;
      do {
        first = rng.pick(FIRST_NAMES);
        last = rng.pick(LAST_NAMES);
      } while (usedNames.has(`${first} ${last}`));
      usedNames.add(`${first} ${last}`);
      const grade = rng.weighted(gradeWeights);
      const lifecycle = grade === 'retired' ? (rng.chance(0.85) ? 'active' : 'lapsed') : rng.weighted(LIFECYCLES);
      const region = rng.chance(0.94) ? rng.pick(REGIONS) : 'International';
      // Join dates span ~5 years (longer for fellows/retired).
      const maxYearsBack = grade === 'fellow' ? 18 : grade === 'retired' ? 22 : grade === 'graduate' ? 3 : grade === 'student' ? 2 : 5.5;
      const yearsBack = grade === 'student' ? rng.next() * maxYearsBack : 0.2 + rng.next() * maxYearsBack;
      plans.push({
        demoKey: `gen-${grade}-${i}`,
        first, last, grade, lifecycle,
        orgName: rng.chance(0.88) ? rng.pick(ORGS)[0] : null,
        job: rng.pick(JOB_TITLES[grade]),
        region,
        years: grade === 'student' ? 0 : Math.round(yearsBack + (grade === 'fellow' ? 12 : grade === 'professional' ? 4 : 0) + rng.int(0, 4)),
        interests: rng.shuffle(INTERESTS).slice(0, rng.int(1, 3)),
        joinDate: new Date(dates.now.getTime() - yearsBack * 365.25 * 86400000),
        login: false, isPersona: false,
      });
    }

    // -- Phase 1: expand every plan into concrete record data ---------------
    // All RNG consumption happens here, sequentially, so the dataset is
    // fully deterministic regardless of persistence concurrency/order.
    const demoPassword = process.env.DEMO_SEED_PASSWORD || ctx.randomPassword();
    let printedPassword = false;
    const passwordHash = await ctx.hashPassword(demoPassword);

    let historyCount = 0, credCount = 0;
    const lifecycleCounts = {};

    for (const plan of plans) {
      plan.email = emailFor(plan.first, plan.last);
      const grade = plan.grade ? gradeByKey[plan.grade] : null;
      plan.gradeDef = grade;
      const isApplication = plan.lifecycle === 'pending_application' || plan.lifecycle === 'awaiting_approval';
      plan.memberStatus = isApplication ? 'pending'
        : (plan.lifecycle === 'lapsed' || plan.lifecycle === 'cancelled') ? 'inactive'
        : 'active';
      plan.roleId = plan.adminRole === 'Membership Manager' ? roleMembershipMgr.id
        : plan.adminRole === 'Events & CPD Manager' ? roleEventsMgr.id
        : memberRoleId;
      if (isApplication) plan.joinDate = dates.daysAgo(rng.int(2, 9));

      // Preference values (member_preference_value has no tenant column).
      plan.prefPairs = [
        [pfRegion.id, plan.region],
        [pfYears.id, plan.years != null ? String(Math.round(plan.years)) : null],
        [pfQuals.id, plan.grade ? rng.pick(QUALS) : null],
        [pfInterests.id, plan.interests?.length ? JSON.stringify(plan.interests) : null],
        [pfGrade.id, grade ? grade.name : null],
        [pfPostNominal.id, grade?.postNominal || null],
      ].filter(([, v]) => v != null);
      if (grade) plan.prefPairs.push([pfNumber.id, nextMembershipNo()]);

      // Communication preferences — varied, not uniform (§28).
      plan.commPlan = {
        'General Newsletter': rng.chance(0.85),
        'Event Updates': rng.chance(0.7),
        'Professional Updates': rng.chance(0.6),
        'Marketing Communications': rng.chance(0.3),
      };
      if (!plan.isPersona && rng.chance(0.05)) for (const k of Object.keys(plan.commPlan)) plan.commPlan[k] = false;

      if (plan.login || plan.adminRole) {
        credCount++;
        if (!process.env.DEMO_SEED_PASSWORD && !printedPassword) {
          log(`[seed] Demo persona password (set DEMO_SEED_PASSWORD to fix it): ${demoPassword}`);
          printedPassword = true;
        }
      }

      // Membership history + invoicing rows (§26, §27).
      plan.historyRows = [];
      if (grade && !isApplication) {
        const cfg = tierConfigByGrade[plan.grade];
        const joinYear = plan.joinDate.getFullYear();
        const firstYear = Math.max(joinYear, thisYear - 5); // cap history at ~5 years back
        let lastYear = thisYear;
        if (plan.lifecycle === 'lapsed') lastYear = thisYear - rng.int(1, 2);
        if (plan.lifecycle === 'cancelled') lastYear = thisYear - rng.int(0, 1);

        for (let y = firstYear; y <= lastYear; y++) {
          const isLatest = y === lastYear;
          let status = 'active';
          let payment_status = 'paid';
          let notes = null;
          let paid_at = new Date(Date.UTC(y, 0, rng.int(3, 45)));

          if (isLatest) {
            switch (plan.lifecycle) {
              case 'recently_renewed':
                paid_at = dates.daysAgo(rng.int(1, 3)); notes = 'Renewal payment received'; break;
              case 'renewal_due_soon':
                payment_status = 'unpaid'; paid_at = null;
                notes = `Renewal invoice issued — payment due ${dates.isoDate(dates.daysAhead(rng.int(7, 14)))}`; break;
              case 'awaiting_payment':
                payment_status = 'unpaid'; paid_at = null; notes = 'Awaiting first payment'; break;
              case 'overdue':
                payment_status = 'unpaid'; paid_at = null;
                notes = `Renewal overdue since ${dates.isoDate(dates.daysAgo(rng.int(30, 90)))}`; break;
              case 'cancelled':
                status = 'cancelled'; payment_status = 'voided'; paid_at = null; notes = 'Membership cancelled at member request'; break;
              case 'lapsed':
                notes = 'Final membership year before lapse'; break;
              default:
                break;
            }
          } else if (rng.chance(0.03)) {
            payment_status = 'voided'; notes = 'Payment refunded (synthetic demo record)';
          }
          // Occasional waived/complimentary year (payment_status stays 'paid',
          // cost zeroed — the schema constrains payment_status to
          // unpaid|paid|partial|voided).
          let finalCost = grade.cost;
          if (!isLatest && rng.chance(0.02)) { finalCost = 0; notes = 'Waived — complimentary membership year'; }

          plan.historyRows.push({
            membership_year: y,
            row: {
              config_id: cfg.id,
              tier_label: grade.name,
              annual_cost: grade.cost,
              final_cost: finalCost,
              total_with_vat: finalCost,
              vat_rate_percent: 0,
              vat_amount: 0,
              currency: 'GBP',
              billing_period: 'annual',
              status,
              payment_status,
              payment_method: payment_status === 'paid' ? (rng.chance(0.65) ? 'card' : 'invoice') : null,
              paid_at: paid_at ? dates.iso(paid_at) : null,
              year_number: y - joinYear + 1,
              notes,
            },
          });
          historyCount++;
        }
      }
      lifecycleCounts[plan.lifecycle] = (lifecycleCounts[plan.lifecycle] || 0) + 1;
    }

    // -- Tenant owner persona (Hannah Clarke, Chief Executive) --------------
    // Provisioning created her identity + admin member; keep her profile in
    // the demo shape and align her login password with the demo password so
    // demos always have a known owner login.
    {
      const adminEmail = definition.tenant.adminEmail.toLowerCase();
      const { data: adminMember } = await sb.from('member').select('id').eq('tenant_id', tenantId).eq('email', adminEmail).maybeSingle();
      if (adminMember) {
        const { error: amErr } = await sb.from('member').update({
          job_title: 'Chief Executive', is_sample: true, login_enabled: true, status: 'active',
        }).eq('id', adminMember.id).eq('tenant_id', tenantId);
        if (amErr) throw new Error(`[seed] owner member update failed: ${amErr.message}`);
        await upsert('member_credentials', { email: adminEmail }, {
          member_id: adminMember.id, password_hash: passwordHash, is_temporary: false, is_temp_password: false,
        });
      }
      const { error: idErr } = await sb.from('tenant_identity').update({ password_hash: passwordHash, is_temporary: false }).eq('email', adminEmail);
      if (idErr) log(`[seed] warning: owner identity password update: ${idErr.message}`);
    }

    // -- Phase 2: persist in parallel (bounded concurrency) -----------------
    const { pmap } = await import('../engine.mjs');
    await pmap(plans, async (plan) => {
      const grade = plan.gradeDef;
      const member = await upsert('member', { email: plan.email }, {
        first_name: plan.first,
        last_name: plan.last,
        job_title: plan.job,
        organization_id: plan.orgName ? orgByName[plan.orgName].id : null,
        role_id: plan.roleId,
        status: plan.memberStatus,
        login_enabled: !!plan.login || !!plan.adminRole,
        is_sample: true,
        show_in_directory: plan.memberStatus === 'active',
        created_on: dates.iso(plan.joinDate),
        biography: plan.isPersona && grade
          ? `${plan.title ? plan.title + ' ' : ''}${plan.first} ${plan.last} is a fictional AESP demo persona (${grade.name}${grade.postNominal ? ', ' + grade.postNominal : ''}).`
          : null,
      });

      for (const [fieldId, value] of plan.prefPairs) {
        await upsert('member_preference_value', { member_id: member.id, field_id: fieldId }, { value }, { noTenantColumn: true });
      }
      for (const [cat, sub] of Object.entries(plan.commPlan)) {
        await upsert('member_communication_preference', { member_id: member.id, category_id: commCats[cat].id }, { is_subscribed: sub, updated_at: new Date().toISOString() });
      }
      // Login credentials for personas/admins only (§36). No plaintext in repo.
      if (plan.login || plan.adminRole) {
        await upsert('member_credentials', { email: plan.email }, {
          member_id: member.id, password_hash: passwordHash, is_temporary: false, is_temp_password: false,
        });
      }
      for (const h of plan.historyRows) {
        await upsert('member_membership_history', { member_id: member.id, membership_year: h.membership_year }, h.row);
        await upsert('member_membership_invoicing', { member_id: member.id, membership_year: h.membership_year }, {
          invoicing_mode: 'automatic',
          invoice_date: dates.isoDate(new Date(Date.UTC(h.membership_year, 0, 1))),
          fees_approved: true,
        });
      }
    }, 10);

    ctx.setCount('members', plans.length);
    ctx.setCount('membership_history_rows', historyCount);
    ctx.setCount('credentialed_logins', credCount);
    ctx.setCount('lifecycles', lifecycleCounts);
    ctx.setCount('tiers', GRADES.length);
    log(`[seed] AESP: ${plans.length} members, ${historyCount} history rows, lifecycles: ${JSON.stringify(lifecycleCounts)}`);
  },
};

export default definition;
