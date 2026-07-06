// Provision a Canvas Builder page for a tenant from a structured content spec.
//
// This script is the repeatable pattern for spinning up BNMS canvas pages from
// Word documents. It builds a version-1 canvas_design that reuses the visual
// language (fonts / typography styles, hero styling, colour band, orange
// accent, arrow-bulleted body lists, dividers) of the existing non-"Autumn"
// award/application pages (travelling-fellowships / honory-membership), then
// upserts an i_edit_page row keyed on (tenant_id, slug).
//
// Repeatable: to provision a future Word-doc page, add another entry to PAGES
// with its own slug/title and content spec (hero, intro, sections, closingHero).
// The layout engine handles geometry so you only supply copy + generous block
// heights.
//
// Idempotent: re-running upserts the same (tenant_id, slug) row rather than
// creating a duplicate. builder_type is immutable after creation (DB trigger),
// so it is only ever set on first insert.
//
// Usage:
//   node scripts/provision-canvas-page-from-doc.mjs            # dry-run (default)
//   node scripts/provision-canvas-page-from-doc.mjs --apply    # write to DB
//   node scripts/provision-canvas-page-from-doc.mjs --apply --slug=the-bnms-student-prize
//
// DB access: @supabase/supabase-js with the DEST service-role key (the Supabase
// direct host is unreachable from the Replit workspace; the REST endpoint is).

import { createClient } from '@supabase/supabase-js';
import { buildDesign, THEMES } from '../api/_lib/canvasLayoutEngine.js';

// ---------------------------------------------------------------------------
// Env resolution (defensive — prefer DEST_* names for the destination/prod DB).
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.DEST_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const BNMS_TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';


// ---------------------------------------------------------------------------
// Page content specs. Add future Word-doc pages here.
// ---------------------------------------------------------------------------
const HERO_IMG_OPEN =
  'https://vault.iconn.app/storage/v1/object/public/public-assets/ff2df806-b321-4254-b651-3af11fccf1db/uploads/1783072505440-wnbfi57-bnms_event1.jpeg';
const HERO_IMG_CLOSE =
  'https://vault.iconn.app/storage/v1/object/public/public-assets/ff2df806-b321-4254-b651-3af11fccf1db/uploads/1783072526330-psmmwrw-clinical_scientist.jpg';

const P = (t) => `<p><span style="font-size: 20px;">${t}</span></p>`;
const LI = (t) => `<li><p><span style="font-size: 20px;">${t}</span></p></li>`;
// Muted italic note copy for the dashed placeholder boxes.
const NOTE = (t) => `<p><span style="font-size: 20px; font-style: italic;">${t}</span></p>`;

const STUDENT_PRIZE = {
  tenantId: BNMS_TENANT_ID,
  slug: 'the-bnms-student-prize',
  title: 'The BNMS Student Prize',
  design: buildDesign({
    hero: {
      headline: 'The BNMS Student Prize',
      subheadline:
        'Encouraging the next generation of nuclear medicine professionals through research, innovation and academic excellence.',
      ctaLabel: 'Apply now',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-graduation-cap',
      strapline: 'Celebrating student research in nuclear medicine',
      html:
        `<p style="text-align: left;"><span style="font-size: 20px;">The BNMS Student Prize recognises outstanding undergraduate research in nuclear medicine and encourages students to explore the specialty as part of their education and future career.</span></p>` +
        `<p style="text-align: left;"><span style="font-size: 20px;">Open to BNMS Student Members, the prize provides an opportunity to present original work at the BNMS Annual Spring Meeting and gain recognition from professionals across the nuclear medicine community.</span></p>`,
      h: 260,
    },
    sections: [
      {
        type: 'text',
        heading: 'About the Prize',
        html:
          P('The BNMS is committed to supporting students and inspiring the next generation of nuclear medicine professionals.') +
          P('Undergraduate students from a range of healthcare and scientific disciplines are encouraged to undertake projects related to nuclear medicine as part of their degree studies. Projects are typically completed in collaboration with a Department of Nuclear Medicine, Radiology or Medical Physics, where experienced professionals can provide guidance and supervision.') +
          P('Medical students may wish to undertake nuclear medicine projects as part of their Special Study Modules (SSMs) or BSc options, while students from other disciplines are encouraged to incorporate nuclear medicine into their wider academic training.'),
        h: 360,
      },
      {
        type: 'columns',
        heading: 'Eligibility',
        columns: [
          {
            icon: 'fa-solid fa-user-check',
            h3: 'Who can apply',
            html:
              P('The Student Prize is open to:') +
              `<ul>${LI('Undergraduate students with an interest in nuclear medicine.')}${LI('Students who are current BNMS Student Members, or who apply for BNMS Student Membership before submitting their abstract.')}</ul>`,
            h: 240,
          },
          {
            icon: 'fa-solid fa-user-xmark',
            h3: 'Who cannot apply',
            html:
              P('The prize is not open to:') +
              `<ul>${LI('Postgraduate students')}${LI('Trainees')}${LI('NHS Scientist Training Programme (STP) participants')}</ul>` +
              P('These applicants should instead apply for the Young Investigator Prize.'),
            h: 280,
          },
        ],
      },
      {
        type: 'text',
        heading: 'How to Apply',
        html:
          P('Students should submit an original abstract for consideration by the BNMS Scientific Committee as part of the Annual Spring Meeting abstract submission process.') +
          P('Applications must also include a letter from the project supervisor or Head of Department, who should be a Full Member of the BNMS. This letter should:') +
          `<ul>${LI('Confirm the originality of the work.')}${LI("Verify the student's status.")}${LI('Acknowledge appropriate supervision throughout the project.')}</ul>` +
          P('The abstract submission deadline is the same as the deadline for all Annual Spring Meeting abstract submissions.'),
        h: 420,
        bullets: false,
      },
    ],
    closingHero: {
      headline: 'Ready to take part?',
      subheadline:
        'Submit your original abstract as part of the BNMS Annual Spring Meeting abstract submission process and share your research with the nuclear medicine community.',
      ctaLabel: 'Submit Your Abstract',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const WELCOME_COMMITTEE = {
  tenantId: BNMS_TENANT_ID,
  slug: 'welcome-new-committee-members',
  title: 'Welcome New Committee Members',
  design: buildDesign({
    hero: {
      headline: 'Welcome New Committee Members',
      subheadline: 'Everything you need to get started as a BNMS committee member.',
      ctaLabel: 'Complete Your Declaration of Interest',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-people-group',
      strapline: 'Welcome to BNMS',
      html:
        P('Thank you for volunteering to support the British Nuclear Medicine Society.') +
        P('Whether you are joining the BNMS Council, the Professional Standards Committee, the Scientific & Education Committee or another BNMS committee or working group, your contribution plays an important role in supporting the Society and the wider nuclear medicine community.') +
        P("This page brings together the key information and documents you'll need as you begin your role."),
      h: 300,
    },
    sections: [
      {
        type: 'accordion',
        heading: 'Before You Get Started',
        h: 380,
        items: [
          {
            q: 'Declaration of Interest',
            a:
              P('All Chairs and Committee Members are required to complete a Declaration of Interest when they join a committee and to update this annually.') +
              P('Please complete the online Declaration of Interest form before attending your first meeting.'),
            links: [{ label: 'Complete Declaration of Interest', url: '#' }],
          },
          {
            q: 'Code of Conduct',
            a:
              P('The BNMS Code of Conduct sets out the values, standards and behaviours expected of everyone working on behalf of the Society.') +
              P('Please read and accept the appropriate Code of Conduct for your role:') +
              `<ul>${LI('Elected Council Members (Trustees)')}${LI('Co-opted Council Members and Committee Members')}</ul>`,
          },
          {
            q: 'Committee Documents',
            a:
              P("Once you have logged into the BNMS website, you'll find your committee documents within your Group Document Library.") +
              P('Documents include:') +
              `<ul>${LI('Committee contact list')}${LI('Terms of Reference')}${LI('Memorandum and Articles of Association')}${LI('Previous meeting minutes')}${LI('Give as you Live information')}</ul>`,
          },
          {
            q: 'Contact Details',
            a: P('Please ensure your current contact details have been provided to the BNMS Office.'),
          },
          {
            q: 'Expenses',
            a:
              P('Committee members may claim reasonable travel expenses for approved meetings in accordance with the BNMS Expenses Policy.') +
              P('Where possible, travel should be booked in advance using Give as you Live.') +
              P('Remote attendance may also be available where appropriate.'),
          },
        ],
      },
    ],
    closingHero: {
      headline: 'Need Further Help?',
      subheadline:
        'If you have any questions about your committee role, please contact the BNMS Office or the Honorary Secretary.',
      ctaLabel: 'Contact the BNMS Office',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const SCIENTIFIC_EDUCATION = {
  tenantId: BNMS_TENANT_ID,
  slug: 'scientific-education-committee',
  title: 'Scientific & Education Committee',
  design: buildDesign({
    hero: {
      headline: 'Scientific & Education Committee',
      subheadline: 'Supporting scientific excellence, education and professional development across the nuclear medicine community.',
      ctaLabel: 'Contact the Committee',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-microscope',
      strapline: 'About the Committee',
      html:
        P('The British Nuclear Medicine Society brought together its scientific and educational activities under a combined Scientific & Education Committee to oversee the Society\u2019s scientific programme and its education and training work.') +
        P('The Committee is responsible for developing the scientific and educational programme for BNMS meetings, recommending invited speakers and session chairs, and supporting education and training across the multidisciplinary nuclear medicine community.') +
        P('Its remit includes providing educational resources and encouraging Continuing Professional Development (CPD), Continuing Medical Education (CME) and professional revalidation.') +
        P('The Committee brings together Nuclear Medicine Physicians, Clinical Scientists, Radiographers, Technologists, Nurses and Radiopharmaceutical Scientists, reflecting the multidisciplinary nature of nuclear medicine.'),
      h: 440,
    },
    sections: [
      {
        type: 'text',
        heading: 'Committee Leadership',
        html:
          P('<strong>Co-Chairs</strong>') +
          `<ul>${[
            'Dr Simon Hughes \u2013 University Hospitals Birmingham',
            'Miss Hannah Chandler \u2013 Northwick Park Hospital',
          ]
            .map(LI)
            .join('')}</ul>` +
          P('<strong>Deputy Chair</strong>') +
          `<ul>${['Dr Sarah McQuaid \u2013 Barts Health NHS Trust'].map(LI).join('')}</ul>`,
        h: 310,
        bullets: true,
      },
      {
        type: 'text',
        heading: 'Committee Members',
        html: `<ul>${[
          'Carla Abreu',
          'Ramla Awais',
          'Humayun Bashir',
          'Nathan Dickinson',
          'Sabina Dizdarevic',
          'Clara Ferreira',
          'Francesco Fraioli',
          'Fahim Ul Hassan',
          'Phil Hillel',
          'Greg James',
          'Anver Kamil',
          'Chen Low',
          'Monica Martins',
          'Mariana Pinto',
          'Jane Sosabowksi',
          'Giorgio Testanera',
          'Kshama Wechalekar',
        ]
          .map(LI)
          .join('')}</ul>`,
        h: 958,
        bullets: true,
      },
    ],
    closingHero: {
      headline: 'Supporting Education in Nuclear Medicine',
      subheadline: 'The Scientific & Education Committee helps shape the scientific programme and educational opportunities delivered by BNMS, supporting learning and professional development across the nuclear medicine community.',
      ctaLabel: 'Contact the Committee',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const RESEARCH_INNOVATION = {
  tenantId: BNMS_TENANT_ID,
  slug: 'research-and-innovation',
  title: 'Research & Innovation',
  design: buildDesign({
    hero: {
      headline: 'Research & Innovation',
      subheadline: 'Supporting research, collaboration and innovation to advance nuclear medicine across the UK.',
      ctaLabel: 'Get Involved in Research',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-flask',
      strapline: 'Research at BNMS',
      html:
        P('Research and innovation are central to the mission of the British Nuclear Medicine Society. BNMS supports high-quality research that improves patient care and advances the specialty.') +
        P('The Society encourages collaboration across disciplines and organisations, helping members share knowledge, develop new ideas and translate research into practice.') +
        P('From national imaging platforms to molecular radiotherapy studies, BNMS members are involved in a wide range of research and registry projects across the UK.'),
      h: 360,
    },
    sections: [
      {
        type: 'placeholder',
        heading: 'Research & Innovation at BNMS',
        note: NOTE('The BNMS Research & Innovation video will be embedded here.'),
        h: 130,
      },
      {
        type: 'text',
        heading: 'BNMS Research Strategy',
        html:
          P('The BNMS Research Strategy sets out the Society\u2019s priorities for supporting and developing research across nuclear medicine.') +
          P('It aims to encourage collaboration, build research capacity, support early-career researchers and ensure that research continues to improve patient care.'),
        h: 240,
      },
      {
        type: 'accordion',
        heading: 'Current Research & Collaborative Projects',
        h: 420,
        items: [
          {
            q: 'Research and Registry Topics',
            a:
              P('A selection of current research and registry topics involving BNMS members includes:') +
              `<ul>${LI('99mTc PSMA imaging')}${LI('Total Body PET-CT National Platform')}${LI('Extravasation monitoring')}${LI('MultiMIBI renal masses study')}${LI('PET-CT in breast cancer')}${LI('PET-CT in inflammatory disease')}${LI('FDG PET-CT in gastric cancer')}${LI('DaTSCAN in atypical parkinsonian syndromes')}${LI('Multi-tracer brain imaging in dementia')}${LI('Artificial intelligence in PET')}${LI('FDG PET-CT for monitoring and predicting treatment response to TKIs')}${LI('PET-CT in Long Covid')}${LI('PSMA database / registry')}${LI('Molecular radiotherapy multicentre trials')}${LI('Combined alpha and beta treatments')}${LI('Quantification for treatment response in nuclear cardiology')}</ul>`,
          },
          {
            q: 'Molecular Radiotherapy Projects',
            a:
              P('<strong>Horizon Scanning Paper</strong>') +
              P('A horizon-scanning project reviewing emerging molecular radiotherapy treatments and their potential impact on UK services.') +
              P('<strong>Dosimetry Study</strong>') +
              P('A collaborative dosimetry study supporting the safe and effective delivery of molecular radiotherapy.'),
          },
          {
            q: 'National PET Imaging Platform',
            a:
              P('The National PET Imaging Platform (NPIP) is a collaborative initiative supporting PET imaging research and infrastructure across the UK.') +
              P('BNMS supports the platform and encourages members to engage with the opportunities it provides.'),
            links: [{ label: 'Visit NPIP', url: '#' }],
          },
          {
            q: 'Research Power Pitches',
            a:
              P('Research Power Pitches give members the opportunity to present research ideas and proposals to the wider community.') +
              P('Successful pitches help build collaboration and support the development of new research projects.'),
            links: [{ label: 'View Successful Research Power Pitches', url: '#' }],
          },
        ],
      },
      {
        type: 'text',
        heading: 'BNMS Research Champions Network',
        html:
          P('The BNMS Research Champions Network connects individuals across the UK who help promote and support research within their organisations.') +
          P('Research Champions act as local points of contact, encouraging engagement and helping colleagues get involved in research activity.'),
        h: 220,
      },
      {
        type: 'placeholder',
        heading: 'Meet the Research Champions',
        note: NOTE('A searchable table of the BNMS Research Champions (Name, Organisation and Role) will be displayed here.'),
        h: 140,
      },
    ],
    closingHero: {
      headline: 'Get Involved in Research',
      subheadline: 'Whether you are an experienced researcher or just starting out, there are many ways to get involved in research and innovation through BNMS.',
      ctaLabel: 'Get Involved in Research',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const RADIOPHARMACEUTICAL_SCIENCES = {
  tenantId: BNMS_TENANT_ID,
  slug: 'radiopharmaceutical-sciences-group',
  title: 'Radiopharmaceutical Sciences Group',
  design: buildDesign({
    hero: {
      headline: 'Radiopharmaceutical Sciences Group',
      subheadline: 'Supporting collaboration, knowledge sharing and professional development in radiopharmaceutical sciences.',
      ctaLabel: 'Contact the Chair',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-vials',
      strapline: 'About the Group',
      html:
        P('The Radiopharmaceutical Sciences Group brings together professionals working in the preparation, quality control and development of radiopharmaceuticals used in nuclear medicine.') +
        P('The Group supports collaboration, knowledge sharing and professional development, helping to maintain high standards in radiopharmaceutical sciences across the UK.'),
      h: 260,
    },
    sections: [
      {
        type: 'text',
        heading: 'Group Leadership',
        html:
          P('The Radiopharmaceutical Sciences Group is chaired by Bev Ellis, based at Manchester Royal Infirmary.') +
          P('Members interested in learning more about the Group or becoming involved are encouraged to contact the Chair.') +
          P('<strong>Chair</strong><br/>Bev Ellis<br/>Manchester Royal Infirmary<br/>Department of Nuclear Medicine<br/>Oxford Road<br/>Manchester'),
        h: 340,
      },
    ],
    closingHero: {
      headline: 'Join the Radiopharmaceutical Sciences Community',
      subheadline: 'If you work in radiopharmaceutical sciences and would like to connect with colleagues across the UK or contribute to the work of the Group, we would be pleased to hear from you.',
      ctaLabel: 'Contact the Chair',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const RTN_COMMITTEE = {
  tenantId: BNMS_TENANT_ID,
  slug: 'radiographers-technologists-and-nurses-committee',
  title: 'Radiographers, Technologists & Nurses Committee',
  design: buildDesign({
    hero: {
      headline: 'Radiographers, Technologists & Nurses Committee',
      subheadline: 'Bringing together Radiographers, Technologists and Nurses to support professional collaboration, education and excellence in nuclear medicine.',
      ctaLabel: 'Contact the RTN Committee',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-user-nurse',
      strapline: 'About the RTN Committee',
      html:
        P('The Radiographers, Technologists & Nurses (RTN) Committee represents the interests of Radiographers, Technologists and Nurses working within nuclear medicine.') +
        P('The Committee supports professional collaboration, education and the development of best practice across these professions.') +
        P('It also provides a voice for members within BNMS and works to promote the important role these professionals play in delivering high-quality patient care.'),
      h: 340,
    },
    sections: [
      {
        type: 'text',
        heading: 'Our Objectives',
        html:
          P('The Committee aims to:') +
          `<ul>${LI('Represent the interests of Radiographers, Technologists and Nurses within BNMS.')}${LI('Support education, training and continuing professional development.')}${LI('Promote best practice and professional standards.')}${LI('Encourage collaboration and networking across the professions.')}${LI('Provide opportunities for members to get involved in the work of the Society.')}</ul>`,
        h: 380,
      },
      {
        type: 'placeholder',
        heading: 'Committee Leadership & Members',
        note: NOTE('The RTN Committee Co-Chairs, Secretary and full membership will be displayed here through the searchable member directory.'),
        h: 150,
      },
      {
        type: 'text',
        heading: 'Get Involved',
        html:
          P('The RTN Committee welcomes members who would like to contribute to its work and represent their profession within BNMS.') +
          P('Committee members are expected to:') +
          `<ul>${LI('Attend committee meetings.')}${LI('Contribute to discussions and initiatives.')}${LI('Support the professional development of colleagues.')}${LI('Help promote the work of BNMS within their organisations.')}</ul>` +
          P('If you would like to get involved, please contact the Committee.'),
        h: 420,
      },
      {
        type: 'text',
        heading: 'Resources',
        html:
          P('The RTN Committee supports a range of professional initiatives and resources for members.') +
          P('Useful links include:') +
          `<ul>${LI('RTN Committee Terms of Reference')}${LI('RTN Community (JISCMail)')}${LI('Ros Breen Fund')}${LI('Volunteer information')}</ul>`,
        h: 300,
      },
    ],
    closingHero: {
      headline: 'Join the RTN Community',
      subheadline: 'Whether you are a Radiographer, Technologist or Nurse working in nuclear medicine, the RTN Committee offers opportunities to connect, learn and shape the future of the profession.',
      ctaLabel: 'Contact the RTN Committee',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const PROFESSIONAL_STANDARDS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'professional-standards-committee',
  title: 'Professional Standards Committee',
  design: buildDesign({
    hero: {
      headline: 'Professional Standards Committee',
      subheadline: 'Supporting the development of professional standards, clinical guidance and best practice in nuclear medicine.',
      ctaLabel: 'Terms of Reference',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-clipboard-check',
      strapline: 'The Role of the Professional Standards Committee',
      html:
        P('The Professional Standards Committee supports the development and maintenance of professional standards, clinical guidance and best practice across nuclear medicine.') +
        P('The Committee develops and reviews clinical guidelines, provides advice on professional and regulatory matters, and represents BNMS on issues relating to standards and safe working.') +
        P('Its work helps ensure that nuclear medicine services are delivered safely, effectively and to a consistently high standard.'),
      h: 340,
    },
    sections: [
      {
        type: 'text',
        heading: 'Committee Leadership',
        html:
          P('The Professional Standards Committee is chaired by Professor Andy Irwin, who also represents professional standards and working in nuclear medicine on behalf of BNMS.') +
          P('<strong>Chair</strong><br/>Professor Andy Irwin<br/>Singleton Hospital, Swansea'),
        cta: 'Email the Chair',
        h: 260,
      },
      {
        type: 'text',
        heading: 'Committee Members',
        html: `<ul>${[
          'Mr A Irwin \u2013 Swansea \u2013 Professional Standards Chair',
          'Dr A Parthipun \u2013 London \u2013 Radiologist',
          'Dr P Fielding \u2013 Cardiff \u2013 Radiologist',
          'Dr M Naik \u2013 London \u2013 Radiologist',
          'Ms L Glowacki \u2013 Southampton \u2013 Healthcare Science Practitioner',
          'Dr N Mulholland \u2013 London \u2013 Radiologist',
          'Miss M Martins \u2013 Swansea \u2013 RTNG Chair',
          'Dr B Ellis \u2013 Manchester \u2013 Radiopharmacist',
          'Dr S Hughes \u2013 Birmingham \u2013 SEC Co-Chair',
          'Miss Mariana Pinto \u2013 Belfast \u2013 RTNG Co-Chair',
          'Mr M Walker \u2013 Oxford \u2013 IPEM NMSIG',
          'Mr A Hardy \u2013 Wigan \u2013 Patient Representative',
          'Paul Scully \u2013 London \u2013 BNCS Representative',
          'Dr Stewart Redman \u2013 Bath \u2013 BNMS President-Elect',
          'Prof S Dizdarevic \u2013 Brighton \u2013 BNMS President',
          'Dr A Eccles \u2013 London \u2013 BNMS Honorary Secretary',
          'Dr C Kalirai \u2013 Nottingham \u2013 BNMS Honorary Treasurer',
          'Ms C Weston \u2013 Derby \u2013 CEO',
        ]
          .map(LI)
          .join('')}</ul>`,
        h: 1015,
        bullets: true,
      },
    ],
    closingHero: {
      headline: 'Supporting Professional Excellence',
      subheadline: 'The Professional Standards Committee plays a key role in maintaining high standards and supporting safe, effective and consistent nuclear medicine practice across the UK.',
      ctaLabel: 'Terms of Reference',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const PEOPLE = {
  tenantId: BNMS_TENANT_ID,
  slug: 'people',
  title: 'People',
  design: buildDesign({
    hero: {
      headline: 'People',
      subheadline: 'Meet the people, volunteers and professional communities who lead, support and shape the British Nuclear Medicine Society.',
      ctaLabel: 'Explore Professional Groups',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-people-group',
      strapline: 'A Society Built by People',
      html:
        P('The British Nuclear Medicine Society is shaped by the people who lead, support and contribute to its work.') +
        P('From our Council and professional groups to our regional leads, office team and volunteers, BNMS depends on the dedication of individuals across the nuclear medicine community.') +
        P('Together, they help deliver the Society\u2019s services, events, education and support for members throughout the UK.'),
      h: 340,
    },
    sections: [
      {
        type: 'cards',
        heading: 'Meet the BNMS Community',
        columns: 4,
        cardH: 400,
        cards: [
          {
            icon: 'fa-solid fa-people-roof',
            heading: 'Council',
            body: P('The BNMS Council provides strategic leadership and governance for the Society, helping to shape its vision, priorities and charitable objectives on behalf of the membership.'),
          },
          {
            icon: 'fa-solid fa-users-gear',
            heading: 'Professional Groups',
            body: P('Professional Groups represent the different disciplines and specialist interests within nuclear medicine, supporting education, research, standards and collaboration.'),
            cta: 'Explore Professional Groups',
          },
          {
            icon: 'fa-solid fa-map-location-dot',
            heading: 'Regional Leads',
            body: P('Regional Leads strengthen connections across the UK by supporting members within their regions and helping BNMS maintain close links with the wider community.'),
          },
          {
            icon: 'fa-solid fa-building',
            heading: 'BNMS Office',
            body: P('The BNMS office team supports the day-to-day running of the Society, working closely with members, volunteers, committees and partner organisations.'),
          },
        ],
      },
      {
        type: 'text',
        heading: 'Recognising Outstanding Contributions',
        html:
          P('BNMS is proud to recognise individuals who have made an outstanding contribution to nuclear medicine and to the Society.') +
          P('Honorary Membership is one of the ways we celebrate the achievements and dedication of colleagues across the profession.'),
        h: 220,
      },
      {
        type: 'placeholder',
        heading: 'Honorary Members',
        note: NOTE('The BNMS Honorary Members will be displayed here through the searchable member directory.'),
        h: 130,
      },
      {
        type: 'feature',
        heading: 'Celebrating Our Community',
        html:
          P('There are many ways to get involved and connect with the BNMS community.') +
          P('Here you can:') +
          `<ul>${LI('Learn about the work of Council and the professional groups.')}${LI('Find your regional leads and local contacts.')}${LI('Discover how to volunteer and contribute to the Society.')}${LI('Recognise and celebrate the achievements of colleagues.')}</ul>`,
        bullets: true,
        cta: 'Get Involved',
        h: 420,
      },
      {
        type: 'text',
        heading: 'Thank You',
        html:
          P('The work of BNMS would not be possible without the commitment of its members, volunteers and staff.') +
          P('We are grateful to everyone who gives their time and expertise to support the Society and the wider nuclear medicine community.'),
        h: 240,
      },
    ],
    closingHero: {
      headline: 'Get Involved with BNMS',
      subheadline: 'Whether you serve on Council, contribute to a Professional Group or volunteer behind the scenes, there are many ways to be part of the BNMS community.',
      ctaLabel: 'Explore Professional Groups',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const ABOUT_US = {
  tenantId: BNMS_TENANT_ID,
  slug: 'about-us',
  title: '60 Years of the British Nuclear Medicine Society',
  design: buildDesign({
    hero: {
      headline: '60 Years of the British Nuclear Medicine Society',
      subheadline: 'Celebrating six decades of leadership, collaboration, education and innovation in nuclear medicine.',
      ctaLabel: 'Explore the Interactive Timeline',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-cake-candles',
      strapline: 'Celebrating 60 Years of BNMS',
      html:
        P('For sixty years, the British Nuclear Medicine Society has brought together the professionals who deliver, develop and advance nuclear medicine in the UK.') +
        P('From its foundation, BNMS has grown into the UK\u2019s professional society for nuclear medicine, supporting members across every discipline within the specialty.') +
        P('Over six decades, the Society has supported education, research, professional standards and collaboration, helping to improve patient care and shape the future of the field.') +
        P('As we celebrate this milestone, we look back on our history and forward to the next chapter of nuclear medicine.'),
      h: 460,
    },
    sections: [
      {
        type: 'feature',
        heading: 'Explore Our Interactive Timeline',
        html:
          P('Discover the key moments, milestones and achievements that have shaped BNMS over the past sixty years.') +
          P('Our interactive timeline brings the history of the Society to life, from its foundation to the present day.') +
          P('Explore decades of progress, innovation and collaboration in nuclear medicine.'),
        cta: 'Launch the 60-Year Timeline',
        h: 320,
      },
      {
        type: 'cards',
        heading: 'Discover Our History',
        columns: 4,
        cardH: 320,
        cards: [
          {
            icon: 'fa-solid fa-book-open',
            heading: 'The Story of BNMS',
            body: P('Learn how the Society has evolved from its foundation into the UK\u2019s professional society for nuclear medicine.'),
          },
          {
            icon: 'fa-solid fa-user-tie',
            heading: 'Past Presidents',
            body: P('Discover the individuals who have led BNMS over the past sixty years and helped shape the Society\u2019s direction.'),
          },
          {
            icon: 'fa-solid fa-calendar-days',
            heading: 'Annual Meetings',
            body: P('Explore the history of BNMS scientific meetings, bringing together professionals from across the community for six decades.'),
          },
          {
            icon: 'fa-solid fa-flag-checkered',
            heading: 'Society Milestones',
            body: P('From major developments in nuclear medicine to significant achievements within BNMS, discover the milestones that have shaped the specialty.'),
          },
        ],
      },
      {
        type: 'text',
        heading: 'Looking Back \u2014 Looking Forward',
        html:
          P('The past sixty years have seen extraordinary advances in nuclear medicine, from new imaging techniques and radiopharmaceuticals to the growth of molecular radiotherapy.') +
          P('Throughout this time, BNMS has supported the professionals at the heart of these developments.') +
          P('As we look to the future, the Society remains committed to supporting research, education and professional excellence.') +
          P('Together, we will continue to advance nuclear medicine for the benefit of patients across the UK.'),
        h: 420,
      },
      {
        type: 'feature',
        heading: 'Thank You to Our Members',
        html:
          P('This milestone belongs to everyone who has been part of the BNMS story.') +
          P('We are grateful to our members, volunteers, past leaders and partners for their dedication and support over the past six decades.') +
          P('Your commitment has made BNMS what it is today.'),
        h: 320,
      },
      {
        type: 'cards',
        heading: 'Be Part of the Story',
        columns: 2,
        cardH: 300,
        cards: [
          {
            icon: 'fa-solid fa-users',
            heading: 'Meet the People Behind BNMS',
            body: P('Discover the Council, professional groups, regional representatives, honorary members, staff and volunteers who continue to support the Society today.'),
            cta: 'Meet Our People',
          },
          {
            icon: 'fa-solid fa-user-plus',
            heading: 'Be Part of the Next Chapter',
            body: P('Join the UK\u2019s professional society for nuclear medicine and help shape the future of the specialty.'),
            cta: 'Become a Member',
          },
        ],
      },
    ],
    closingHero: {
      headline: 'Here\u2019s to the Next 60 Years',
      subheadline: 'Thank you for being part of the BNMS story. Explore our history and help us shape the future of nuclear medicine.',
      ctaLabel: 'Explore the Interactive Timeline',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const IN_MEMORIAM = {
  tenantId: BNMS_TENANT_ID,
  slug: 'in-memoriam',
  title: 'In Memoriam',
  design: buildDesign({
    hero: {
      headline: 'In Memoriam',
      subheadline: 'Honouring the members, colleagues and pioneers whose dedication, compassion and expertise helped shape nuclear medicine and the British Nuclear Medicine Society.',
      ctaLabel: 'Contact the BNMS Office',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-dove',
      strapline: 'Remembering Our Colleagues',
      html:
        P('The British Nuclear Medicine Society remembers with gratitude the members and colleagues who have contributed so much to nuclear medicine and to the Society.') +
        P('Their dedication, expertise and compassion helped shape the specialty and inspired generations of colleagues.') +
        P('On this page we honour their memory and celebrate their lasting contribution to the profession.'),
      h: 340,
    },
    sections: [
      {
        type: 'text',
        heading: 'Those We Remember',
        html:
          P('Browse the tributes below to learn more about the colleagues we remember.') +
          P('Select \u201CView Tribute\u201D to read more about each individual and their contribution to nuclear medicine.'),
        h: 200,
      },
      {
        type: 'cards',
        heading: 'Tributes',
        columns: 3,
        cardH: 380,
        cards: [
          { heading: 'Dr Leslie Keith Harding', body: P('<strong>1939 \u2013 2023</strong>') + P('Past President and Treasurer of BNMS and recipient of the President\u2019s Medal for his exceptional contribution to nuclear medicine.'), cta: 'View Tribute' },
          { heading: 'Dr T M D \u201CTim\u201D Gimlette', body: P('<strong>1927 \u2013 2022</strong>') + P('Former President of BNMS and one of the pioneers who helped establish and develop nuclear medicine in the United Kingdom.'), cta: 'View Tribute' },
          { heading: 'Professor H J \u201CTito\u201D Testa', body: P('Consultant Nuclear Medicine Physician, Honorary Member of BNMS and a respected colleague remembered with affection throughout the profession.'), cta: 'View Tribute' },
          { heading: 'Dr Howard Gemmell', body: P('<strong>1949 \u2013 2022</strong>') + P('A long-standing BNMS member whose contribution to nuclear medicine and to the Society is remembered with gratitude.'), cta: 'View Tribute' },
          { heading: 'Professor John Mallard', body: P('<strong>1927 \u2013 2021</strong>') + P('Medical imaging pioneer, Honorary Member of BNMS and recipient of the Norman Veall Medal.'), cta: 'View Tribute' },
          { heading: 'Dr Muriel Buxton-Thomas', body: P('<strong>1945 \u2013 2016</strong>') + P('An internationally recognised Nuclear Medicine Physician whose leadership and commitment helped transform clinical nuclear medicine services.'), cta: 'View Tribute' },
          { heading: 'Professor Ignac Fogelman', body: P('<strong>1948 \u2013 2016</strong>') + P('Teacher, mentor, researcher and colleague whose influence on nuclear medicine continues to be felt across the profession.'), cta: 'View Tribute' },
          { heading: 'Ingrid Crane', body: P('<strong>1935 \u2013 2011</strong>') + P('Founder of the BNMS Nurses\u2019 Group whose dedication helped establish and strengthen the role of nurses within nuclear medicine.'), cta: 'View Tribute' },
          { heading: 'Professor Edward Sydney Williams', body: P('<strong>1923 \u2013 2015</strong>') + P('Nuclear medicine pioneer, educator, researcher and former Director of the Institute of Nuclear Medicine.'), cta: 'View Tribute' },
          { heading: 'Dr Russell Bayly', body: P('<strong>1924 \u2013 2014</strong>') + P('Scientist, innovator and one of the early supporters of British nuclear medicine and radiopharmaceutical development.'), cta: 'View Tribute' },
          { heading: 'Dr Desmond Croft', body: P('Founder member and former President of BNMS who played a pivotal role in establishing nuclear medicine as a recognised medical specialty.'), cta: 'View Tribute' },
          { heading: 'Dr Ajit Kumar Padhy', body: P('A globally respected leader in nuclear medicine whose work influenced clinical practice and education throughout the world.'), cta: 'View Tribute' },
        ],
      },
    ],
    closingHero: {
      headline: 'Help Us Remember',
      subheadline: 'If you would like to share a tribute or let us know about a colleague we should remember, please contact the BNMS Office.',
      ctaLabel: 'Contact the BNMS Office',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const DR_AJIT_KUMAR_PADHY = {
  tenantId: BNMS_TENANT_ID,
  slug: 'dr-ajit-kumar-padhy',
  title: 'Dr Ajit Kumar Padhy',
  design: buildDesign({
    hero: {
      headline: 'Dr Ajit Kumar Padhy',
      subheadline: 'International Leader in Nuclear Medicine',
      // No CTA — the source document supplies no call-to-action or links.
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-dove',
      strapline: 'Physician, educator and global advocate whose work advanced nuclear medicine throughout the world',
      html:
        P('Dr Ajit Kumar Padhy was an internationally respected leader in nuclear medicine whose dedication to education, collaboration and professional development helped shape the specialty on a global scale.') +
        P('Throughout his distinguished career, Dr Padhy worked tirelessly to promote the benefits of nuclear medicine, encouraging greater international cooperation and supporting the development of services in both established and emerging healthcare systems. His vision extended beyond national boundaries, helping to improve patient care through education, research and the sharing of knowledge.') +
        P('Widely recognised for his leadership, Dr Padhy was passionate about ensuring that advances in nuclear medicine could be shared with healthcare professionals across the world. Through his work with international organisations, educational initiatives and scientific meetings, he inspired countless clinicians, scientists and researchers throughout his career.') +
        P('His enthusiasm, generosity and commitment to teaching made him a valued mentor and colleague to many within the international nuclear medicine community. Those who worked alongside him remember not only his professional achievements but also his warmth, encouragement and unwavering belief in the importance of collaboration.') +
        P('The British Nuclear Medicine Society was proud to count Dr Padhy among the many international colleagues whose work helped strengthen the global nuclear medicine community. His influence continues to be seen through the professionals he inspired and the worldwide partnerships he helped establish.') +
        P('The British Nuclear Medicine Society remembers Dr Ajit Kumar Padhy with gratitude and respect, recognising his outstanding contribution to international nuclear medicine and his enduring legacy of education, collaboration and patient care.'),
      h: 1040,
    },
    sections: [
      {
        type: 'text',
        heading: 'Professional Contributions',
        html:
          `<ul>${LI('International leader in nuclear medicine')}${LI('Champion of education and professional development')}${LI('Advocate for global collaboration')}${LI('Respected teacher, mentor and speaker')}${LI('Influential supporter of worldwide nuclear medicine services')}</ul>`,
        h: 320,
        bullets: true,
      },
    ],
    // No closing hero — the document supplies no closing headline or CTA.
  }),
};

const GOVERNANCE = {
  tenantId: BNMS_TENANT_ID,
  // 'governance' is an existing immutable iedit page; use a distinct slug so this
  // new CanvasBuilder page does not attempt to overwrite it.
  slug: 'governance-and-policies',
  title: 'Governance',
  design: buildDesign({
    hero: {
      headline: 'Governance',
      subheadline: 'Access the governance documents, policies and official information that support the work of the British Nuclear Medicine Society.',
      ctaLabel: 'Browse Governance Resources',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-scale-balanced',
      strapline: 'Open, Transparent and Well Governed',
      html:
        P('The British Nuclear Medicine Society is committed to being open, transparent and well governed.') +
        P('As a registered charity, BNMS operates in line with its governing documents and a clear framework of policies and procedures.') +
        P('This page brings together the key governance documents, policies and information that support the running of the Society.'),
      h: 340,
    },
    sections: [
      {
        type: 'columns',
        columns: [
          {
            h3: 'Governance Documents',
            html:
              P('Key documents relating to the governance and operation of the Society.') +
              `<ul>${LI('Articles of Association')}${LI('Annual General Meeting (AGM) papers')}${LI('Annual reports')}${LI('Charity information')}</ul>`,
            h: 300,
          },
          {
            h3: 'Society Policies',
            html:
              P('Policies that support the effective operation of BNMS.') +
              `<ul>${LI('Privacy Policy')}${LI('Communications & Social Media Policy')}${LI('Expenses Policy')}${LI('Survey Policy')}${LI('Delegate Terms & Conditions')}</ul>`,
            h: 340,
          },
        ],
      },
      {
        type: 'columns',
        columns: [
          {
            h3: 'Committee Information',
            html:
              P('Useful information for Council members, committee members and volunteers.') +
              `<ul>${LI('Committee Code of Conduct')}${LI('Committee Terms of Reference')}${LI('Committee resources')}${LI('New committee member information')}</ul>`,
            h: 300,
          },
          {
            h3: 'Declarations of Interest',
            html:
              P('BNMS is committed to openness, transparency and scientific integrity. Declarations help identify and manage potential conflicts of interest.') +
              `<ul>${LI('Trustee, Committee Member and Guideline Reviewer declaration')}${LI('Invited Speaker declaration')}${LI('Declaration guidance')}${LI('Declaration slides for presentations')}</ul>`,
            h: 340,
          },
        ],
      },
      {
        type: 'feature',
        heading: 'Resource Library',
        html:
          P('All governance documents, policies and forms are available through the BNMS Resource Library.') +
          P('The library provides a central location for members to access the latest versions of key documents.'),
        cta: 'Browse Governance Resources',
        h: 280,
      },
    ],
    closingHero: {
      headline: 'Can\u2019t Find What You\u2019re Looking For?',
      subheadline: 'If you are unable to locate a governance document or require further information, the BNMS Office will be pleased to help.',
      ctaLabel: 'Contact the BNMS Office',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const DOI_SPEAKERS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'declaration-of-interests-for-invited-speakers',
  title: 'Declaration of Interests for Invited Speakers',
  design: buildDesign({
    hero: {
      headline: 'Declaration of Interests for Invited Speakers',
      subheadline: 'Supporting transparency and scientific integrity at BNMS events.',
      ctaLabel: 'Complete Speaker Declaration',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-file-signature',
      strapline: 'Speaker Declarations',
      html:
        P('BNMS is committed to openness, transparency and scientific integrity at all of its events.') +
        P('All invited speakers and presenters are asked to declare any interests that could be perceived as influencing their presentation.') +
        P('Declaring interests helps maintain the trust and confidence of the audience and supports the integrity of the scientific programme.'),
      h: 340,
    },
    sections: [
      {
        type: 'text',
        heading: 'Before Your Presentation',
        html:
          P('Please ensure you:') +
          `<ul>${LI('Complete the Speaker Declaration of Interest form.')}${LI('Include a Declaration of Interests slide within your presentation.')}${LI('If you have no interests to declare, use the \u201CNothing to Declare\u201D slide provided below.')}</ul>`,
        h: 280,
      },
      {
        type: 'text',
        heading: 'Resources',
        html:
          P('The following resources are available to support your declaration:') +
          `<ul>${LI('Declaration guidance')}${LI('Declaration of Interests slide')}${LI('\u201CNothing to Declare\u201D slide')}</ul>`,
        buttons: ['Complete Speaker Declaration', 'Download Presentation Slides'],
        h: 260,
      },
      {
        type: 'placeholder',
        heading: 'Speaker Declaration Form',
        note: NOTE('The online Speaker Declaration of Interest form will be embedded here.'),
        h: 130,
      },
    ],
    closingHero: {
      headline: 'Complete Your Speaker Declaration',
      subheadline: 'All invited speakers and presenters are required to declare any interests that could be perceived as influencing their presentation.',
      ctaLabel: 'Complete Speaker Declaration',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const DOI = {
  tenantId: BNMS_TENANT_ID,
  slug: 'declaration-of-interests',
  title: 'Declaration of Interests',
  design: buildDesign({
    hero: {
      headline: 'Declaration of Interests',
      subheadline: 'Helping ensure transparency, integrity and good governance across the British Nuclear Medicine Society.',
      ctaLabel: 'Complete Declaration of Interest',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-file-signature',
      strapline: 'Why Complete a Declaration?',
      html:
        P('BNMS is committed to openness, transparency and good governance.') +
        P('Declaring interests helps identify and manage any potential conflicts of interest that could affect, or be perceived to affect, decision-making within the Society.') +
        P('Completing a declaration protects both individuals and the Society, and supports public trust in our work.'),
      h: 340,
    },
    sections: [
      {
        type: 'text',
        heading: 'Who Should Complete This Form?',
        html:
          P('This declaration should be completed by:') +
          `<ul>${LI('Trustees')}${LI('Council and Committee Members')}${LI('Guideline Reviewers')}</ul>` +
          P('A declaration must be submitted annually, even if your circumstances have not changed.') +
          P('If you are an invited speaker at a BNMS event, please complete the separate Speaker Declaration of Interest form.'),
        h: 360,
      },
      {
        type: 'placeholder',
        heading: 'Complete Your Declaration',
        note: NOTE('The online Declaration of Interest form will be embedded here.'),
        h: 130,
      },
      {
        type: 'text',
        heading: 'Need More Information?',
        html: P('Examples of interests that should be declared, together with further guidance, are available below.'),
        buttons: ['Declaration Guidance', 'Complete Declaration of Interest'],
        h: 160,
      },
    ],
    closingHero: {
      headline: 'Complete Your Declaration of Interest',
      subheadline: 'Trustees, Committee Members and Guideline Reviewers are asked to complete a declaration annually to support transparency and good governance.',
      ctaLabel: 'Complete Declaration of Interest',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const CLINICAL_SCIENTISTS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'clinical-scientists-group',
  title: 'Clinical Scientists Group',
  design: buildDesign({
    hero: {
      headline: 'Clinical Scientists Group',
      subheadline: 'Supporting collaboration, professional development and scientific excellence within nuclear medicine.',
      ctaLabel: 'Contact BNMS',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-microscope',
      strapline: 'About the Group',
      html:
        P('The Clinical Scientists Group represents Clinical Scientists working within nuclear medicine and medical physics.') +
        P('The Group supports collaboration, professional development and scientific excellence, providing a voice for Clinical Scientists within BNMS.'),
      h: 260,
    },
    sections: [
      {
        type: 'text',
        heading: 'Resources',
        html:
          P('BNMS provides a range of resources to support Clinical Scientists throughout their careers.') +
          P('These include information on:') +
          `<ul>${LI('Careers in nuclear medicine')}${LI('Clinical Scientist career pathways')}${LI('Education and training')}${LI('Professional development')}${LI('Continuing Professional Development (CPD)')}</ul>` +
          P('Further resources are available through the Careers and Education sections of the BNMS website.'),
        h: 360,
      },
    ],
    closingHero: {
      headline: 'Get Involved',
      subheadline: 'If you are a Clinical Scientist working within nuclear medicine and would like to contribute to the work of BNMS or connect with colleagues across the UK, we would be pleased to hear from you.',
      ctaLabel: 'Contact BNMS',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const MEDICAL_TRAINING = {
  tenantId: BNMS_TENANT_ID,
  slug: 'bnms-medical-training-committee',
  title: 'BNMS Medical Training Committee',
  design: buildDesign({
    hero: {
      headline: 'BNMS Medical Training Committee',
      subheadline: 'Supporting doctors-in-training and medical students to explore, understand and develop careers in nuclear medicine.',
      ctaLabel: 'Terms of Reference',
      bgImageUrl: HERO_IMG_OPEN,
    },
    sections: [
      {
        type: 'text',
        heading: 'Committee Leadership',
        html: P('Led by Dr Sweni Shah, BNMS Consultant Radiologist and Nuclear Medicine Physician and Dr Amy Eccles, BNMS Honorary Secretary.'),
        h: 160,
      },
      {
        type: 'text',
        heading: 'Committee Members',
        html:
          P('Members include:') +
          `<ul>${[
            'Basil Raju',
            'Aoife Armstrong',
            'Ben Stapleton',
            'Benjamin Tse',
            'Dhwani Gandhi',
            'Layla Badawy',
            'Megha Goel',
            'Dongni Du',
            'Shiv Datta',
            'Kofi Asante',
          ]
            .map(LI)
            .join('')}</ul>`,
        h: 660,
        bullets: true,
      },
      {
        type: 'text',
        heading: 'Aims of BNMS Medical Training Committee',
        html: `<ul>${[
          'Increase awareness of diagnostic and therapeutic Nuclear Medicine amongst doctors-in-training and medical students.',
          'Provide educational content for doctors-in-training and medical students to aid their understanding of working in Nuclear Medicine and the training pathways.',
          'Provide opportunities for doctors-in-training and medical students to engage with the BNMS and improve their application for the specialties/training numbers.',
        ]
          .map(LI)
          .join('')}</ul>`,
        h: 360,
        bullets: true,
      },
      {
        type: 'text',
        heading: 'NEXUS-NL Weekend',
        html:
          P('Get ready for an inspiring weekend for university students and young professionals.') +
          P('<strong>Friday 18 September \u2013 Sunday 20 September 2026</strong>') +
          P('Get ready for the NEXUS-NL Weekend: a unique experience where meeting others, gaining knowledge, and personal development come together. This weekend is specially designed to connect, inspire, and empower the next generation of professionals in nuclear medicine.'),
        cta: 'Find Out More',
        h: 320,
      },
      {
        type: 'text',
        heading: 'Medical Training Essay Competition',
        html:
          P('You are invited to take part in the fourth BNMS Medical Training Essay Competition launched by the BNMS Medical Training Committee.') +
          P('Two top entries will be invited to present their work in a 7-minute oral presentation at the BNMS Annual Spring meeting in Manchester. The top two entries will also receive a certificate of merit, free 1-day registration to the conference and economy travel expenses will be reimbursed. (UK only).') +
          P('<strong>Submissions are now closed</strong>'),
        h: 340,
      },
      {
        type: 'text',
        heading: 'Opportunity for Residents: \u201cResidents4Residents\u201d session at EANM\u201926',
        html:
          P('EANM are pleased to inform you of an exciting opportunity for Nuclear Medicine residents: the EANM has launched an open call for the \u201cResidents 4 Residents\u201d session at EANM\u201926.') +
          P('Four resident-speakers will be selected to present their own clinical PET cases live at the congress.'),
        cta: 'Read More',
        h: 280,
      },
    ],
    closingHero: {
      headline: 'Supporting the Next Generation of Nuclear Medicine',
      subheadline: 'Whether you are exploring a career in nuclear medicine or already in training, BNMS offers opportunities to learn, connect and develop throughout your professional journey.',
      ctaLabel: 'Terms of Reference',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const RESEARCH_CHAMPIONS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'research-champions-network',
  title: 'BNMS Research Champions Network',
  design: buildDesign({
    hero: {
      headline: 'BNMS Research Champions Network',
      subheadline: 'A network of research champions from across the nuclear medicine community, working together to develop and deliver the BNMS Research Strategy.',
      ctaLabel: 'View the Research Strategy',
      bgImageUrl: HERO_IMG_OPEN,
    },
    sections: [
      {
        type: 'text',
        heading: 'BNMS Research Strategy',
        html:
          P('Prof Sabina Dizdarevic, Royal Sussex County Hospital, Brighton') +
          P('Prof Jane Sosabowski is now the BNMS Research Lead and has put together a group of research champions to develop the BNMS Research Strategy.'),
        cta: 'View the Research Strategy',
        h: 240,
      },
      {
        type: 'text',
        heading: 'List of Research and registry topics',
        html:
          P('This is a list of research currently of interest to the network and is not exhaustive') +
          `<ul>${[
            '[99Tc] PSMA',
            'Total Body PET-CT national platform',
            'Extravasation monitoring',
            'MIBI in Renal masses \u2013 MultiMIBI multi-centre study',
            'PET-CT Breast Cancer',
            'PET-CT in Inflammatory disease',
            'FDG PET-CT Gastric Cancer',
            'DaTScan in APS, DIP and REM',
            'Multi-tracer brain imaging of Dementia',
            'AI in PET - Nuclear medicine specific AI',
            'FDG PET-CT monitoring and predicting treatment response to TKI',
            'PET-CT in Long Covid 19 &amp; CSF',
            'PSMA Database / Registry',
            'MRT research multicentre trials- access to research',
            'Combined alpha &amp; beta treatments Combined MRT and non-MRT',
            'Quantification for treatment response in nuclear cardiology (cardiac amyloidosis and inflammation/infection)',
          ]
            .map(LI)
            .join('')}</ul>`,
        h: 1060,
        bullets: true,
      },
      {
        type: 'text',
        heading: 'List of MRT Projects',
        html: `<ul>${[
          'Horizon scanning paper - looking at what clinical trials are in progress globally, what we are running in the UK and what we need to prepare ourselves for. This is being led by Jane Sosabowski',
          'Dosimetry study - a group is working on a programme grant application for a study aiming to systematically collect dosimetry data as well as information about correlation with clinical outcomes and cost effectiveness. This is being led by Glenn Flux.',
        ]
          .map(LI)
          .join('')}</ul>`,
        h: 380,
        bullets: true,
      },
      {
        type: 'text',
        heading: 'The National PET Imaging Platform (NPIP)',
        html:
          P('The National PET Imaging Platform (NPIP) is the UK\u2019s first-of-its-kind national total-body positron emission tomography (PET) imaging platform for drug discovery.') +
          P('NPIP is a partnership between Medicines Discovery Catapult (MDC), the Medical Research Council (MRC) and Innovate UK. It brings together transformational research from state-of-the-art total-body PET imaging scanners to transform medical research and industrialise cutting-edge technology, enhancing the quality and speed of drug discovery.') +
          P('BNMS members can engage with NPIP through annual and local scientific meetings.') +
          P('NPIP welcomes collaboration and would be delighted to partner with BNMS members in their research and development programmes.'),
        cta: 'Visit NPIP',
        h: 460,
      },
      {
        type: 'text',
        heading: 'Research Power Pitches 2026',
        html:
          P('Submission for the Research Power Pitches has now closed for the BNMS Annual Spring Meeting 2026.') +
          P('You are invited to take part in the Power Pitch talks during the Research Cutting Edge Session at the next BNMS Annual Spring Meeting 2026, to be held in Manchester, 20th \u2013 22nd April 2026.') +
          P('Deadline for submissions extended to 9am on 19th January 2026.'),
        cta: 'View 2025 Submissions',
        h: 340,
      },
      {
        type: 'text',
        heading: 'BNMS Nuclear Medicine Research Champions',
        html: `<ul>${[
          'Dr Maria J Acosta \u2013 Medway Foundation Trust \u2013 Physician',
          'Mr Thomas Biggans \u2013 Ninewells Hospital, Dundee \u2013 Clinical Scientist',
          'Prof Philip Blower \u2013 King\u2019s College London \u2013 Radiopharmacist',
          'Prof Kevin Bradley \u2013 Cardiff University \u2013 Radiologist',
          'Mr Michael Chowen \u2013 Patient Representative',
          'Prof Sabina Dizdarevic \u2013 Brighton &amp; Sussex University Hospital \u2013 Physician',
          'Dr Amy Eccles \u2013 Imperial College Healthcare NHS Trust \u2013 Radiologist',
          'Dr Maged Elsewafy \u2013 Brighton &amp; Sussex University Hospital \u2013 Physician',
          'Mrs Louise Fraser \u2013 Public Health England \u2013 Clinical Scientist',
          'Dr Sameer Gangoli \u2013 Brighton &amp; Sussex University Hospital \u2013 Radiologist',
          'Dr Sai Hyne \u2013 Oxford University Hospitals NHS Foundation Trust \u2013 Trainee',
          'Ms Maryam Jessop \u2013 Brighton &amp; Sussex University Hospital \u2013 Technologist',
          'Dr David Lilburn \u2013 King\u2019s College London and Paul Strickland Scanner Centre \u2013 Academic',
          'Dr Michelle Ma \u2013 King\u2019s College London \u2013 Academic',
          'Dr Juliana Maynard \u2013 Catapult \u2013 PET Director and Head of Translational Imaging',
          'Prof Ralph McCready \u2013 Brighton &amp; Sussex University Hospital \u2013 Physician',
          'Dr Daniel McGowan \u2013 Oxford University Hospitals \u2013 Clinical Scientist',
          'David Newby \u2013 University of Edinburgh \u2013 Physician',
          'Gareth Pawson \u2013 Manchester University NHS Foundation Trust \u2013 Technologist',
          'Luisa Roldao Pereira \u2013 Maidstone &amp; Tunbridge Wells NHS Trust \u2013 Advanced Clinical Practitioner',
          'Prof Vineet Prakash \u2013 Royal Surrey County Hospital \u2013 Physician &amp; Radiologist',
          'Dr Chamani Punchihewa \u2013 Royal Surrey County Hospital \u2013 Radiologist',
          'Ms Victoria Rowse \u2013 University Hospitals Sussex NHS Foundation Trust \u2013 Clinical Scientist',
          'Dr Nitasha Singh \u2013 Brighton &amp; Sussex University Hospital \u2013 Physician &amp; Radiologist',
          'Prof Jane Sosabowski - BNMS Research Lead \u2013 Queen Mary\u2019s University London \u2013 Radiochemist',
          'Mr Giorgio Testanera \u2013 King\u2019s College London',
          'Dr Stefan Voo \u2013 University College London Hospital \u2013 Radiologist',
          'Prof Jonathan Wadsley \u2013 Sheffield Teaching Hospitals \u2013 Physician',
          'Dr Thomas Wagner \u2013 Royal Free Hospital \u2013 Physician',
          'Miss Hannah Warren \u2013 Royal Free Hospital \u2013 Urologist',
          'Dr Kshama Wechalekar \u2013 Royal Brompton and Harefield Hospitals \u2013 Physician',
          'Dr Jennifer Young \u2013 King\u2019s College London \u2013 Academic',
        ]
          .map(LI)
          .join('')}</ul>`,
        cta: 'Contact a Research Champion',
        h: 1980,
        bullets: true,
      },
    ],
    closingHero: {
      headline: 'Advancing Research in Nuclear Medicine',
      subheadline: 'The Research Champions Network brings together researchers, clinicians and scientists from across the UK to shape and deliver the BNMS Research Strategy.',
      ctaLabel: 'Contact a Research Champion',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const PREPARING_APPOINTMENT_NEW = {
  tenantId: BNMS_TENANT_ID,
  slug: 'preparing-for-your-appointment-new',
  title: 'Preparing for Your Nuclear Medicine Appointment',
  design: buildDesign({
    hero: {
      headline: 'Preparing for Your Nuclear Medicine Appointment',
      subheadline: 'Everything you need to know before, during and after your nuclear medicine scan or treatment.',
      ctaLabel: 'Explore Patient Resources',
      bgImageUrl: HERO_IMG_OPEN,
    },
    sections: [
      {
        type: 'text',
        heading: 'Before Your Appointment',
        html:
          P('Every nuclear medicine examination is different, so it is important to read carefully any information provided by the department carrying out your scan or treatment.') +
          P('Some procedures require special preparation, while others require very little preparation at all. Your appointment letter will explain exactly what you need to do before attending.') +
          P('If you have any questions before your appointment, please contact your Nuclear Medicine Department.'),
        h: 360,
      },
      {
        type: 'accordion',
        heading: 'Preparing for Your Visit',
        h: 420,
        items: [
          {
            q: 'Is my scan safe?',
            a:
              P('Nuclear medicine examinations use a very small amount of radioactive tracer, known as a radiopharmaceutical, to provide important information about how your body is functioning.') +
              P('For most patients, the benefits of having the scan greatly outweigh the very small risks associated with radiation exposure. A doctor will have reviewed your referral to ensure the examination is appropriate for your condition.') +
              P('If you have any concerns about why you have been referred for a scan, please speak to your referring clinician or the Nuclear Medicine Department.'),
          },
          {
            q: 'Pregnancy and Breastfeeding',
            a:
              P('If you are pregnant, think you may be pregnant or are breastfeeding, please contact the Nuclear Medicine Department as soon as possible before your appointment.') +
              P('Special arrangements or alternative examinations may sometimes be recommended to ensure the safest care for you and your baby.'),
          },
          {
            q: 'Preparing for Your Scan',
            a:
              P('Preparation varies depending on the type of examination.') +
              P('Some scans may require you to:') +
              `<ul>${LI('Avoid eating or drinking before your appointment.')}${LI('Avoid caffeine.')}${LI('Temporarily stop certain medications.')}${LI('Drink extra fluids.')}${LI('Follow other instructions provided by your department.')}</ul>` +
              P('If you have not received any specific preparation instructions, you can usually eat, drink and take your normal medication as usual.') +
              P('Always follow the instructions provided by your Nuclear Medicine Department.'),
          },
        ],
      },
      {
        type: 'columns',
        columns: [
          {
            h3: 'Receiving Your Radiopharmaceutical',
            html:
              P('Most nuclear medicine examinations require a small amount of radiopharmaceutical to be administered.') +
              P('This is usually given by injection into a vein in your arm or hand, similar to having a routine blood test. Some examinations involve swallowing or inhaling the tracer instead.') +
              P('For some scans, imaging begins immediately after the tracer is given. For others, there is a waiting period while the tracer travels to the part of the body being examined. Depending on the test, this waiting time can range from a few minutes to several hours.') +
              P('If your waiting time is longer, you may be able to leave the department temporarily before returning for your scan.'),
            h: 520,
          },
          {
            h3: 'During Your Scan',
            html:
              P('Before your scan you may be asked to empty your bladder.') +
              P('You may also be asked to remove jewellery, belts or other metal objects from the area being examined.') +
              P('Depending on the type of examination, you may:') +
              `<ul>${LI('Lie comfortably on a scanning couch.')}${LI('Sit in front of the scanner.')}${LI('Have images taken immediately or after a short delay.')}</ul>` +
              P('The scan itself is painless, but it is important to keep as still as possible while the images are being taken.') +
              P('A member of the Nuclear Medicine team will monitor you throughout your examination and will be available if you need any assistance.'),
            h: 520,
          },
        ],
      },
      {
        type: 'columns',
        columns: [
          {
            h3: 'Gamma Camera Scans',
            html:
              P('Most nuclear medicine examinations are performed using a Gamma Camera.') +
              P('The camera may have one or two detector heads that move close to your body to collect images. Although the camera comes close to you, it will not touch you and you will not feel anything during the scan.') +
              P('Some examinations also include a low-dose CT scan to provide additional anatomical information and help interpret the nuclear medicine images more accurately.'),
            h: 360,
          },
          {
            h3: 'PET/CT Scans',
            html:
              P('PET stands for Positron Emission Tomography.') +
              P('During a PET scan you will lie on a comfortable couch that moves slowly through a short scanner. Unlike an MRI scanner, the PET scanner is quiet and does not produce loud noises.') +
              P('Most PET examinations also include a CT scan, which helps accurately locate any areas identified on the PET images.'),
            h: 360,
          },
        ],
      },
      {
        type: 'text',
        heading: 'After Your Scan',
        html:
          P('Most patients feel completely well after their examination and can return to their normal daily activities unless advised otherwise by the Nuclear Medicine team.') +
          P('A small amount of radioactivity remains in your body for a short time after your scan. For some examinations you may be advised to:') +
          `<ul>${LI('Drink plenty of fluids to help remove the tracer more quickly.')}${LI('Minimise prolonged close contact with pregnant women, babies and young children for the remainder of the day.')}${LI('Follow any additional advice provided by your department.')}</ul>` +
          P('There is no need to avoid providing essential care to children or family members unless specifically advised.'),
        h: 460,
        bullets: true,
      },
      {
        type: 'accordion',
        heading: 'Frequently Asked Questions',
        h: 480,
        items: [
          {
            q: 'When will I receive my results?',
            a:
              P('Your images will be reviewed by a specialist doctor or appropriately qualified Clinical Scientist.') +
              P('A report is sent to the healthcare professional who referred you for the examination. They will discuss your results with you and explain what they mean for your care.'),
          },
          {
            q: 'I haven\u2019t received my results. What should I do?',
            a:
              P('If you have not yet received the results of your scan, please contact your hospital or GP surgery.') +
              P('Your scan report is sent to the healthcare professional who requested the examination, rather than directly to your GP. They will be able to explain your results and discuss any next steps in your care.') +
              P('Do not assume that \u201cno news is good news.\u201d If you are unsure when you should receive your results, please contact your healthcare team.'),
          },
          {
            q: 'Can I travel after my scan?',
            a:
              P('Yes. It is perfectly safe to travel after your examination.') +
              P('However, some airports and ports use highly sensitive radiation detectors which may detect the very small amount of radioactivity remaining in your body for a few days after your scan.') +
              P('If you are travelling within a week of your appointment, it is advisable to carry your appointment letter or other confirmation from the department where your scan was performed.'),
          },
          {
            q: 'Will my information remain confidential?',
            a:
              P('Yes.') +
              P('Information collected during your care is treated confidentially and is only shared with healthcare professionals involved in your treatment.') +
              P('Anonymous information may also be used to improve services, support training and future research. Any images used for education or research purposes will have all identifying information removed.'),
          },
          {
            q: 'I still have questions',
            a:
              P('If you have any questions before or after your appointment, please contact the Nuclear Medicine Department where your examination is taking place.') +
              P('They will be happy to answer any questions specific to your scan or treatment.'),
          },
        ],
      },
    ],
    closingHero: {
      headline: 'Looking for Information About Your Scan or Treatment?',
      subheadline: 'The BNMS Patient Resource Directory contains patient information leaflets, educational videos, downloadable guides and other resources to help you understand your procedure and prepare for your appointment.',
      ctaLabel: 'Explore Patient Resources',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const AWARDS_RECOGNITION = {
  tenantId: BNMS_TENANT_ID,
  slug: 'awards-and-recognition',
  title: 'Awards & Recognition',
  design: buildDesign({
    hero: {
      headline: 'Awards & Recognition',
      subheadline: 'Celebrating the people and teams whose dedication, leadership and innovation continue to shape nuclear medicine.',
      ctaLabel: 'Nominate a Colleague',
      bgImageUrl: HERO_IMG_OPEN,
    },
    sections: [
      {
        type: 'text',
        html:
          P('The British Nuclear Medicine Society is proud to recognise the individuals and teams whose commitment, innovation and leadership have helped advance nuclear medicine across the UK and beyond.') +
          P('Our awards celebrate excellence in clinical practice, scientific achievement, education, research, teamwork and professional service. They recognise the people who inspire colleagues, improve patient care, drive innovation and strengthen the future of our profession.') +
          P('Whether you\u2019re looking to nominate a colleague, discover our awards or explore the inspiring stories behind them, you\u2019ll find everything you need here.'),
        cta: 'Nominate a Colleague',
        h: 400,
      },
      {
        type: 'text',
        heading: 'Society Awards',
        html: P('The Society Awards recognise exceptional individuals and teams whose achievements have had a lasting impact on nuclear medicine and the British Nuclear Medicine Society.'),
        h: 140,
      },
      {
        type: 'text',
        heading: 'President\u2019s Medal & President\u2019s Prize',
        html:
          P('The President\u2019s Medal and President\u2019s Prize are among the Society\u2019s highest honours.') +
          P('Presented annually during the BNMS Annual Spring Meeting, these awards recognise individuals who have made an exceptional contribution to nuclear medicine or provided outstanding service to the British Nuclear Medicine Society.') +
          P('Recipients represent the very best of our profession and reflect the leadership, dedication and commitment that continue to strengthen nuclear medicine.'),
        cta: 'Learn More',
        h: 340,
      },
      {
        type: 'text',
        heading: 'Norman Veall Medal',
        html:
          P('Established in memory of Dr Norman Veall, one of the pioneers of British nuclear medicine, the Norman Veall Medal recognises clinical scientists whose work has made an outstanding contribution to the science and practice of nuclear medicine in the United Kingdom.') +
          P('One of the Society\u2019s most prestigious scientific honours, the Medal celebrates excellence, innovation and lasting professional achievement.'),
        cta: 'Learn More',
        h: 300,
      },
      {
        type: 'text',
        heading: 'Radiographers, Technologists & Nurses Award',
        html:
          P('The Radiographers, Technologists & Nurses Award recognises radiographers, technologists and nurses who have made an outstanding contribution to professional practice, innovation, education or patient care within nuclear medicine.') +
          P('Formerly known as the Clinical Practitioner\u2019s Award, this annual honour celebrates the essential contribution these professionals make to delivering outstanding nuclear medicine services.'),
        cta: 'Learn More',
        h: 300,
      },
      {
        type: 'text',
        heading: 'Innovative Team Award',
        html:
          P('The BNMS Innovative Team Award celebrates multidisciplinary teams that are transforming nuclear medicine through creativity, collaboration and service improvement.') +
          P('Recognising projects that enhance patient care, improve efficiency, strengthen education or introduce innovative ways of working, the award showcases ideas that can inspire departments across the UK.') +
          P('Finalists present their projects during the BNMS Annual Spring Meeting, where their work is shared with the wider nuclear medicine community.'),
        cta: 'Learn More',
        h: 360,
      },
      {
        type: 'feature',
        heading: 'Celebrating Our Community',
        html:
          P('<strong>Recognising the People Behind BNMS</strong>') +
          P('Recognition extends beyond formal awards.') +
          P('Throughout the year, BNMS celebrates the achievements, careers and milestones of members across the nuclear medicine community.') +
          P('From retirements and national honours to professional achievements and career milestones, we welcome nominations that help recognise the people who make our community exceptional.') +
          P('We also honour and remember colleagues whose dedication and contribution have shaped the profession through our In Memoriam pages.'),
        buttons: ['Celebrate a Colleague', 'In Memoriam'],
        h: 480,
      },
      {
        type: 'feature',
        heading: 'Research & Presentation Awards',
        html:
          P('<strong>Recognising Excellence in Research</strong>') +
          P('Research and scientific presentation are central to advancing nuclear medicine.') +
          P('Each year, the BNMS Annual Spring Meeting recognises outstanding oral and poster presentations across every discipline, celebrating innovation, scientific excellence and the next generation of researchers.') +
          P('From students and trainees to experienced clinicians, scientists and healthcare professionals, the Research & Presentation Awards recognise the highest standards of research and presentation across the specialty.') +
          P('Explore the full range of awards, prize categories, eligibility criteria and abstract submission guidance.'),
        cta: 'Explore Research & Presentation Awards',
        h: 500,
      },
    ],
    closingHero: {
      headline: 'Help Us Recognise Excellence',
      subheadline: 'Every achievement helps strengthen our profession and inspire future generations. If you know an individual or team whose contribution deserves recognition, we\u2019d love to hear from you.',
      ctaLabel: 'Nominate a Colleague',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const APPRENTICESHIPS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'apprenticeships-in-nuclear-medicine',
  title: 'Apprenticeships in Nuclear Medicine',
  design: buildDesign({
    hero: {
      headline: 'Apprenticeships in Nuclear Medicine',
      subheadline: 'Earn while you learn through a recognised pathway into one of healthcare\u2019s most innovative specialties.',
      ctaLabel: 'Pathway into Nuclear Medicine Technology',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-graduation-cap',
      strapline: 'A Practical Route into Nuclear Medicine',
      html:
        P('Apprenticeships offer a practical route into nuclear medicine, allowing you to earn a salary while gaining a recognised qualification and valuable workplace experience.') +
        P('They combine academic study with hands-on training in a nuclear medicine department, supporting you to develop the skills and knowledge needed for a rewarding healthcare career.') +
        P('Apprenticeships are an excellent option for school leavers, career changers and anyone looking for a practical way into the profession.'),
      h: 380,
    },
    sections: [
      {
        type: 'cards',
        heading: 'Why Choose an Apprenticeship?',
        columns: 3,
        cardH: 300,
        cards: [
          { icon: 'fa-solid fa-sterling-sign', heading: 'Earn While You Learn', body: P('Receive a salary while studying towards a recognised degree qualification and gaining valuable workplace experience.') },
          { icon: 'fa-solid fa-user-graduate', heading: 'Learn in Practice', body: P('Develop your skills by working alongside experienced healthcare professionals in a real nuclear medicine department.') },
          { icon: 'fa-solid fa-arrow-trend-up', heading: 'Build Your Future', body: P('Graduate with practical experience, professional knowledge and the confidence to begin a rewarding career in nuclear medicine.') },
        ],
      },
      {
        type: 'columns',
        heading: 'How Does It Work?',
        columns: [
          {
            h3: 'The Apprenticeship Programme',
            html:
              P('Healthcare Science Practitioner apprenticeships typically:') +
              `<ul>${LI('Take a minimum of 36 months.')}${LI('Lead to a Level 6 BSc (Honours) qualification.')}${LI('Combine university study with workplace learning.')}${LI('Include supervised clinical training.')}${LI('Support eligibility for professional registration.')}</ul>` +
              P('Apprentices usually spend around 80% of their time in the workplace, with the remaining time dedicated to academic study.'),
            h: 440,
          },
          {
            h3: 'Professional Registration',
            html:
              P('Following successful completion, graduates may become eligible to apply for professional registration, including:') +
              `<ul>${LI('Register of Clinical Technologists (RCT)')}${LI('Academy for Healthcare Science (AHCS) Practitioner Register')}</ul>` +
              P('Professional registration demonstrates competence and supports ongoing professional development throughout your career.'),
            h: 360,
          },
        ],
      },
      {
        type: 'cards',
        heading: 'Benefits of Apprenticeships',
        columns: 4,
        cardH: 360,
        cards: [
          { icon: 'fa-solid fa-user', heading: 'For Students', body: `<ul>${LI('Earn a salary.')}${LI('Gain practical experience.')}${LI('Study towards a recognised qualification.')}${LI('Build professional confidence.')}</ul>` },
          { icon: 'fa-solid fa-hospital', heading: 'For Employers', body: `<ul>${LI('Develop the future workforce.')}${LI('Address recruitment challenges.')}${LI('Invest in local talent.')}${LI('Make use of apprenticeship funding.')}</ul>` },
          { icon: 'fa-solid fa-coins', heading: 'Funding', body: P('The Apprenticeship Levy helps employers fund apprenticeship training and tuition costs, supporting workforce development across healthcare.') },
          { icon: 'fa-solid fa-briefcase', heading: 'Career Opportunities', body: P('Successful apprentices can progress into permanent Clinical Technologist roles, specialist practice, advanced practitioner positions and leadership opportunities.') },
        ],
      },
      {
        type: 'text',
        heading: 'Finding an Apprenticeship',
        html:
          P('Apprenticeship vacancies are advertised by individual NHS trusts and healthcare providers, usually when they have a training place available.') +
          P('Opportunities can vary from year to year and location to location, so it is worth checking regularly.') +
          P('You can find apprenticeship vacancies through NHS Jobs, the government\u2019s Find an Apprenticeship service and the websites of individual healthcare providers.') +
          P('It can also help to contact your local nuclear medicine department directly to ask about future opportunities.'),
        h: 420,
      },
      {
        type: 'cards',
        heading: 'Useful Resources',
        columns: 3,
        cardH: 280,
        cards: [
          { icon: 'fa-solid fa-school', heading: 'National School of Healthcare Science', body: P('Information about Healthcare Science careers, education and apprenticeship pathways.') },
          { icon: 'fa-solid fa-coins', heading: 'Apprenticeship Funding', body: P('Guidance for employers on apprenticeship funding and workforce development.') },
          { icon: 'fa-solid fa-signs-post', heading: 'Career Pathways', body: P('Learn more about becoming a Nuclear Medicine Technologist and the different routes into the profession.') },
        ],
      },
    ],
    closingHero: {
      headline: 'Start Your Career in Nuclear Medicine',
      subheadline: 'Whether you are leaving school, changing career or looking for a practical route into healthcare, an apprenticeship could be the perfect way to begin your journey.',
      ctaLabel: 'Pathway into Nuclear Medicine Technology',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const ANNUAL_ACHIEVEMENTS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'annual-achievements',
  title: 'Annual Achievements',
  design: buildDesign({
    hero: {
      headline: 'Annual Achievements',
      subheadline: 'Celebrating the impact, progress and achievements of the British Nuclear Medicine Society each year.',
      ctaLabel: 'Become a Member',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-chart-line',
      strapline: 'Celebrating Our Progress',
      html:
        P('Each year, the British Nuclear Medicine Society achieves a great deal on behalf of its members and the wider nuclear medicine community.') +
        P('This page brings together our annual achievements, highlighting the impact, progress and milestones delivered year on year.'),
      h: 280,
    },
    sections: [
      {
        type: 'placeholder',
        heading: 'Annual Achievements',
        note: NOTE('The BNMS Annual Achievements, organised by year (2026, 2025, 2024 and earlier), will be displayed here through the searchable resource directory.'),
        h: 150,
      },
      {
        type: 'feature',
        heading: 'Making a Difference Together',
        html:
          P('Everything BNMS achieves is made possible by the commitment of its members, volunteers and staff.') +
          P('Together, we continue to support education, research and professional excellence across nuclear medicine.'),
        h: 260,
      },
    ],
    closingHero: {
      headline: 'Be Part of BNMS',
      subheadline: 'Join the UK\u2019s professional society for nuclear medicine and help strengthen our community.',
      ctaLabel: 'Become a Member',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

// ===========================================================================
// UKRG pages (theme: 'ukrg'). Red accent / light-red band / blue hero gradient
// matching the existing hand-built /about-ukrg page. Every slug contains
// "ukrg". All links/buttons are href:"#" placeholders.
// ===========================================================================

const UKRG_HOME = {
  tenantId: BNMS_TENANT_ID,
  slug: 'ukrg',
  title: 'UK Radiopharmacy Group',
  design: buildDesign({
    theme: 'ukrg',
    hero: {
      headline: 'UK Radiopharmacy Group',
      subheadline:
        'Supporting radiopharmacy professionals through guidance, education, quality improvement and collaboration.',
      ctaLabel: 'Explore Professional Resources',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-atom',
      strapline: 'Welcome to the UK Radiopharmacy Group',
      html:
        P('The UK Radiopharmacy Group (UKRG) brings together professionals working in the preparation, quality control and clinical use of radiopharmaceuticals across the United Kingdom.') +
        P('We support safe, effective and high-quality radiopharmacy practice through professional guidance, education, quality improvement and a strong, collaborative community.'),
      h: 240,
    },
    sections: [
      {
        type: 'cards',
        heading: 'What We Do',
        columns: 4,
        cardH: 320,
        cards: [
          { icon: 'fa-solid fa-clipboard-list', heading: 'Professional Guidance', body: P('Practical guidance notes and reference documents supporting day-to-day radiopharmacy practice.') },
          { icon: 'fa-solid fa-graduation-cap', heading: 'Education & Development', body: P('Learning opportunities, events and postgraduate education for radiopharmacy professionals.') },
          { icon: 'fa-solid fa-shield-halved', heading: 'Quality & Safety', body: P('Tools and resources for audit, quality assurance and safe, effective practice.') },
          { icon: 'fa-solid fa-people-group', heading: 'Collaboration & Leadership', body: P('A national community working together to advance the radiopharmacy profession.') },
        ],
      },
      {
        type: 'cards',
        heading: 'Explore UKRG',
        columns: 3,
        cardH: 340,
        cards: [
          { icon: 'fa-solid fa-folder-open', heading: 'Professional Resources', body: P('Guidance notes, reference documents and quality assurance resources.'), cta: 'Professional Resources' },
          { icon: 'fa-solid fa-triangle-exclamation', heading: 'Safety & Quality', body: P('Reporting, audit and quality improvement across radiopharmacy.'), cta: 'Safety & Quality' },
          { icon: 'fa-solid fa-calendar-days', heading: 'Education & Events', body: P('Learning, events and professional development opportunities.'), cta: 'Education & Events' },
          { icon: 'fa-solid fa-circle-info', heading: 'About UKRG', body: P('Who we are, our history and how we support the profession.'), cta: 'About UKRG' },
          { icon: 'fa-solid fa-users', heading: 'Committee', body: P('Meet the volunteers leading the work of the UKRG.'), cta: 'Meet the Committee' },
          { icon: 'fa-solid fa-newspaper', heading: 'Latest News', body: P('News, announcements and updates from the UKRG.'), cta: 'Latest News' },
        ],
      },
      {
        type: 'feature',
        heading: 'Supporting the Radiopharmacy Community',
        html:
          P('Whether you work in a hospital radiopharmacy, a manufacturing unit or a research setting, the UKRG is here to support your practice.') +
          P('Our members share a commitment to patient safety, professional excellence and the continued development of radiopharmacy across the UK.'),
        h: 240,
      },
      {
        type: 'feature',
        heading: 'Quick Access',
        html: P('Frequently used resources and reporting tools, all in one place.'),
        h: 120,
        buttons: [
          'Report an Adverse Event',
          'Report a Product Defect',
          'Report a Practice Error',
          'Download the Radiopharmacy Audit',
          'View UKRG Guidance Notes',
          'Access QAAPS Resources',
        ],
      },
    ],
    closingHero: {
      headline: 'Join the UKRG Community',
      subheadline:
        'Connect with radiopharmacy professionals across the UK and help advance safe, high-quality practice.',
      ctaLabel: 'Explore Professional Resources',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const UKRG_ABOUT = {
  tenantId: BNMS_TENANT_ID,
  slug: 'about-ukrg',
  title: 'About UKRG',
  design: buildDesign({
    theme: 'ukrg',
    hero: {
      headline: 'About the UK Radiopharmacy Group',
      subheadline:
        'Supporting professional excellence in radiopharmacy through collaboration, guidance and leadership since 1977.',
      ctaLabel: 'Download Terms of Reference',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-atom',
      strapline: 'Who We Are',
      html:
        P('The UK Radiopharmacy Group (UKRG) is the national professional group representing those involved in the preparation, quality control and clinical use of radiopharmaceuticals.') +
        P('Our members include radiopharmacists, radiochemists, technologists, scientists and other professionals working across hospital, manufacturing and research settings.') +
        P('We work closely with the British Nuclear Medicine Society (BNMS) and other professional bodies to support and advance radiopharmacy across the UK.'),
      h: 300,
    },
    sections: [
      {
        type: 'text',
        heading: 'Our Purpose',
        bullets: true,
        html:
          P('UKRG exists to support the radiopharmacy profession by:') +
          `<ul>${LI('Providing practical guidance and reference resources for safe, effective practice.')}${LI('Supporting education, training and continuing professional development.')}${LI('Promoting quality improvement, audit and patient safety.')}${LI('Representing the profession and fostering collaboration across the UK.')}</ul>` +
          P('Together, our members help ensure that radiopharmacy continues to deliver safe, high-quality care for patients.'),
        h: 380,
      },
      {
        type: 'text',
        heading: 'Our History',
        html:
          P('The UK Radiopharmacy Group was established to bring together the growing community of professionals working with radiopharmaceuticals across the United Kingdom.') +
          P('From its early beginnings, the Group has provided a forum for sharing knowledge, developing guidance and supporting best practice.') +
          P('Over the decades, radiopharmacy has evolved significantly, and the UKRG has continued to adapt to new technologies, regulations and clinical demands.') +
          P('Today, the Group remains a trusted voice for the profession and a source of practical support for radiopharmacy professionals nationwide.'),
        h: 380,
      },
      {
        type: 'text',
        heading: 'Our Journey',
        html:
          P('1976 \u2014 Growing interest in radiopharmacy brings professionals together to share knowledge and practice.') +
          P('1977 \u2014 The UK Radiopharmacy Group is formally established.') +
          P('1977\u20131994 \u2014 The Group develops guidance, supports education and grows its national membership.') +
          P('1995 \u2014 Closer collaboration with the wider nuclear medicine community strengthens the profession.') +
          P('Today \u2014 UKRG continues to support safe, high-quality radiopharmacy practice across the UK.'),
        h: 320,
      },
      {
        type: 'feature',
        heading: 'Working with BNMS',
        html:
          P('The UKRG works in close partnership with the British Nuclear Medicine Society (BNMS), sharing a commitment to professional excellence and patient care.') +
          P('This collaboration ensures that radiopharmacy is well represented within the wider nuclear medicine community and that members benefit from shared events, education and resources.'),
        h: 240,
      },
      {
        type: 'feature',
        heading: 'Governance',
        html:
          P('The UKRG is led by a committee of volunteers who guide its work, supported by its Terms of Reference.') +
          P('Our governance arrangements ensure that the Group operates transparently and in the best interests of the profession and the patients it serves.'),
        h: 220,
        cta: 'Download Terms of Reference',
      },
    ],
    closingHero: {
      headline: 'Supporting the Future of Radiopharmacy',
      subheadline:
        'As the profession continues to evolve, the UKRG remains committed to supporting its members and advancing safe, high-quality practice.',
      ctaLabel: 'Meet the Committee',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const UKRG_ABOUT_NEW = {
  tenantId: BNMS_TENANT_ID,
  slug: 'about-ukrg-new',
  title: 'About UKRG (New)',
  design: buildDesign({
    theme: 'ukrg',
    hero: {
      headline: 'UK Radiopharmacy Group (UKRG)',
      subheadline:
        'Supporting excellence in radiopharmacy through collaboration, guidance, education and professional leadership across the United Kingdom.',
      ctaLabel: 'Download Terms of Reference',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-atom',
      strapline: 'Who We Are',
      html:
        P('The UK Radiopharmacy Group (UKRG) is the national professional group representing those involved in the preparation, quality assurance and clinical use of radiopharmaceuticals.') +
        P('Our community includes radiopharmacists, radiochemists, scientists, technologists and other professionals working across NHS hospitals, manufacturing, academia and research.') +
        P('Working closely with the British Nuclear Medicine Society (BNMS) and partner organisations, UKRG provides a national forum for collaboration, professional guidance, education and the sharing of best practice.') +
        P('Whether you are an established professional or new to the specialty, UKRG is here to support the radiopharmacy community and help advance safe, high-quality patient care across the UK.'),
      h: 420,
    },
    sections: [
      {
        type: 'text',
        heading: 'What We Do',
        html: P('Our work is focused on supporting both the profession and the patients who benefit from radiopharmaceutical services.'),
        h: 120,
      },
      {
        type: 'cards',
        columns: 3,
        cardH: 340,
        cards: [
          { icon: 'fa-solid fa-book-open', heading: 'Professional Guidance', body: P('Developing guidance, standards and practical reference resources that support safe and effective radiopharmacy practice.') },
          { icon: 'fa-solid fa-graduation-cap', heading: 'Education & Training', body: P('Supporting education, training and continuing professional development for radiopharmacy professionals.') },
          { icon: 'fa-solid fa-handshake', heading: 'Collaboration', body: P('Bringing together professionals from across the UK to share knowledge, experience and best practice.') },
          { icon: 'fa-solid fa-shield-halved', heading: 'Quality & Safety', body: P('Promoting quality improvement, governance and patient safety throughout radiopharmacy services.') },
          { icon: 'fa-solid fa-flask', heading: 'Innovation', body: P('Supporting research, innovation and the future development of radiopharmaceutical practice.') },
          { icon: 'fa-solid fa-earth-europe', heading: 'Professional Representation', body: P('Representing radiopharmacy within the wider nuclear medicine community and supporting the profession nationally.') },
        ],
      },
      {
        type: 'feature',
        heading: 'Working Together',
        html:
          P('UKRG works in close partnership with the British Nuclear Medicine Society (BNMS), professional organisations and colleagues across healthcare, academia and industry.') +
          P('By sharing expertise and working collaboratively, we help strengthen radiopharmacy services, support innovation and contribute to the continued advancement of nuclear medicine throughout the United Kingdom.'),
        h: 240,
      },
      {
        type: 'text',
        heading: 'Our History',
        html:
          P('Established in 1977, the UK Radiopharmacy Group has supported generations of professionals working in radiopharmacy.') +
          P('As the profession has evolved, UKRG has continued to provide leadership, develop practical guidance and create opportunities for collaboration and professional development.') +
          P('Today, the Group remains a trusted voice for radiopharmacy and continues to support safe, effective and high-quality practice across the UK.'),
        h: 320,
      },
      {
        type: 'text',
        heading: 'Our Journey',
        html:
          P('1977 \u2014 The UK Radiopharmacy Group is established.') +
          P('1980s\u20131990s \u2014 Development of national guidance, education and professional collaboration.') +
          P('2000s \u2014 Closer partnership with BNMS and the wider nuclear medicine community.') +
          P('Today \u2014 Supporting professionals through guidance, education, collaboration and leadership.'),
        h: 300,
      },
      {
        type: 'feature',
        heading: 'Governance',
        html:
          P('The UKRG is led by a committee of volunteer professionals who help shape the direction of the Group and oversee its activities.') +
          P('The committee works on behalf of the profession to ensure UKRG continues to support its members, promote best practice and contribute to the future of radiopharmacy.'),
        h: 220,
        cta: 'Meet the Committee',
      },
      {
        type: 'cards',
        heading: 'Explore UKRG',
        columns: 3,
        cardH: 400,
        cards: [
          { icon: 'fa-solid fa-book', heading: 'Professional Resources', body: P('Access guidance documents, standards, reports and practical resources that support safe and effective radiopharmacy practice.'), cta: 'View Resources' },
          { icon: 'fa-solid fa-graduation-cap', heading: 'Education & Events', body: P('Discover educational opportunities, meetings and events designed to support learning, professional development and collaboration.'), cta: 'Explore Education & Events' },
          { icon: 'fa-solid fa-envelope', heading: 'Contact the Group', body: P('Whether you have a question, would like to become involved or simply want to find out more about the UK Radiopharmacy Group, we\u2019d be delighted to hear from you.'), cta: 'Contact UKRG' },
        ],
      },
    ],
    closingHero: {
      headline: 'Supporting the Future of Radiopharmacy',
      subheadline:
        'Radiopharmacy continues to evolve through scientific innovation, new technologies and advances in patient care. The UK Radiopharmacy Group remains committed to supporting professionals, sharing expertise and promoting best practice, helping to ensure patients across the United Kingdom continue to benefit from safe, effective and high-quality radiopharmaceutical services.',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const UKRG_COMMITTEE = {
  tenantId: BNMS_TENANT_ID,
  slug: 'ukrg-committee',
  title: 'UKRG Committee',
  design: buildDesign({
    theme: 'ukrg',
    hero: {
      headline: 'UKRG Committee',
      subheadline: 'Meet the volunteers leading the work of the UK Radiopharmacy Group.',
      ctaLabel: 'Contact the Committee',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-users',
      strapline: 'Supporting the Radiopharmacy Community',
      html:
        P('The UK Radiopharmacy Group Committee is made up of experienced volunteers from across the United Kingdom who are passionate about supporting the radiopharmacy profession.') +
        P('Representing hospitals, universities, research organisations and specialist centres, Committee members work together to provide professional leadership, develop guidance, support education and promote collaboration throughout the radiopharmacy community.') +
        P('Working closely with the British Nuclear Medicine Society, the Committee helps ensure that UKRG continues to support safe practice, professional development and the advancement of radiopharmacy across the UK.'),
      h: 340,
    },
    sections: [
      {
        type: 'text',
        heading: 'What the Committee Does',
        bullets: true,
        html:
          P('The Committee oversees the work of UKRG and supports the profession by:') +
          `<ul>${LI('Developing professional guidance and standards.')}${LI('Supporting education and continuing professional development.')}${LI('Organising workshops and contributing to BNMS scientific meetings.')}${LI('Promoting quality assurance, audit and patient safety.')}${LI('Reviewing and supporting safety reporting initiatives.')}${LI('Working collaboratively with BNMS and external organisations.')}${LI('Representing the interests of the UK radiopharmacy community.')}</ul>` +
          P('Together, these activities help ensure that UKRG continues to meet the needs of professionals working across radiopharmacy.'),
        h: 560,
      },
      {
        type: 'text',
        heading: 'Meet the Committee',
        html: `<ul>${[
          'Busola Ade-Ojo \u2013 Cambridge University Hospitals NHS Foundation Trust',
          'Dr Ramla Awais \u2013 UCL GMP Facility',
          'Andrew Brown \u2013 Belfast Health and Social Care Trust',
          'Colette Burns \u2013 Ninewells Hospital',
          'Jose Calero \u2013 The Christie NHS Foundation Trust',
          'Pei San Chan \u2013 Royal Free Hospital',
          'Dr Maggie Cooper (Secretary) \u2013 King\u2019s College London',
          'Mark Cox \u2013 Oxford University Hospitals NHS Foundation Trust',
          'Jilly Croasdale \u2013 Queen Elizabeth Hospital',
          'Dr Beverley Ellis \u2013 Manchester University NHS Foundation Trust',
          'Louise Fraser \u2013 UK Health Security Agency',
          'David Graham \u2013 Aberdeen Royal Infirmary',
          'Prof Neil Hartman \u2013 Singleton Hospital',
          'Phil Hillel \u2013 Royal Hallamshire Hospital',
          'Catherine Oxley \u2013 South Tyneside District Hospital',
          'Dariusz Osowski \u2013 Liverpool University Hospitals NHS Foundation Trust',
          'Kay Pollock \u2013 NHS Greater Glasgow and Clyde',
          'Nadia Rolf \u2013 SPS Quality Assurance',
          'Wendy Sanders \u2013 University Hospitals Leicester NHS Trust',
          'Polly Savage \u2013 Bristol Royal Infirmary',
          'Joseline Tan \u2013 Royal Marsden Hospital',
          'Ronan Tegala \u2013 Guy\u2019s &amp; St Thomas\u2019 NHS Foundation Trust',
          'Clint Waight (Chair) \u2013 The Royal Infirmary of Edinburgh',
          'Graham Willmers \u2013 SPS Quality Assurance',
          'Helen Wilson (Treasurer) \u2013 St James\u2019s University Hospital',
          'Clint Zvavamwe \u2013 University Hospital Southampton NHS Foundation Trust',
        ]
          .map(LI)
          .join('')}</ul>`,
        h: 1700,
        bullets: true,
      },
      {
        type: 'feature',
        heading: 'Working Groups',
        html:
          P('From time to time, UKRG establishes working groups to support specific projects, guidance development, education and professional initiatives.') +
          P('These groups bring together volunteers with specialist knowledge and provide opportunities for members to contribute to the future development of radiopharmacy practice.'),
        h: 240,
      },
      {
        type: 'feature',
        heading: 'Get Involved',
        html:
          P('UKRG is a community led by volunteers.') +
          P('Whether you would like to contribute to a working group, support the development of professional guidance or stand for election to the Committee in the future, there are many ways to become involved.') +
          P('Opportunities to volunteer, join working groups and apply for Committee positions will be promoted through BNMS communications and the UKRG website.'),
        h: 320,
        cta: 'Find Out How to Get Involved',
      },
      {
        type: 'feature',
        heading: 'Working with BNMS',
        html:
          P('The UKRG Committee works in partnership with the British Nuclear Medicine Society to support the wider nuclear medicine community.') +
          P('Through collaboration, education and professional leadership, the Committee helps ensure that radiopharmacy remains an integral part of multidisciplinary nuclear medicine practice while supporting innovation, research and the highest standards of patient care.'),
        h: 260,
      },
      {
        type: 'text',
        heading: 'Contact the Committee',
        html:
          P('Have a question, suggestion or enquiry?') +
          P('The Committee welcomes feedback from members of the radiopharmacy community and encourages professionals to get in touch with ideas, comments or questions about the work of UKRG.'),
        h: 220,
        cta: 'Contact the Committee',
      },
    ],
  }),
};

const UKRG_EDUCATION = {
  tenantId: BNMS_TENANT_ID,
  slug: 'ukrg-education-and-events',
  title: 'UKRG Education & Events',
  design: buildDesign({
    theme: 'ukrg',
    hero: {
      headline: 'Education & Events',
      subheadline:
        'Supporting lifelong learning, professional development and collaboration across the radiopharmacy community.',
      ctaLabel: 'View Upcoming Events',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-graduation-cap',
      strapline: 'Learning Together',
      html:
        P('Education and professional development are at the heart of the UKRG. We support radiopharmacy professionals at every stage of their career.') +
        P('From postgraduate education to conferences, study days and informal learning, there are many opportunities to develop your knowledge and skills.'),
      h: 220,
    },
    sections: [
      {
        type: 'text',
        heading: 'Education & Professional Development',
        bullets: true,
        html:
          P('Continuing professional development in radiopharmacy spans a wide range of areas, including:') +
          `<ul>${LI('Radiopharmaceutical preparation and quality control.')}${LI('Good manufacturing and good radiopharmacy practice.')}${LI('Radiation protection and safety.')}${LI('Aseptic technique and clean room practice.')}${LI('Quality assurance and audit.')}${LI('Regulatory and governance requirements.')}${LI('New tracers, technologies and clinical applications.')}${LI('Leadership, training and professional skills.')}</ul>`,
        h: 400,
      },
      {
        type: 'cards',
        heading: 'Postgraduate Education',
        columns: 2,
        cardH: 360,
        cards: [
          {
            icon: 'fa-solid fa-university',
            heading: "King's College London",
            body: P("A well-established postgraduate programme in radiopharmaceutics and radiopharmacy, supporting professionals seeking advanced qualifications and specialist knowledge."),
            cta: 'Visit Course Website',
          },
          {
            icon: 'fa-solid fa-flask-vial',
            heading: 'European Postgraduate Certificate',
            body: P('A collaborative European postgraduate certificate in radiopharmaceutical chemistry and radiopharmacy, delivered with partner institutions across Europe.'),
            cta: 'Learn More',
          },
        ],
      },
      {
        type: 'feature',
        heading: 'UKRG & BNMS Events',
        html:
          P('The UKRG and BNMS run a programme of conferences, study days and educational events throughout the year.') +
          P('These events provide valuable opportunities to learn, share best practice and connect with colleagues from across the profession.'),
        h: 220,
      },
      {
        type: 'cards',
        heading: 'Featured Events',
        columns: 3,
        cardH: 300,
        cards: [
          { icon: 'fa-solid fa-calendar-day', heading: 'BNMS Annual Spring Meeting', body: P('The flagship nuclear medicine conference, featuring radiopharmacy sessions and workshops.') },
          { icon: 'fa-solid fa-chalkboard-user', heading: 'Radiopharmacy Study Day', body: P('A focused day of learning on current topics in radiopharmacy practice.') },
          { icon: 'fa-solid fa-microscope', heading: 'Quality Assurance Workshop', body: P('Practical sessions on audit, quality control and continuous improvement.') },
          { icon: 'fa-solid fa-people-arrows', heading: 'Regional Meetings', body: P('Local opportunities to network and share practice with nearby colleagues.') },
          { icon: 'fa-solid fa-laptop', heading: 'Online Webinars', body: P('Accessible online learning on emerging topics and technologies.') },
          { icon: 'fa-solid fa-user-graduate', heading: 'Trainee Events', body: P('Dedicated sessions supporting those new to radiopharmacy.') },
        ],
      },
      {
        type: 'feature',
        html: P('Browse the full BNMS and UKRG events calendar for upcoming dates and details.'),
        h: 110,
        cta: 'View All Events',
      },
      {
        type: 'feature',
        heading: 'Supporting Future Professionals',
        html:
          P('The UKRG is committed to supporting the next generation of radiopharmacy professionals through education, mentorship and training opportunities.') +
          P('We encourage trainees and students to get involved, attend events and make the most of the resources available.'),
        h: 240,
      },
      {
        type: 'feature',
        heading: 'Continue Your Professional Journey',
        html: P('Explore more resources to support your development and practice.'),
        h: 120,
        buttons: ['Professional Resources', 'Safety & Quality'],
      },
    ],
    closingHero: {
      headline: 'Never Stop Learning',
      subheadline:
        'Discover events, education and development opportunities to advance your career in radiopharmacy.',
      ctaLabel: 'View Upcoming Events',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const UKRG_NEWS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'ukrg-news',
  title: 'UKRG News',
  design: buildDesign({
    theme: 'ukrg',
    hero: {
      headline: 'Latest News',
      subheadline: 'The latest news, announcements and updates from the UK Radiopharmacy Group.',
      ctaLabel: 'Explore Resources',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-newspaper',
      strapline: 'Stay Up to Date',
      html:
        P('Keep up with the latest developments from the UKRG, including guidance updates, event announcements and news from across the radiopharmacy community.') +
        P('Our newsletters and updates are published regularly to keep members informed.'),
      h: 220,
    },
    sections: [
      {
        type: 'feature',
        heading: 'Latest News',
        html:
          P('The latest UKRG news and newsletters are published in our resource library.') +
          P('Browse the archive to catch up on recent announcements, updates and community news.'),
        h: 220,
        cta: 'Browse UKRG Newsletters',
      },
      {
        type: 'feature',
        heading: 'Looking for Professional Resources?',
        html:
          P('Alongside our news updates, the UKRG provides a range of professional resources, guidance notes and quality assurance tools to support your practice.'),
        h: 200,
        cta: 'Professional Resources',
      },
    ],
    closingHero: {
      headline: 'Stay Connected with UKRG',
      subheadline:
        'Explore our resources and stay informed about the latest developments in radiopharmacy.',
      ctaLabel: 'Professional Resources',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const UKRG_RESOURCES = {
  tenantId: BNMS_TENANT_ID,
  slug: 'ukrg-professional-resources',
  title: 'UKRG Professional Resources',
  design: buildDesign({
    theme: 'ukrg',
    hero: {
      headline: 'Professional Resources',
      subheadline:
        'Access guidance, reference documents and practical resources supporting safe and effective radiopharmacy practice.',
      ctaLabel: 'Browse UKRG Guidance Notes',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-folder-open',
      strapline: 'Supporting Professional Practice',
      html:
        P('The UKRG provides a range of professional resources to support radiopharmacy practice across the UK.') +
        P('From guidance notes to reference libraries and quality assurance tools, these resources are designed to support safe, effective and high-quality practice.'),
      h: 220,
    },
    sections: [
      {
        type: 'text',
        heading: 'UKRG Guidance Notes',
        bullets: true,
        html:
          P('Our guidance notes cover key aspects of radiopharmacy practice, including:') +
          `<ul>${LI('Radiopharmaceutical preparation and dispensing.')}${LI('Quality control and quality assurance.')}${LI('Aseptic technique and clean room practice.')}${LI('Radiation protection and safety.')}${LI('Governance and regulatory compliance.')}</ul>`,
        h: 340,
        cta: 'Browse UKRG Guidance Notes',
      },
      {
        type: 'text',
        heading: 'Professional Reference Library',
        bullets: true,
        html:
          P('Our reference library brings together useful documents and materials to support your practice, including:') +
          `<ul>${LI('Standards and best practice documents.')}${LI('Templates and practical tools.')}${LI('Position statements and professional advice.')}</ul>` +
          P('The library is regularly reviewed and updated to reflect current practice.'),
        h: 340,
      },
      {
        type: 'feature',
        heading: 'Quality Assurance Resources',
        html:
          P('The UKRG supports quality assurance through the Quality Assurance of Aseptic Preparation Services (QAAPS) framework and related tools.') +
          P('These resources help radiopharmacy units maintain and demonstrate high standards of quality and safety.'),
        h: 240,
        buttons: ['Learn More About QAAPS', 'Download QAAPS5 Audit Record Sheet'],
      },
      {
        type: 'accordion',
        heading: 'Useful Links',
        h: 420,
        items: [
          { q: 'Professional Organisations', a: `<ul>${LI('British Nuclear Medicine Society (BNMS)')}${LI('Royal Pharmaceutical Society (RPS)')}${LI('Institute of Physics and Engineering in Medicine (IPEM)')}</ul>` },
          { q: 'Regulatory Organisations', a: `<ul>${LI('Medicines and Healthcare products Regulatory Agency (MHRA)')}${LI('Care Quality Commission (CQC)')}${LI('Environment Agency')}</ul>` },
          { q: 'Professional Regulation', a: `<ul>${LI('General Pharmaceutical Council (GPhC)')}${LI('Health and Care Professions Council (HCPC)')}</ul>` },
          { q: 'Education & Training', a: `<ul>${LI("King's College London")}${LI('European postgraduate education programmes')}</ul>` },
          { q: 'International Organisations', a: `<ul>${LI('European Association of Nuclear Medicine (EANM)')}${LI('International Atomic Energy Agency (IAEA)')}</ul>` },
          { q: 'Quality Assurance', a: `<ul>${LI('NHS Pharmaceutical Quality Assurance Committee')}${LI('QAAPS resources and audit tools')}</ul>` },
        ],
      },
      {
        type: 'feature',
        heading: 'Newsletter Archive',
        html: P('Catch up on past UKRG newsletters, featuring updates, guidance and news from across the profession.'),
        h: 180,
        cta: 'Browse Newsletter Archive',
      },
      {
        type: 'feature',
        heading: 'Looking for Something Else?',
        html: P('Explore more of what the UKRG has to offer.'),
        h: 120,
        buttons: ['Safety & Quality', 'Education & Events', 'Contact the Committee'],
      },
    ],
    closingHero: {
      headline: 'Find the Resources You Need',
      subheadline:
        'Explore our guidance notes, reference library and quality assurance tools to support your practice.',
      ctaLabel: 'Browse UKRG Guidance Notes',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const UKRG_SAFETY = {
  tenantId: BNMS_TENANT_ID,
  slug: 'ukrg-safety-and-quality',
  title: 'UKRG Safety & Quality',
  design: buildDesign({
    theme: 'ukrg',
    hero: {
      headline: 'Safety & Quality',
      subheadline:
        'Supporting safe practice, quality improvement and continuous learning across radiopharmacy.',
      ctaLabel: 'Report an Adverse Event',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-shield-halved',
      strapline: 'Promoting Safe Radiopharmacy Practice',
      html:
        P('Patient safety and quality are central to everything the UKRG does. We support radiopharmacy professionals to identify, report and learn from safety issues.') +
        P('By sharing learning across the profession, we help to continuously improve the safety and quality of radiopharmacy practice.'),
      h: 220,
    },
    sections: [
      {
        type: 'cards',
        heading: 'Report an Issue',
        columns: 3,
        cardH: 340,
        cards: [
          { icon: 'fa-solid fa-triangle-exclamation', heading: 'Adverse Event Reporting', body: P('Report adverse events involving radiopharmaceuticals to support learning and patient safety.'), cta: 'Report an Adverse Event' },
          { icon: 'fa-solid fa-box-open', heading: 'Product Defect Reporting', body: P('Report defects with radiopharmaceutical products so they can be investigated and addressed.'), cta: 'Report a Product Defect' },
          { icon: 'fa-solid fa-clipboard-check', heading: 'Error Reporting', body: P('Report practice errors and near misses to help improve systems and prevent recurrence.'), cta: 'Submit an Error Report' },
        ],
      },
      {
        type: 'feature',
        heading: 'Radiopharmacy Audit',
        html:
          P('The UKRG provides a radiopharmacy audit tool to help units assess and demonstrate the quality and safety of their practice.') +
          P('The audit supports self-assessment, benchmarking and continuous improvement.'),
        h: 220,
        buttons: ['Download Word Version', 'Download PDF Version'],
      },
      {
        type: 'feature',
        heading: 'Quality Assurance',
        html:
          P('The Quality Assurance of Aseptic Preparation Services (QAAPS) framework supports high standards of quality in radiopharmacy and aseptic preparation.') +
          P('QAAPS resources help units maintain compliance and drive quality improvement.'),
        h: 220,
        buttons: ['QAAPS Information', 'Download QAAPS5 Audit Record Sheet'],
      },
      {
        type: 'cards',
        heading: 'Why Reporting Matters',
        columns: 4,
        cardH: 280,
        cards: [
          { icon: 'fa-solid fa-flag', heading: 'Report', body: P('Issues, errors and near misses are reported openly and without blame.') },
          { icon: 'fa-solid fa-magnifying-glass', heading: 'Review', body: P('Reports are reviewed to understand what happened and why.') },
          { icon: 'fa-solid fa-lightbulb', heading: 'Learn', body: P('Learning is shared across the profession to build understanding.') },
          { icon: 'fa-solid fa-arrow-trend-up', heading: 'Improve', body: P('Practice and systems are improved to keep patients safe.') },
        ],
      },
      {
        type: 'feature',
        heading: 'Supporting Continuous Improvement',
        html:
          P('A culture of openness, learning and improvement is essential to safe radiopharmacy practice.') +
          P('The UKRG encourages all members to report issues, share learning and contribute to a safer profession for everyone.'),
        h: 240,
      },
      {
        type: 'feature',
        heading: 'Need Professional Guidance?',
        html: P('Explore our guidance notes and reference resources to support safe, high-quality practice.'),
        h: 140,
        cta: 'Professional Resources',
      },
    ],
    closingHero: {
      headline: 'Help Us Improve Patient Safety',
      subheadline:
        'Report. Review. Learn. Improve. Every report helps make radiopharmacy safer for patients across the UK.',
      ctaLabel: 'Report an Adverse Event',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

// ===========================================================================
// MRT pages (theme: 'mrt'). Deep-crimson accent / cream band / orange hero
// gradient matching the existing hand-built /about-mrt page, with the
// consortium logo top-right on the opening hero. Every slug contains "mrt".
// All links/buttons are href:"#" placeholders.
// ===========================================================================

const MRT_HOME = {
  tenantId: BNMS_TENANT_ID,
  slug: 'mrt',
  title: 'UK Molecular Radiotherapy Consortium',
  design: buildDesign({
    theme: 'mrt',
    hero: {
      headline: 'UK Molecular Radiotherapy Consortium',
      subheadline:
        'Bringing together healthcare professionals, researchers and patient advocates to support the development of molecular radiotherapy across the United Kingdom.',
      ctaLabel: 'Professional Resources',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-atom',
      strapline: 'Welcome to the UK Molecular Radiotherapy Consortium',
      html:
        P('I am delighted to welcome you to the UK Molecular Radiotherapy (MRT) Consortium.') +
        P('We are a collaborative group of healthcare professionals, researchers and patient advocates who are passionate about improving molecular radiotherapy services throughout the United Kingdom.') +
        P('Our primary focus is to support both current and future patients who may benefit from molecular radiotherapy by encouraging collaboration, developing national guidance, supporting education and research, and helping to ensure equitable access to these innovative treatments.') +
        P('Working alongside the British Nuclear Medicine Society (BNMS), the Royal College of Radiologists (RCR), patient representatives and partner organisations, the Consortium provides a national forum where expertise can be shared and the future of molecular radiotherapy can be shaped together.'),
      h: 460,
    },
    sections: [
      {
        type: 'text',
        heading: 'What is Molecular Radiotherapy?',
        html:
          P('Molecular radiotherapy (MRT) is a targeted treatment that uses radioactive medicines to deliver radiation directly to cancer cells while minimising damage to surrounding healthy tissue.') +
          P('Radioiodine therapy has successfully treated patients with thyroid disease for more than 80 years. Today, advances in molecular radiotherapy are making it possible to treat an increasing range of cancers using targeted radioactive medicines.') +
          P('As these treatments continue to develop, so does the need for collaboration, research, education and service development. The Consortium was established to help support these priorities and ensure that patients across the UK can benefit from current and future molecular radiotherapy treatments.'),
        h: 380,
      },
      {
        type: 'cards',
        heading: 'Explore the Consortium',
        columns: 3,
        cardH: 360,
        cards: [
          { icon: 'fa-solid fa-comment-medical', heading: 'Patient Stories', body: P('Read about the experiences of patients who have undergone molecular radiotherapy, watch patient video interviews and discover how patient feedback is helping shape future services.'), cta: 'Patient Stories' },
          { icon: 'fa-solid fa-folder-open', heading: 'Professional Resources', body: P('Access guidance documents, workplans, reports, national reviews and other resources supporting molecular radiotherapy practice.'), cta: 'Professional Resources' },
          { icon: 'fa-solid fa-users', heading: 'Committee', body: P('Meet the healthcare professionals and patient representatives leading the work of the UK Molecular Radiotherapy Consortium.'), cta: 'Meet the Committee' },
        ],
      },
      {
        type: 'feature',
        heading: 'Working Together',
        html:
          P('The Consortium brings together expertise from across healthcare, research and patient organisations to help improve access to molecular radiotherapy, support innovation and encourage the sharing of knowledge.') +
          P('Together, we are helping to shape the future of molecular radiotherapy and improve outcomes for patients throughout the United Kingdom.'),
        h: 240,
      },
    ],
    closingHero: {
      headline: 'Shaping the Future of Molecular Radiotherapy',
      subheadline:
        'Join us in supporting collaboration, research and equitable access to molecular radiotherapy across the UK.',
      ctaLabel: 'Professional Resources',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const MRT_COMMITTEE = {
  tenantId: BNMS_TENANT_ID,
  slug: 'mrt-committee',
  title: 'Consortium Committee',
  design: buildDesign({
    theme: 'mrt',
    hero: {
      headline: 'Consortium Committee',
      subheadline:
        'Meet the healthcare professionals and patient representatives leading the work of the UK Molecular Radiotherapy Consortium.',
      ctaLabel: 'Contact the Committee',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-users',
      strapline: 'About the Committee',
      html:
        P('The UK Molecular Radiotherapy Consortium is led by a multidisciplinary Committee comprising healthcare professionals, researchers and patient representatives from across the United Kingdom.') +
        P('Working collaboratively, the Committee provides strategic leadership for the Consortium, helping to guide its priorities, support professional collaboration and promote the continued development of molecular radiotherapy services.') +
        P('The Committee works closely with the British Nuclear Medicine Society, the Royal College of Radiologists and partner organisations to support education, research, service development and equitable access to molecular radiotherapy.'),
      h: 340,
    },
    sections: [
      {
        type: 'text',
        heading: 'Meet the Committee',
        html: `<ul>${[
          'Carla Abreu \u2013 Technologist \u2013 Perceptive Imaging',
          'Busola Ade-Ojo \u2013 Head of Radiopharmacy, (Chief Radiopharmacist) \u2013 Cambridge University Hospitals NHS Foundation Trust',
          'Matt Aldridge \u2013 Clinical Scientist \u2013 Maidstone Hospital',
          'Jamshed Bomanji \u2013 Nuclear Medicine Consultant \u2013 University College Hospital',
          'Colin Brown \u2013 Clinical Scientist \u2013 Gartnavel General Hospital',
          'Emily Brown \u2013 Lead Technologist \u2013 Queen Elizabeth Hospital Birmingham',
          'John Buscombe \u2013 Physician \u2013 Addenbrooke\u2019s Hospital',
          'Amarnath Challapalli \u2013 Physician \u2013 Bristol Cancer Institute',
          'Simon Chowdhury \u2013 Medical Oncologist \u2013 Guy\u2019s Hospital',
          'Chris Coldham \u2013 Specialist NET nurse \u2013 Queen Elizabeth Hospital Birmingham',
          'Gill Collinson \u2013 Chief Executive \u2013 IPEM',
          'Gary Cook \u2013 Physician \u2013 St Thomas\u2019 Hospital',
          'Margaret Cooper \u2013 Radiopharmacist \u2013 King\u2019s College London',
          'Jilly Croasdale (Chair) \u2013 Radiopharmacist \u2013 Sandwell and West Birmingham Hospitals NHS Trust',
          'Nathan Dickinson \u2013 Specialist Clinical Scientist \u2013 University Hospitals of Leicester',
          'Omar Din \u2013 Consultant Clinical Oncologist \u2013 Weston Park Cancer Centre',
          'Sabina Dizdarevic \u2013 Nuclear Medicine Physician \u2013 Royal Sussex County Hospital',
          'Sean Dulloo \u2013 Medical Oncologist \u2013 Leicester Royal Infirmary',
          'Amy Eccles \u2013 Consultant Radiologist \u2013 Imperial College Healthcare NHS Trust',
          'Dorota Ferguson \u2013 Clinical Scientist \u2013 Royal Victoria Hospital',
          'Richard Fernandez \u2013 Physicist \u2013 Guy\u2019s Hospital',
          'Glenn Flux \u2013 Clinical Scientist \u2013 Royal Marsden Hospital &amp; Institute of Cancer Research',
          'Mark Gaze \u2013 Consultant Clinical Oncologist \u2013 University College Hospital London',
          'Adrian Hardy \u2013 Patient Representative',
          'Charnie Kalirai \u2013 Clinical Scientist \u2013 Nottingham University NHS Trust',
          'Daniel McCool \u2013 Clinical Scientist \u2013 Royal Free Hospital',
          'Daniel McGowan \u2013 Clinical Scientist \u2013 Churchill Hospital',
          'Jennifer Murphy \u2013 Clinical Nurse Specialist \u2013 University Hospital Coventry',
          'Shaunak Navalkissoor \u2013 Physician \u2013 Royal Free Hospital',
          'Caroline Oxley (BNMS Committees Secretary) \u2013 British Nuclear Medicine Society',
          'Luisa Roldao Pereira \u2013 Advanced practitioner for therapies \u2013 Maidstone Hospital',
          'Vineet Prakash \u2013 Nuclear Medicine Consultant \u2013 Royal Surrey County Hospital',
          'Stewart Redman \u2013 Consultant Radiologist \u2013 Royal United Hospital Bath',
          'Andrew Reilly \u2013 Vice President Scotland \u2013 IPEM',
          'Erin Ross \u2013 Physicist \u2013 Queen Elizabeth Hospital Birmingham',
          'Lisa Rowley \u2013 Clinical Scientist \u2013 University Hospital Coventry and Warwickshire NHS Trust',
          'Jane Sosabowski \u2013 Academic Radiochemist \u2013 Queen Mary University of London',
          'Anne-Marie Stapleton \u2013 Consultant Clinical Scientist \u2013 Royal Surrey County Hospital',
          'Francis Sundram \u2013 Physician \u2013 University Hospital Southampton',
          'Loretta Sweeney \u2013 Consultant Physician breast and urology oncology \u2013 Velindre Cancer Centre',
          'Sobhan Vinjamuri \u2013 Nuclear Medicine Consultant \u2013 Royal Liverpool University Hospital',
          'Jon Wadsley \u2013 Consultant Clinical Oncologist \u2013 Weston Park Cancer Centre',
          'Clint Waight \u2013 Radiopharmacist \u2013 The Royal Infirmary of Edinburgh',
          'Lisa Walker \u2013 CEO \u2013 Neuroendocrine Cancer UK',
          'Jo Weekes \u2013 Consultant Radiographer \u2013 The Royal Wolverhampton NHS Trust',
          'Charlotte Weston (BNMS CEO) \u2013 British Nuclear Medicine Society',
          'Heather Williams \u2013 Consultant Medical Physicist and Nuclear Medicine Group Leader \u2013 The Christie',
          'Wai Lup Wong \u2013 Radiologist \u2013 Mount Vernon Hospital',
          'Jennifer Young \u2013 Academic \u2013 King\u2019s College London',
        ]
          .map(LI)
          .join('')}</ul>`,
        h: 3120,
        bullets: true,
      },
      {
        type: 'feature',
        heading: 'Contact the Committee',
        html:
          P('The Committee welcomes enquiries, feedback and suggestions from healthcare professionals, researchers, patient representatives and partner organisations.') +
          P('If you would like to contact the Consortium or find out more about its work, please use the BNMS contact form.'),
        h: 240,
        cta: 'Contact the Committee',
      },
      {
        type: 'feature',
        heading: 'Working Together',
        html:
          P('The strength of the UK Molecular Radiotherapy Consortium comes from the collaboration between its members.') +
          P('By bringing together expertise from across healthcare, research and patient advocacy, the Committee helps ensure that molecular radiotherapy continues to develop in a way that benefits both patients and professionals throughout the United Kingdom.'),
        h: 240,
      },
    ],
    closingHero: {
      headline: 'Working Together for Patients',
      subheadline:
        'Have a question or want to find out more about the Consortium? The Committee would be glad to hear from you.',
      ctaLabel: 'Contact the Committee',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const MRT_PATIENT_STORIES = {
  tenantId: BNMS_TENANT_ID,
  slug: 'mrt-patient-stories',
  title: 'Patient Stories',
  design: buildDesign({
    theme: 'mrt',
    hero: {
      headline: 'Patient Stories',
      subheadline:
        'Sharing patient experiences to help improve molecular radiotherapy services and support future patients.',
      ctaLabel: 'Complete the Patient Questionnaire',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-heart-pulse',
      strapline: 'The Patient Voice Matters',
      html:
        P('Listening to patients is central to improving molecular radiotherapy services.') +
        P('The UK Molecular Radiotherapy Consortium is committed to understanding the experiences of patients undergoing molecular radiotherapy and ensuring that those experiences help shape future care.') +
        P('Working with patient representatives, including Adrian Hardy and Steve Allen, we are gathering feedback to better understand every stage of the patient journey \u2014 from diagnosis and treatment through to recovery and ongoing support.') +
        P('By sharing these experiences, we hope to improve services, support healthcare professionals and provide reassurance to future patients considering molecular radiotherapy.'),
      h: 420,
    },
    sections: [
      {
        type: 'text',
        heading: 'Patient Questionnaire',
        html:
          P('The patient questionnaire has been developed following consultation with members of the British Nuclear Medicine Society.') +
          P('It encourages patients to reflect on their treatment, the care they received and how their experience could be improved. The questionnaire also provides an opportunity for patients to share advice and reassurance for others who may be considering similar treatment.') +
          P('If you have patients who would be willing to participate, we would be grateful if you could encourage them to complete the questionnaire.'),
        h: 340,
        cta: 'Complete the Patient Questionnaire',
      },
      {
        type: 'text',
        heading: 'Patient Experiences',
        html:
          P('Every patient\u2019s journey is unique.') +
          P('These anonymised case studies provide valuable insight into the experiences of people who have undergone molecular radiotherapy, helping healthcare professionals better understand the patient perspective while offering reassurance to others beginning treatment.'),
        h: 220,
      },
      {
        type: 'cards',
        columns: 3,
        cardH: 320,
        cards: [
          { icon: 'fa-solid fa-user', heading: 'Patient A', body: P('An anonymised account describing the patient\u2019s diagnosis, treatment and experience of molecular radiotherapy.'), cta: 'Read Patient Story' },
          { icon: 'fa-solid fa-user', heading: 'Patient B', body: P('An anonymised account describing the patient\u2019s treatment journey and reflections on their care.'), cta: 'Read Patient Story' },
          { icon: 'fa-solid fa-user', heading: 'Patient C', body: P('An anonymised account sharing the patient\u2019s experience before, during and after treatment.'), cta: 'Read Patient Story' },
        ],
      },
      {
        type: 'placeholder',
        heading: 'Patient Video Interviews',
        note: NOTE('Patient video interviews will be displayed here in a responsive video gallery, sharing individual experiences, treatment journeys and personal reflections.'),
        h: 150,
      },
      {
        type: 'text',
        heading: 'Why Patient Feedback Matters',
        bullets: true,
        html:
          P('Patient feedback helps us:') +
          `<ul>${LI('Better understand the patient experience.')}${LI('Improve information and communication.')}${LI('Support service development.')}${LI('Shape future molecular radiotherapy services.')}${LI('Ensure the patient voice remains central to our work.')}</ul>` +
          P('Every story shared contributes to improving care for future patients.'),
        h: 380,
      },
      {
        type: 'feature',
        heading: 'Thank You',
        html:
          P('We are extremely grateful to every patient who has shared their experiences and to those who continue to contribute to the development of molecular radiotherapy services.') +
          P('Your experiences are helping improve care, inform healthcare professionals and support future patients across the United Kingdom.'),
        h: 240,
      },
    ],
    closingHero: {
      headline: 'Your Story Can Help Others',
      subheadline:
        'Sharing your experience of molecular radiotherapy helps improve care and reassure future patients.',
      ctaLabel: 'Complete the Patient Questionnaire',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const MRT_RESOURCES = {
  tenantId: BNMS_TENANT_ID,
  slug: 'mrt-professional-resources',
  title: 'MRT Professional Resources',
  design: buildDesign({
    theme: 'mrt',
    hero: {
      headline: 'Professional Resources',
      subheadline:
        'Access guidance, reports and reference documents supporting molecular radiotherapy across the United Kingdom.',
      ctaLabel: 'View Terms of Reference',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-folder-open',
      strapline: 'Supporting Molecular Radiotherapy Practice',
      html:
        P('The UK Molecular Radiotherapy Consortium provides access to a range of professional resources that support the development and delivery of molecular radiotherapy across the United Kingdom.') +
        P('These documents have been produced by the Consortium and partner organisations to support healthcare professionals, service development, research and the continued advancement of molecular radiotherapy.') +
        P('Whether you are looking for governance documents, national reports, clinical guidance or regulatory information, you will find them here.'),
      h: 340,
    },
    sections: [
      {
        type: 'text',
        heading: 'Governance',
        bullets: true,
        html:
          P('The Consortium operates in accordance with agreed governance and communications policies that provide the framework for its work and collaborative activities.') +
          P('Governance documents include:') +
          `<ul>${LI('Terms of Reference')}${LI('BNMS Communications Strategy & Policy (including BNMS Social Media Policy)')}</ul>`,
        h: 300,
        buttons: ['View Terms of Reference', 'View BNMS Communications Strategy & Policy'],
      },
      {
        type: 'text',
        heading: 'Consortium Workplan',
        bullets: true,
        html:
          P('The Consortium agrees and delivers its activities in accordance with a workplan, developed with input from Consortium members.') +
          P('The workplan provides a coordinated approach to supporting the continued development of molecular radiotherapy across the United Kingdom through five key areas of activity:') +
          `<ul>${LI('Workstream 1 \u2013 Harmonisation and Dosimetry')}${LI('Workstream 2 \u2013 Workforce')}${LI('Workstream 3 \u2013 Equitable Access and Service Models')}${LI('Workstream 4 \u2013 Infrastructure and Radiopharmacy')}${LI('Workstream 5 \u2013 Data Collection')}</ul>`,
        h: 380,
        cta: 'View Consortium Workplan',
      },
      {
        type: 'text',
        heading: 'Reports & Publications',
        bullets: true,
        html:
          P('The Consortium supports a range of national reports, reviews and publications that help inform the future development of molecular radiotherapy services:') +
          `<ul>${LI('Proposals for the Reshaping of Cancer Services in England: Funding for Innovative Cancer Treatments (Royal College of Radiologists)')}${LI('Report of the NIHR Molecular Radiotherapy (MRT) National Research Access Network Meeting')}${LI('Review of Molecular Radiotherapy Services in the UK')}${LI('Targeted Radionuclide Therapy \u2013 Erasmus KCL White Paper')}${LI('Nearly Double the Patients and Dramatic Changes over 14 Years of UK MRT: Internal Dosimetry Users Group Survey Results (2007\u20132021)')}${LI('Consensus Nomenclature for Radionuclide Therapy: Initial Recommendations from the Nuclear Medicine Global Initiative')}${LI('Molecular Radiotherapy System Wide Review Summary Document')}</ul>`,
        h: 520,
      },
      {
        type: 'text',
        heading: 'Clinical Guidance',
        bullets: true,
        html:
          P('A range of clinical guidance documents are available to support healthcare professionals involved in molecular radiotherapy:') +
          `<ul>${LI('Thyroid Disease: Assessment and Management')}${LI('EANM Procedure Guidelines for \u00B9\u00B3\u00B9I-meta-iodobenzylguanidine (\u00B9\u00B3\u00B9I-mIBG) Therapy')}${LI('EANM Procedure Guideline for the Treatment of Liver Cancer and Liver Metastases with Intra-arterial Radioactive Compounds')}${LI('SNM Practice Guideline for Therapy of Thyroid Disease with \u00B9\u00B3\u00B9I (Version 3.0)')}${LI('NANETS/SNMMI Procedure Standard for Somatostatin Receptor-Based Peptide Receptor Radionuclide Therapy with \u00B9\u2077\u2077Lu-DOTATATE')}${LI('ACR\u2013ACNM\u2013ASTRO\u2013SNMMI Practice Parameter for the Performance of Therapy with Radium-223')}${LI('Australian Product Information \u2013 Sodium Iodide [Iodine-131] Therapy Capsule')}${LI('Recommendations for the Provision of a Physics Service to Radiotherapy')}${LI('Patient Preparation and Radiation Protection Guidance for Adult Patients Undergoing Radioiodine Treatment for Thyroid Cancer in the UK')}</ul>`,
        h: 600,
      },
      {
        type: 'text',
        heading: 'ARSAC Guidance',
        bullets: true,
        html:
          P('The Administration of Radioactive Substances Advisory Committee (ARSAC) provides guidance for practitioners involved in molecular radiotherapy, including how to submit practitioner licence applications.') +
          P('Relevant sections of the ARSAC Notes for Guidance include:') +
          `<ul>${LI('Practitioner Licences \u2013 Section 3.14: Initial Applications for Therapy Licences')}${LI('Section 3.19: Qualifications and Experience of the Practitioner')}${LI('Sections 3.20\u20133.22: Guidance for Applicants Who Have Not Completed Formal Training Schemes')}${LI('Sections 3.31\u20133.36: Practical Experience')}${LI('Research Approvals \u2013 Sections 4.12\u20134.14: Research Involving Therapy Radiopharmaceuticals')}</ul>`,
        h: 440,
        buttons: ['How to Submit Practitioner Licence Applications', 'View ARSAC Notes for Guidance'],
      },
      {
        type: 'feature',
        heading: 'Looking for Patient Information?',
        html:
          P('Patient experience plays an important role in the development of molecular radiotherapy services.') +
          P('Visit our Patient Stories page to hear directly from patients, watch video interviews and access the patient questionnaire.'),
        h: 220,
        cta: 'Patient Stories',
      },
    ],
    closingHero: {
      headline: 'Advancing Molecular Radiotherapy Together',
      subheadline:
        'Explore the guidance, reports and reference documents supporting molecular radiotherapy across the UK.',
      ctaLabel: 'View Terms of Reference',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const RESEARCH_PRESENTATION_AWARDS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'research-and-presentation-awards',
  title: 'Research & Presentation Awards',
  design: buildDesign({
    hero: {
      headline: 'Research & Presentation Awards',
      subheadline: 'Recognising outstanding research, innovation and scientific excellence at the BNMS Annual Spring Meeting.',
      ctaLabel: 'Submit an Abstract',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-microscope',
      strapline: 'Celebrating Excellence in Research',
      html:
        P('The BNMS Annual Spring Meeting showcases the very best in nuclear medicine research, innovation and clinical practice.') +
        P('Each year, a wide range of prizes are awarded to recognise outstanding oral and poster presentations from across the nuclear medicine community. These awards celebrate excellence in scientific research, clinical practice, education and innovation while supporting the next generation of researchers and healthcare professionals.') +
        P('Whether you are presenting your first abstract or sharing years of research, the Research & Presentation Awards provide an opportunity to have your work recognised by colleagues from across the UK and beyond.'),
      h: 420,
    },
    sections: [
      {
        type: 'text',
        heading: 'Overall Presentation Awards',
        html: P('These awards recognise the highest scoring oral and poster presentations presented during the Annual Spring Meeting.'),
        h: 140,
      },
      {
        type: 'text',
        heading: 'Oral Presentation Awards',
        html:
          P('The highest scoring oral presentations are recognised with three awards.') +
          `<ul>${LI('<strong>First Prize</strong> \u2014 \u00a3300 plus the President\u2019s Cup*')}${LI('<strong>Second Prize</strong> \u2014 \u00a3200')}${LI('<strong>Third Prize</strong> \u2014 \u00a3100')}</ul>` +
          P('The winner receives the President\u2019s Cup for one year and is presented with a replica to keep.') +
          P('<strong>Additional Recognition:</strong> Recipients of the First Prize Oral Presentation are invited to submit a full paper to Nuclear Medicine Communications within two months of receiving their award.') +
          P('<strong>Sponsor:</strong> TBC'),
        h: 460,
      },
      {
        type: 'text',
        heading: 'Poster Presentation Awards',
        html:
          P('Outstanding poster presentations are recognised annually.') +
          `<ul>${LI('<strong>First Prize</strong> \u2014 \u00a3300')}${LI('<strong>Second Prize</strong> \u2014 \u00a3200')}${LI('<strong>Third Prize</strong> \u2014 \u00a3100')}</ul>` +
          P('<strong>Sponsor:</strong> Light Medical'),
        h: 320,
      },
      {
        type: 'text',
        heading: 'Category Awards',
        html:
          P('To recognise excellence across every discipline within nuclear medicine, BNMS also presents a number of specialist category awards.') +
          `<ul>${
            LI('<strong>Radiographers, Technologists & Nurses Award</strong> \u2014 Best Oral Presentation \u2013 \u00a3300; Best Poster Presentation \u2013 \u00a3300') +
            LI('<strong>Physics Prize</strong> \u2014 Best Oral or Poster Presentation \u2013 \u00a3300') +
            LI('<strong>Preclinical Prize</strong> \u2014 Best Oral or Poster Presentation \u2013 \u00a3300') +
            LI('<strong>Radiopharmacy Oral Prize</strong> \u2014 Best Oral Presentation \u2013 \u00a3250')
          }</ul>`,
        h: 360,
      },
      {
        type: 'text',
        heading: 'Memorial Prizes',
        html:
          P('Several awards honour individuals whose contributions have helped shape nuclear medicine.') +
          `<ul>${
            LI('<strong>Saul Hertz Memorial Prize</strong> \u2014 Best oral or poster presentation relating to radionuclide therapy') +
            LI('<strong>Lee Jenkins Memorial Prize</strong> \u2014 Best abstract on dosimetry and quantitative SPECT') +
            LI('<strong>Muriel Buxton-Thomas Memorial Prize</strong> \u2014 Best radionuclide oncology imaging and therapy abstract') +
            LI('<strong>Ignac Fogelman Memorial Prize</strong> \u2014 Best bone imaging abstract') +
            LI('<strong>John Buscombe Prize</strong> \u2014 Best International Poster') +
            LI('<strong>Isky Gordon Prize</strong> \u2014 Best Paediatric Presentation')
          }</ul>` +
          P('<strong>Prize Values</strong>') +
          `<ul>${
            LI('<strong>Saul Hertz Memorial Prize</strong> \u2014 Oral \u00a3250 \u2022 Poster \u00a3100') +
            LI('<strong>Lee Jenkins Memorial Prize</strong> \u2014 Oral or Poster \u00a3300') +
            LI('<strong>Muriel Buxton-Thomas Memorial Prize</strong> \u2014 Oral or Poster \u00a3200') +
            LI('<strong>Ignac Fogelman Memorial Prize</strong> \u2014 Oral or Poster \u00a3200') +
            LI('<strong>John Buscombe Prize</strong> \u2014 Poster \u00a3200') +
            LI('<strong>Isky Gordon Prize</strong> \u2014 Oral or Poster \u00a3200')
          }</ul>`,
        h: 700,
      },
      {
        type: 'text',
        heading: 'Early Career Awards',
        html: P('Supporting and encouraging the next generation of nuclear medicine professionals is a key part of the BNMS mission.'),
        h: 120,
      },
      {
        type: 'text',
        heading: 'BNMS Student Prize',
        html:
          P('Awarded to undergraduate students only.') +
          P('Prizes are awarded based on the submitted abstract.') +
          `<ul>${LI('<strong>First Prize</strong> \u2014 \u00a3300')}${LI('<strong>Second Prize</strong> \u2014 \u00a3200')}${LI('<strong>Third Prize</strong> \u2014 \u00a3100')}</ul>` +
          P('<strong>Sponsor:</strong> BNMS'),
        h: 340,
      },
      {
        type: 'text',
        heading: 'BNMS Young Investigator Prize',
        html:
          P('The Young Investigator Prize recognises outstanding research by early-career professionals and trainees.') +
          P('<strong>Eligibility</strong>') +
          P('Applicants must:') +
          `<ul>${
            LI('Be under 35 years of age at the time of application.') +
            LI('Be a trainee or junior member of staff within any nuclear medicine discipline.') +
            LI('Meet one of the following criteria:' +
              `<ul>${
                LI('Medical staff not yet holding a Consultant (or equivalent) appointment.') +
                LI('NHS staff employed at Band 8a (or equivalent) or below.') +
                LI('Academic staff below Senior Lecturer (or equivalent).')
              }</ul>`)
          }</ul>` +
          P('The prize is awarded for oral presentations only.') +
          P('<strong>Prize</strong>') +
          P('Two awards are presented:') +
          `<ul>${LI('Clinical Prize \u2013 \u00a3250')}${LI('Scientific Prize \u2013 \u00a3250')}</ul>` +
          P('Total Prize Fund: \u00a3500') +
          P('<strong>Sponsor:</strong> BNMS'),
        h: 760,
      },
      {
        type: 'text',
        heading: 'Award Sponsors',
        html:
          P('BNMS is grateful to the organisations and individuals who support the Research & Presentation Awards each year.') +
          `<ul>${
            LI('<strong>Poster Presentation Awards</strong> \u2014 Light Medical') +
            LI('<strong>Radiopharmacy Oral Prize</strong> \u2014 Alliance Medical') +
            LI('<strong>Lee Jenkins Memorial Prize</strong> \u2014 Hermes Medical Solutions') +
            LI('<strong>Muriel Buxton-Thomas Memorial Prize</strong> \u2014 Friends and Colleagues') +
            LI('<strong>Ignac Fogelman Memorial Prize</strong> \u2014 Friends and Colleagues') +
            LI('<strong>John Buscombe Prize</strong> \u2014 Friends and Colleagues') +
            LI('<strong>Isky Gordon Prize</strong> \u2014 Friends and Colleagues') +
            LI('<strong>Student Prize</strong> \u2014 BNMS') +
            LI('<strong>Young Investigator Prize</strong> \u2014 BNMS') +
            LI('<strong>Oral Presentation Awards</strong> \u2014 TBC') +
            LI('<strong>Physics Prize</strong> \u2014 TBC') +
            LI('<strong>Preclinical Prize</strong> \u2014 TBC') +
            LI('<strong>RTN Awards</strong> \u2014 TBC') +
            LI('<strong>Saul Hertz Memorial Prize</strong> \u2014 Anonymous Sponsor')
          }</ul>`,
        h: 720,
      },
      {
        type: 'feature',
        heading: 'Submit Your Research',
        html:
          P('Research & Presentation Awards form an important part of the BNMS Annual Spring Meeting and celebrate the innovation, collaboration and scientific excellence that continue to advance nuclear medicine.') +
          P('Abstract submissions open annually as part of the conference programme. Full submission guidance, eligibility criteria and key dates are published when abstract submissions open.'),
        buttons: ['Submit an Abstract', 'Annual Spring Meeting'],
        h: 320,
      },
    ],
  }),
};

const RTN_AWARD = {
  tenantId: BNMS_TENANT_ID,
  slug: 'radiographers-technologists-and-nurses-award',
  title: 'Radiographers, Technologists & Nurses Award',
  design: buildDesign({
    hero: {
      headline: 'Radiographers, Technologists & Nurses Award',
      subheadline: 'Recognising the outstanding contribution of radiographers, technologists and nurses to nuclear medicine.',
      ctaLabel: 'Nominate a Colleague',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-user-nurse',
      strapline: 'Celebrating Excellence in Clinical Practice',
      html:
        P('The BNMS Radiographers, Technologists & Nurses Award recognises the vital role that radiographers, technologists and nurses play in delivering high-quality nuclear medicine services across the United Kingdom.') +
        P('Presented annually by the BNMS Radiographers, Technologists & Nurses Group, the award celebrates individuals who have demonstrated exceptional commitment to professional practice, innovation, education and patient care.') +
        P('Formerly known as the Clinical Practitioner\u2019s Award, this honour reflects the essential contribution these professionals make to advancing nuclear medicine and improving outcomes for patients.'),
      h: 420,
    },
    sections: [
      {
        type: 'text',
        heading: 'About the Award',
        html:
          P('The Radiographers, Technologists & Nurses Award is presented each year by the BNMS Radiographers, Technologists & Nurses Group and is ratified by BNMS Council.') +
          P('The recipient receives a commemorative engraved paperweight, presented during the BNMS Annual Spring Meeting, in recognition of their outstanding contribution to the profession.') +
          P('The award acknowledges individuals whose dedication, expertise and leadership have made a lasting difference within their department, organisation or the wider nuclear medicine community.'),
        h: 340,
      },
      {
        type: 'text',
        heading: 'Award Criteria',
        html:
          P('The award recognises radiographers, technologists and nurses who have demonstrated excellence through one or more of the following:') +
          `<ul>${
            LI('Outstanding clinical practice') +
            LI('Innovation in nuclear medicine services') +
            LI('Excellence in patient care') +
            LI('Leadership within the profession') +
            LI('Education, teaching and mentoring') +
            LI('Service to the British Nuclear Medicine Society or the wider nuclear medicine community')
          }</ul>` +
          P('Recipients are recognised for making a significant and lasting contribution to their profession and to the delivery of nuclear medicine services.'),
        bullets: true,
        h: 420,
      },
      {
        type: 'text',
        heading: 'Nominations',
        html:
          P('BNMS welcomes nominations from members who wish to recognise colleagues whose dedication and professionalism have made an exceptional impact.') +
          P('Nominations should be submitted to the Chair of the BNMS Radiographers, Technologists & Nurses Group by December each year.') +
          P('Recommendations are reviewed by the Group before being submitted to BNMS Council for final approval.'),
        cta: 'Nominate a Colleague',
        h: 320,
      },
      {
        type: 'text',
        heading: 'Previous Recipients',
        html:
          `<ul>${
            LI('<strong>2026</strong> \u2014 Carla Abreu, Perceptive Imaging') +
            LI('<strong>2025</strong> \u2014 Chris Mayes, Royal Liverpool University Hospital') +
            LI('<strong>2024</strong> \u2014 Peter Hogg, University of Salford') +
            LI('<strong>2023</strong> \u2014 Louise Causer, The Royal Marsden Hospital') +
            LI('<strong>2022</strong> \u2014 Sandra Johns, Southampton General Hospital') +
            LI('<strong>2020</strong> \u2014 Alan Deakin, Birmingham City Hospital') +
            LI('<strong>2019</strong> \u2014 Carolyn Lory, Medway Maritime Hospital') +
            LI('<strong>2018</strong> \u2014 Neil Smith, City Hospital Birmingham') +
            LI('<strong>2017</strong> \u2014 Caroline Townsend, University College London') +
            LI('<strong>2014</strong> \u2014 Phil Facey, Cardiff University') +
            LI('<strong>2013</strong> \u2014 Bernadette Cronin, Royal Marsden') +
            LI('<strong>2011</strong> \u2014 John Jones, Cardiff & Vale NHS Trust') +
            LI('<strong>2010</strong> \u2014 Sally Farrell, Derriford Hospital') +
            LI('<strong>2009</strong> \u2014 Robert Blair, Sunderland Royal Infirmary') +
            LI('<strong>2008</strong> \u2014 Joyce Davidson, Aberdeen Royal Infirmary')
          }</ul>`,
        h: 720,
      },
      {
        type: 'feature',
        heading: 'Recognising the Professionals Behind Every Patient Journey',
        html:
          P('Radiographers, technologists and nurses are at the heart of nuclear medicine, delivering expert care, driving innovation and supporting patients throughout their diagnostic and therapeutic journey.') +
          P('This award celebrates their professionalism, dedication and commitment, recognising the individuals whose work strengthens both the specialty and the wider BNMS community.'),
        h: 300,
      },
    ],
  }),
};

const PRESIDENTS_MEDAL_PRIZE = {
  tenantId: BNMS_TENANT_ID,
  slug: 'presidents-medal-and-presidents-prize',
  title: 'President\u2019s Medal & President\u2019s Prize',
  design: buildDesign({
    hero: {
      headline: 'President\u2019s Medal & President\u2019s Prize',
      subheadline: 'Recognising exceptional contribution to nuclear medicine and outstanding service to the British Nuclear Medicine Society.',
      ctaLabel: 'Nominate a Colleague',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-medal',
      strapline: 'Celebrating Outstanding Achievement',
      html:
        P('The President\u2019s Medal and President\u2019s Prize are among the British Nuclear Medicine Society\u2019s most prestigious honours.') +
        P('Presented at the BNMS Annual Spring Meeting, these awards recognise individuals whose dedication, leadership and commitment have made a lasting impact on nuclear medicine and the Society.') +
        P('While each award has its own distinct purpose, both celebrate the people whose work has helped advance the specialty, strengthen the BNMS community and inspire future generations of professionals.'),
      h: 400,
    },
    sections: [
      {
        type: 'columns',
        columns: [
          {
            h3: 'President\u2019s Medal',
            html:
              P('The President\u2019s Medal is presented to medical professionals who have made an exceptional contribution to nuclear medicine throughout their career.') +
              P('Recipients are recognised for their leadership, innovation, clinical excellence, research or education, and for the lasting influence they have had on the specialty both nationally and internationally.') +
              P('The award represents the Society\u2019s highest recognition of professional achievement within nuclear medicine.'),
            h: 420,
          },
          {
            h3: 'President\u2019s Prize (Rose Bowl)',
            html:
              P('The President\u2019s Prize, presented in the form of the historic Rose Bowl, recognises individuals who have provided outstanding service to the British Nuclear Medicine Society.') +
              P('Recipients are honoured for their dedication, commitment and contribution to the Society through many years of voluntary service, leadership and support for the BNMS community.') +
              P('This award celebrates those whose efforts behind the scenes have helped shape and strengthen the Society.'),
            h: 420,
          },
        ],
      },
      {
        type: 'text',
        heading: 'Previous Recipients',
        html:
          P('<strong>President\u2019s Medal</strong>') +
          `<ul>${
            LI('<strong>2026</strong> \u2014 Prof Isky Gordon') +
            LI('<strong>2025</strong> \u2014 Dr Mary Prescott') +
            LI('<strong>2024</strong> \u2014 Dr John Buscombe') +
            LI('<strong>2023</strong> \u2014 Dr Alp Notghi') +
            LI('<strong>2022</strong> \u2014 Prof Sally Barrington') +
            LI('<strong>2020</strong> \u2014 Prof Sobhan Vinjamuri') +
            LI('<strong>2019</strong> \u2014 Prof Keith Britton') +
            LI('<strong>2018</strong> \u2014 Dr Jamshed Bomanji') +
            LI('<strong>2017</strong> \u2014 Muriel Buxton-Thomas') +
            LI('<strong>2016</strong> \u2014 Dr Keith Harding') +
            LI('<strong>2015</strong> \u2014 Prof Ralph McCready') +
            LI('<strong>2014</strong> \u2014 Prof Adil Al-Nahhas') +
            LI('<strong>2013</strong> \u2014 Dr Desmond Green') +
            LI('<strong>2012</strong> \u2014 Prof Mike O\u2019Doherty') +
            LI('<strong>2011</strong> \u2014 Dr Tom Nunan') +
            LI('<strong>2010</strong> \u2014 Dr Andrew Hilson') +
            LI('<strong>2009</strong> \u2014 Prof Peter Ell')
          }</ul>` +
          P('<strong>President\u2019s Prize (Rose Bowl)</strong>') +
          `<ul>${
            LI('<strong>2008</strong> \u2014 Dr Sue Clarke') +
            LI('<strong>2007</strong> \u2014 Mrs Sue Hatchard') +
            LI('<strong>2007</strong> \u2014 Dr Wendy Tindale')
          }</ul>`,
        h: 940,
      },
      {
        type: 'text',
        heading: 'Nominations',
        html:
          P('The President\u2019s Medal and President\u2019s Prize recognise exceptional achievement and service within the nuclear medicine community.') +
          P('Nominations are welcomed from BNMS members and are considered by the Society in accordance with the current awards process.') +
          P('If you know a colleague whose contribution deserves recognition, we encourage you to submit a nomination for consideration.'),
        cta: 'Nominate a Colleague',
        h: 320,
      },
      {
        type: 'feature',
        heading: 'Why These Awards Matter',
        html:
          P('For almost six decades, the President\u2019s Medal and President\u2019s Prize have celebrated the people whose vision, expertise and dedication have helped shape the British Nuclear Medicine Society and the wider nuclear medicine profession.') +
          P('By recognising excellence and service, these awards honour the achievements of today\u2019s leaders while inspiring future generations to continue advancing patient care, education, research and professional collaboration.'),
        h: 300,
      },
    ],
  }),
};

const NORMAN_VEALL_MEDAL = {
  tenantId: BNMS_TENANT_ID,
  slug: 'norman-veall-medal',
  title: 'Norman Veall Medal',
  design: buildDesign({
    hero: {
      headline: 'Norman Veall Medal',
      subheadline: 'Recognising outstanding contributions to the science and practice of nuclear medicine in the United Kingdom.',
      ctaLabel: 'Nominate a Colleague',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-award',
      strapline: 'Honouring a Pioneer of British Nuclear Medicine',
      html:
        P('The Norman Veall Medal is one of the British Nuclear Medicine Society\u2019s most prestigious scientific honours.') +
        P('Established to commemorate Dr Norman Veall, one of the pioneers of nuclear medicine in the United Kingdom, the Medal recognises clinical scientists whose work has made an exceptional contribution to the science and practice of nuclear medicine.') +
        P('The award was created following a decision by BNMS Council in 1991, when members were invited to contribute towards a lasting tribute to Dr Veall\u2019s legacy. Commemorative medals were commissioned, and the first Norman Veall Medal was presented at the BNMS Annual Meeting in London in March 1994.') +
        P('Today, the Medal continues to celebrate excellence, innovation and leadership within clinical science, recognising individuals whose work has advanced nuclear medicine for the benefit of patients, colleagues and the wider profession.'),
      h: 520,
    },
    sections: [
      {
        type: 'text',
        heading: 'Award Criteria',
        html:
          P('The Norman Veall Medal is normally awarded annually to a clinical scientist who has made an outstanding contribution to the science and/or practice of nuclear medicine in the United Kingdom.') +
          P('Nominations are considered by an assessment panel comprising:') +
          `<ul>${LI('Two Clinical Scientists')}${LI('The current BNMS President')}</ul>` +
          P('Each nomination should be supported by a statement of up to 400 words, outlining the nominee\u2019s achievements and explaining how they have made an exceptional contribution to the specialty.'),
        cta: 'Nominate a Colleague',
        h: 400,
      },
      {
        type: 'text',
        heading: 'Previous Recipients',
        html:
          `<ul>${
            LI('<strong>2026</strong> \u2014 Prof Andy Irwin, Singleton Hospital, Swansea') +
            LI('<strong>2025</strong> \u2014 Mr Nigel Williams, University Hospital Coventry & Warwickshire') +
            LI('<strong>2024</strong> \u2014 Dr Glenn Flux, Royal Marsden Hospital') +
            LI('<strong>2023</strong> \u2014 Ms Claire Greaves, Nottingham City Hospital') +
            LI('<strong>2022</strong> \u2014 Dr Daniel McCool, Royal Free Hampstead NHS Trust') +
            LI('<strong>2020</strong> \u2014 Prof Philip Blower, St Thomas\u2019 Hospital') +
            LI('<strong>2019</strong> \u2014 Ms Maria Palmer, United Bristol Healthcare NHS Trust') +
            LI('<strong>2018</strong> \u2014 Dr Roger Staff, Aberdeen Royal Infirmary') +
            LI('<strong>2017</strong> \u2014 Ms Sarah Allen, Guy\u2019s & St Thomas\u2019 Hospital') +
            LI('<strong>2016</strong> \u2014 Dr Steven Ebdon-Jackson, Health Protection Agency') +
            LI('<strong>2015</strong> \u2014 Paul Maltby, Royal Liverpool University Hospital') +
            LI('<strong>2014</strong> \u2014 Dr Bill Thomson, City Hospital, Birmingham') +
            LI('<strong>2013</strong> \u2014 Prof Alan Perkins MBE, Queen\u2019s Medical Centre, Nottingham') +
            LI('<strong>2012</strong> \u2014 Prof G Blake, Guy\u2019s & St Thomas\u2019 NHS Trust and King\u2019s College London') +
            LI('<strong>2011</strong> \u2014 Prof S Mather, Queen Mary University London') +
            LI('<strong>2010</strong> \u2014 Prof R Lawson, Central Manchester University Hospitals') +
            LI('<strong>2009</strong> \u2014 Prof R Shields, Manchester Royal Infirmary') +
            LI('<strong>2005</strong> \u2014 Prof A Elliott, Western Infirmary, Glasgow') +
            LI('<strong>2004</strong> \u2014 Prof D Williams, Sunderland Royal Hospital') +
            LI('<strong>2003</strong> \u2014 Prof M Frier, Nottingham University NHS Trust') +
            LI('<strong>2002</strong> \u2014 Prof P Jarritt, Royal Victoria Hospital, Belfast') +
            LI('<strong>2001</strong> \u2014 Dr A Houston, Royal Hospital Haslar, Portsmouth') +
            LI('<strong>2000</strong> \u2014 Dr J Fleming, Southampton University Hospital') +
            LI('<strong>1999</strong> \u2014 Prof P Sharpe, Grampian University Hospitals NHS Trust, Aberdeen') +
            LI('<strong>1998</strong> \u2014 Prof D Barber, Royal Hallamshire Hospital, Sheffield') +
            LI('<strong>1997</strong> \u2014 Prof A Todd-Pokropek, University College Hospital, London') +
            LI('<strong>1996</strong> \u2014 Prof R Ekins, University College Hospital, London') +
            LI('<strong>1995</strong> \u2014 Prof John Mallard\u2020, University of Aberdeen') +
            LI('<strong>1994</strong> \u2014 Dr Terry Jones & Dr John Clarke, Hammersmith Hospital, London')
          }</ul>`,
        h: 1320,
      },
      {
        type: 'feature',
        heading: 'The Legacy of Dr Norman Veall',
        html:
          P('Dr Norman Veall was one of the pioneers of British nuclear medicine, whose work helped shape the development of the specialty in the United Kingdom.') +
          P('The Norman Veall Medal continues his legacy by recognising clinical scientists whose innovation, expertise and leadership continue to advance nuclear medicine for future generations.') +
          P('<strong>Learn more about Dr Norman Veall</strong>') +
          P('Read Dr Veall\u2019s obituary, written by M. N. Maisey for Nuclear Medicine Communications.'),
        cta: 'Read the Obituary',
        h: 380,
      },
    ],
    closingHero: {
      headline: 'Help Recognise Scientific Excellence',
      subheadline: 'Every year, the Norman Veall Medal honours individuals whose work has strengthened nuclear medicine through scientific excellence, innovation and professional leadership. If you know a clinical scientist whose contribution deserves recognition, we encourage you to submit a nomination.',
      ctaLabel: 'Nominate a Colleague',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const MEDICAL_TRAINING_ESSAY = {
  tenantId: BNMS_TENANT_ID,
  slug: 'medical-training-essay-competition',
  title: 'Medical Training Essay Competition',
  design: buildDesign({
    hero: {
      headline: 'Medical Training Essay Competition',
      subheadline: 'Encouraging the next generation of doctors to explore, research and share their interest in nuclear medicine.',
      ctaLabel: 'View Competition Guidelines',
      bgImageUrl: HERO_IMG_OPEN,
    },
    sections: [
      {
        type: 'text',
        html:
          P('The BNMS Medical Training Essay Competition provides medical students and resident doctors with an opportunity to explore the rapidly evolving field of nuclear medicine and molecular imaging.') +
          P('The competition encourages participants to investigate current topics, develop their academic writing and presentation skills, and gain valuable experience presenting their work to a national audience. It is designed to inspire future specialists while promoting excellence, curiosity and innovation within the profession.') +
          P('Successful entrants have the opportunity to present their work at the BNMS Annual Spring Meeting and gain recognition from leading clinicians and educators working across nuclear medicine.'),
        cta: 'View Competition Guidelines',
        h: 400,
      },
      {
        type: 'text',
        heading: 'Why Take Part?',
        html:
          P('Whether you are considering a career in nuclear medicine or simply have an interest in medical imaging, theragnostics or molecular medicine, the Medical Training Essay Competition is an excellent opportunity to broaden your knowledge and showcase your ideas.') +
          P('Participants benefit from:') +
          `<ul>${
            LI('Developing a deeper understanding of nuclear medicine and molecular imaging.') +
            LI('Exploring current clinical practice, research or emerging technologies.') +
            LI('Enhancing academic writing and critical thinking skills.') +
            LI('Gaining experience of presenting at a national scientific meeting.') +
            LI('Receiving recognition from the British Nuclear Medicine Society.') +
            LI('Meeting clinicians, researchers and trainees from across the UK.')
          }</ul>`,
        bullets: true,
        h: 460,
      },
      {
        type: 'text',
        heading: 'Who Can Enter?',
        html:
          P('The competition is open to:') +
          `<ul>${
            LI('Medical students.') +
            LI('Foundation doctors.') +
            LI('Core trainees.') +
            LI('Resident doctors who have not yet entered higher specialty training in Nuclear Medicine or Clinical Radiology.')
          }</ul>` +
          P('Individual submissions are welcomed from anyone with an interest in nuclear medicine and its future development.') +
          P('BNMS Student Membership is free, while discounted trainee membership is available for those wishing to become more involved with the Society and its educational activities.'),
        h: 440,
      },
      {
        type: 'text',
        heading: 'About the Competition',
        html:
          P('Each year, entrants are invited to submit an original essay on a topic selected by the BNMS Medical Training Committee.') +
          P('Essays are assessed by an expert judging panel, with shortlisted entrants invited to present their work during a dedicated session at the BNMS Annual Spring Meeting.') +
          P('The competition aims to encourage independent learning, scientific curiosity and the communication of new ideas while introducing participants to the wider nuclear medicine community.'),
        h: 320,
      },
      {
        type: 'text',
        heading: 'Recognition & Awards',
        html:
          P('Finalists may be invited to present their essays during the BNMS Annual Spring Meeting.') +
          P('Depending on the competition arrangements for each year, successful entrants may receive:') +
          `<ul>${
            LI('A Certificate of Merit.') +
            LI('Complimentary conference registration.') +
            LI('Contribution towards travel expenses.') +
            LI('Recognition during the BNMS Annual Spring Meeting.')
          }</ul>` +
          P('Prize details and eligibility are confirmed within each year\u2019s competition guidance.'),
        h: 420,
      },
      {
        type: 'text',
        heading: 'How to Enter',
        html:
          P('When the competition opens, this page will provide:') +
          `<ul>${
            LI('Competition guidelines.') +
            LI('Essay title or theme.') +
            LI('Eligibility criteria.') +
            LI('Submission requirements.') +
            LI('Judging criteria.') +
            LI('Important dates.') +
            LI('Online submission information.')
          }</ul>` +
          P('If entries are not currently open, details of the next competition will be published here as soon as they become available.'),
        h: 460,
      },
      {
        type: 'text',
        heading: 'Current Competition Status',
        html:
          P('Entries for the current Medical Training Essay Competition are now closed.') +
          P('The next competition will be announced on this page and through BNMS communications. We encourage prospective entrants to check back regularly or follow BNMS for future updates.'),
        h: 240,
      },
      {
        type: 'feature',
        heading: 'Start Your Journey in Nuclear Medicine',
        html: P('Whether you are exploring career options, undertaking research or developing your clinical knowledge, BNMS is here to support you throughout your training and professional development.'),
        buttons: ['Join BNMS', 'Explore Education & Training'],
        h: 260,
      },
    ],
  }),
};

const INNOVATIVE_TEAM_AWARD = {
  tenantId: BNMS_TENANT_ID,
  slug: 'bnms-innovative-team-award',
  title: 'BNMS Innovative Team Award',
  design: buildDesign({
    hero: {
      headline: 'BNMS Innovative Team Award',
      subheadline: 'Celebrating the teams transforming nuclear medicine through innovation, collaboration and service improvement.',
      ctaLabel: 'Enter the Award',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-lightbulb',
      strapline: 'Celebrating Innovation in Nuclear Medicine',
      html:
        P('The BNMS Innovative Team Award recognises multidisciplinary teams that are developing creative and innovative ways to improve the services they deliver.') +
        P('The award celebrates projects that enhance patient care, improve efficiency, strengthen education and training, or introduce new ways of working that benefit both patients and healthcare professionals.') +
        P('By recognising and sharing innovative ideas, BNMS hopes to inspire departments across the UK to adopt new approaches that improve nuclear medicine services for everyone.'),
      h: 420,
    },
    sections: [
      {
        type: 'text',
        heading: 'About the Award',
        html:
          P('Innovation is at the heart of improving healthcare.') +
          P('The BNMS Innovative Team Award celebrates teams who have identified a challenge, developed an effective solution and demonstrated a positive impact within their department or organisation.') +
          P('Projects may focus on clinical practice, operational efficiency, education, staff wellbeing, sustainability or patient experience, with the aim of encouraging innovation that can be shared across the wider nuclear medicine community.') +
          P('The winning team receives a commemorative plaque or trophy, while the two runners-up receive Highly Commended Certificates during the BNMS Annual Spring Meeting.'),
        h: 440,
      },
      {
        type: 'text',
        heading: 'Who Can Enter?',
        html:
          P('The award is open to multidisciplinary teams working within nuclear medicine services across the United Kingdom.') +
          P('For the purposes of this award:') +
          `<ul>${
            LI('A team consists of two or more members.') +
            LI('The award is open to both full-time and part-time staff working in nuclear medicine.') +
            LI('Projects must have been active during the year leading up to the award.') +
            LI('NHS Trusts in England may submit one application per Trust.') +
            LI('Teams from Scotland, Wales and Northern Ireland are welcome to enter. Please contact BNMS if additional guidance is required before submitting your application.')
          }</ul>`,
        h: 440,
      },
      {
        type: 'text',
        heading: 'What We\u2019re Looking For',
        html:
          P('Projects should demonstrate innovation and measurable improvements in one or more of the following areas:') +
          `<ul>${
            LI('Improving patient care and patient experience') +
            LI('Increasing operational efficiency') +
            LI('Reducing waste or improving sustainability') +
            LI('Enhancing education or staff training') +
            LI('Improving departmental processes') +
            LI('Creating a better working environment') +
            LI('Introducing innovative technologies or new ways of working')
          }</ul>` +
          P('Entries should clearly explain:') +
          `<ul>${
            LI('The challenge or problem identified') +
            LI('The solution that was developed') +
            LI('How the project was implemented') +
            LI('The impact and outcomes achieved') +
            LI('How the innovation could benefit other departments')
          }</ul>`,
        h: 620,
      },
      {
        type: 'text',
        heading: 'Judging Process',
        html:
          P('Applications are reviewed using the initial submission before the highest-scoring projects are shortlisted as finalists.') +
          P('<strong>Finalists</strong>') +
          P('The three highest-scoring teams will be invited to:') +
          `<ul>${
            LI('Produce a two-minute video introducing their team and project.') +
            LI('Present their innovation during the BNMS Annual Spring Meeting.') +
            LI('Share their project with the wider nuclear medicine community.')
          }</ul>` +
          P('The finalist videos are published on the BNMS website ahead of the meeting, allowing BNMS members to vote for their favourite innovation.') +
          P('During the Annual Spring Meeting, delegates also vote after viewing the finalist presentations.') +
          P('The combined votes determine the winning team.'),
        h: 560,
      },
      {
        type: 'text',
        heading: 'Award Presentation',
        html:
          P('The winners are announced during the BNMS Annual Spring Meeting.') +
          P('The winning department receives a commemorative plaque or trophy, while the remaining finalists receive Highly Commended Certificates.') +
          P('To take part in the final, at least one member of each finalist team must be registered to attend the Annual Spring Meeting.'),
        h: 300,
      },
      {
        type: 'text',
        heading: 'How to Enter',
        html:
          P('Applications open alongside abstract submissions for the BNMS Annual Spring Meeting.') +
          P('Entries should be submitted online using the official application form before the published closing date.') +
          P('Applicants should also review the competition rules and submission guidance before completing their entry.'),
        buttons: ['Enter the Award', 'Download the Rules & Instructions'],
        h: 320,
      },
      {
        type: 'feature',
        heading: 'Previous Finalists & Winning Projects',
        html:
          P('Discover the innovative ideas that have inspired improvements in nuclear medicine departments across the UK.') +
          P('Watch previous finalist videos and explore successful projects to see how teams have improved services, enhanced patient care and introduced new ways of working.'),
        cta: 'View Previous Finalists',
        h: 280,
      },
      {
        type: 'feature',
        heading: 'Inspiring Innovation Across the Profession',
        html:
          P('Every improvement begins with an idea.') +
          P('The BNMS Innovative Team Award celebrates the creativity, collaboration and commitment of teams who continually look for better ways to deliver outstanding nuclear medicine services.') +
          P('By sharing successful projects, the award encourages innovation throughout the profession and helps departments learn from one another to improve patient care across the UK.'),
        h: 320,
      },
    ],
  }),
};

const ABOUT_US_NEW = {
  tenantId: BNMS_TENANT_ID,
  slug: 'about-us-new',
  title: '60 Years of the British Nuclear Medicine Society',
  design: buildDesign({
    hero: {
      headline: '60 Years of the British Nuclear Medicine Society',
      subheadline: 'Celebrating six decades of leadership, collaboration, education and innovation in nuclear medicine.',
      ctaLabel: 'Explore the Interactive Timeline',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-cake-candles',
      strapline: 'Celebrating 60 Years of BNMS',
      html:
        P('In 2026, the British Nuclear Medicine Society proudly celebrates its 60th anniversary.') +
        P('Since its foundation in 1966, BNMS has supported the growth of nuclear medicine across the United Kingdom by bringing together healthcare professionals from every discipline, promoting education and research, developing professional standards and encouraging collaboration throughout the specialty.') +
        P('Over six decades, the Society has grown alongside remarkable advances in science, technology and patient care, while remaining committed to supporting the professionals who deliver nuclear medicine services every day.') +
        P('This anniversary provides an opportunity to celebrate our shared history, recognise those who have shaped the Society and look forward to the future of nuclear medicine.'),
      h: 460,
    },
    sections: [
      {
        type: 'feature',
        heading: 'Explore Our Interactive Timeline',
        html:
          P('Discover the people, milestones and achievements that have shaped BNMS over the past sixty years.') +
          P('Our interactive anniversary timeline brings together the Society\u2019s history in one place, including every BNMS President, Annual Meeting and many of the key moments that have influenced the development of nuclear medicine in the UK.') +
          P('Whether you have been part of BNMS for many years or are discovering the Society for the first time, we invite you to explore our journey from 1966 to today.'),
        cta: 'Launch the 60-Year Timeline',
        h: 340,
      },
      {
        type: 'cards',
        heading: 'Discover Our History',
        columns: 4,
        cardH: 360,
        cards: [
          {
            icon: 'fa-solid fa-book-open',
            heading: 'The Story of BNMS',
            body: P('Learn how the Society has evolved from its foundation in 1966 into the UK\u2019s professional society for nuclear medicine.'),
          },
          {
            icon: 'fa-solid fa-user-tie',
            heading: 'Past Presidents',
            body: P('Discover the individuals who have led BNMS over the past sixty years and helped shape the Society\u2019s direction.'),
          },
          {
            icon: 'fa-solid fa-calendar-days',
            heading: 'Annual Meetings',
            body: P('Explore the history of BNMS scientific meetings and conferences, bringing together professionals from across the nuclear medicine community for six decades.'),
          },
          {
            icon: 'fa-solid fa-flag-checkered',
            heading: 'Society Milestones',
            body: P('From major developments in nuclear medicine to significant achievements within BNMS, discover some of the milestones that have helped shape the specialty.'),
          },
        ],
      },
      {
        type: 'text',
        heading: 'Looking Back \u2014 Looking Forward',
        html:
          P('The history of BNMS is one of continuous progress.') +
          P('From advances in imaging technology and radiopharmaceuticals to the expansion of molecular radiotherapy and multidisciplinary working, nuclear medicine has transformed significantly over the past sixty years.') +
          P('BNMS has been proud to support these developments by promoting education, encouraging research, developing professional standards and bringing together professionals with a shared commitment to improving patient care.') +
          P('As we celebrate our past, we also look forward to the next generation of innovation, collaboration and scientific discovery.'),
        h: 440,
      },
      {
        type: 'text',
        heading: 'Preserving the Story of Nuclear Medicine',
        html:
          P('The history of the British Nuclear Medicine Society is closely linked with the evolution of nuclear medicine itself.') +
          P('Alongside our interactive timeline, the BNMS Historical Archive preserves articles, publications and historical documents that record the people, discoveries and innovations that have shaped the specialty over the past sixty years.') +
          P('These resources provide a valuable insight into the development of nuclear medicine in the United Kingdom and help ensure that the experiences of those who built the profession continue to inform and inspire future generations.'),
        h: 380,
      },
      {
        type: 'text',
        heading: 'Featured Historical Publication',
        html:
          P('<strong>Career Lifetime Advances in Nuclear Medicine</strong>') +
          P('By Dr Andrew Hilson') +
          P('A fascinating personal reflection on the remarkable development of nuclear medicine over more than four decades. Dr Andrew Hilson shares his experiences of the specialty\u2019s evolution, from the earliest isotope imaging techniques through to SPECT, PET/CT and the emergence of molecular imaging, offering a unique first-hand perspective on many of the advances that have transformed patient care.'),
        cta: 'Read Historical Article (PDF)',
        h: 360,
      },
      {
        type: 'feature',
        heading: 'Thank You to Our Members',
        html:
          P('Everything BNMS has achieved over the past sixty years has been made possible by the dedication, expertise and generosity of its members.') +
          P('Whether serving on Council or committees, presenting research, organising educational events, developing guidance, volunteering their time or supporting colleagues, generations of members have helped shape the Society we know today.') +
          P('On behalf of BNMS, thank you to everyone who has contributed to the Society\u2019s success over the past six decades.'),
        h: 340,
      },
      {
        type: 'cards',
        columns: 2,
        cardH: 320,
        cards: [
          {
            icon: 'fa-solid fa-users',
            heading: 'Meet the People Behind BNMS',
            body: P('Discover the Council, professional groups, regional representatives, honorary members, staff and volunteers who continue to support the Society today.'),
            cta: 'Meet Our People',
          },
          {
            icon: 'fa-solid fa-user-plus',
            heading: 'Be Part of the Next Chapter',
            body: P('Join the UK\u2019s professional society for nuclear medicine and help shape the future of the specialty.'),
            cta: 'Become a Member',
          },
        ],
      },
    ],
  }),
};

const TRAVELLING_FELLOWSHIPS_NEW = {
  tenantId: BNMS_TENANT_ID,
  slug: 'travelling-fellowships-new',
  title: 'BNMS Travelling Fellowship',
  design: buildDesign({
    hero: {
      headline: 'BNMS Travelling Fellowship',
      subheadline: 'Supporting members to learn, collaborate and share best practice across nuclear medicine.',
      ctaLabel: 'Apply for a Travelling Fellowship',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-plane-departure',
      strapline: 'Expanding Knowledge Through Experience',
      html:
        P('The BNMS Travelling Fellowship Scheme supports junior members wishing to visit centres of excellence within the United Kingdom or overseas.') +
        P('The fellowship encourages members to develop specialist knowledge, gain practical experience and bring new ideas back to their own departments, helping to strengthen nuclear medicine services across the UK.') +
        P('Funding of up to \u00a31,000 is available each year for successful applicants.'),
      h: 340,
    },
    sections: [
      {
        type: 'text',
        heading: 'A Fellowship with a Long History',
        html:
          P('The BNMS Travelling Fellowship was established in 1983, following a decision by BNMS Council to invest in the professional development of members and support the advancement of nuclear medicine.') +
          P('For more than forty years, the Fellowship has enabled clinicians, scientists, technologists, radiographers, nurses and pharmacists to visit centres of excellence across the UK and internationally, gaining new skills, building professional networks and bringing innovative practice back to their own departments.') +
          P('Today, the Fellowship remains an important part of the Society\u2019s commitment to education, collaboration and professional development.'),
        h: 380,
      },
      {
        type: 'text',
        heading: 'Fellowship Information',
        html:
          P('<strong>Who Can Apply?</strong>') +
          P('Applications are open to junior members from all disciplines within nuclear medicine who:') +
          `<ul>${
            LI('Have been Full Members of BNMS for at least one year') +
            LI('Have paid the required annual membership subscription') +
            LI('Can demonstrate a genuine interest in the proposed area of study')
          }</ul>` +
          P('Particular consideration is given to applicants who can demonstrate an established interest in their chosen subject area.') +
          P('<strong>Eligible Applicants</strong>') +
          P('The fellowship is open to:') +
          `<ul>${
            LI('Medical staff who do not hold consultant or equivalent appointments') +
            LI('Clinical Scientists at NHS Band 7 equivalent or below') +
            LI('Academic staff at NHS Band 7 equivalent or below') +
            LI('Pharmacists at NHS Band 7 equivalent or below') +
            LI('Technologists, Radiographers and Nurses at any grade')
          }</ul>`,
        bullets: true,
        h: 680,
      },
      {
        type: 'text',
        heading: 'Applying for a Fellowship',
        html:
          P('<strong>Before You Apply</strong>') +
          P('Applications should include:') +
          `<ul>${
            LI('A one-page summary describing the proposed visit') +
            LI('Expected learning outcomes') +
            LI('A breakdown and justification of the costs requested') +
            LI('A letter of support from your Head of Department or senior colleague') +
            LI('Confirmation from the host department that the visit has been agreed')
          }</ul>` +
          P('<strong>Fellowship Recipients</strong>') +
          P('Successful applicants are expected to:') +
          `<ul>${
            LI('Undertake the approved visit') +
            LI('Share their experience with the wider BNMS community') +
            LI('Present their learning at a future BNMS Spring Meeting')
          }</ul>` +
          P('Fellowships are awarded by BNMS Council and announced at the Annual General Meeting.'),
        bullets: true,
        h: 660,
      },
      {
        type: 'text',
        heading: 'Previous Fellowship Recipients',
        html:
          P('Since its introduction in 1983, the BNMS Travelling Fellowship has supported members from across the nuclear medicine community in developing their knowledge and skills through educational visits in the UK and overseas.') +
          P('Explore previous recipients and discover the wide range of specialist centres, research programmes and educational opportunities supported by the Fellowship over more than four decades.'),
        cta: 'Previous Fellowship Recipients',
        h: 300,
      },
      {
        type: 'feature',
        heading: 'Develop Your Career',
        html:
          P('The BNMS Travelling Fellowship provides an opportunity to gain specialist experience, build professional networks and contribute to the continued advancement of nuclear medicine.') +
          P('For further information, please contact the BNMS office:') +
          P('<strong>secretary@bnms.org.uk</strong>'),
        cta: 'Apply for a Travelling Fellowship',
        h: 320,
      },
    ],
  }),
};

// ---------------------------------------------------------------------------
// In Memoriam biography pages. Two doc formats:
//   Format A (H1/H2/Primary CTA markers): hero + "Remembering X" intro + headed
//     biographical sections (some with bulleted lists) + "Back to In Memoriam" CTA.
//   Format B (plain): hero (name + dates/role subtitle) + flowing body + a final
//     recognition/contributions bulleted list. No CTA (doc specifies none).
// Meta labels ("H1", "H2", "Primary CTA") are instructions -> omitted/interpreted.
// ---------------------------------------------------------------------------
const B = (arr) => arr.map(P).join('');
const UL = (arr) => `<ul>${arr.map(LI).join('')}</ul>`;

function bodyHeight(html) {
  const blocks = String(html)
    .split(/<\/(?:p|li)>/i)
    .map((s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let h = 40;
  for (const b of blocks) h += Math.max(1, Math.ceil(b.length / 80)) * 34 + 20;
  return Math.round(h);
}

function memoriam({ slug, title, headline, subheadline, cta, introStrapline, intro, sections }) {
  const spec = {
    hero: { headline, subheadline, ctaLabel: cta || '', bgImageUrl: HERO_IMG_OPEN },
    sections: sections.map((s) => ({
      type: s.type || 'text',
      heading: s.heading,
      html: s.html,
      bullets: !!s.bullets,
      h: bodyHeight(s.html),
    })),
  };
  if (intro && intro.length) {
    const html = B(intro);
    spec.intro = { icon: 'fa-solid fa-ribbon', strapline: introStrapline, html, h: bodyHeight(html) };
  }
  return { tenantId: BNMS_TENANT_ID, slug, title, design: buildDesign(spec) };
}

const MALLARD_NEW = memoriam({
  slug: 'professor-john-mallard-obe-frse-freng-new',
  title: 'Professor John Mallard OBE FRSE FREng',
  headline: 'Professor John Mallard OBE FRSE FREng',
  subheadline: '1927\u20132021 \u2014 Medical imaging pioneer, Honorary Member of the British Nuclear Medicine Society and recipient of the BNMS Norman Veall Medal',
  sections: [
    {
      html: B([
        'Professor John Mallard was one of the world\u2019s great pioneers in medical imaging, whose work transformed the diagnosis and treatment of disease and influenced generations of scientists, clinicians and researchers.',
        'Throughout a distinguished career spanning more than five decades, Professor Mallard helped shape the development of modern medical imaging, making an extraordinary contribution to both nuclear medicine and the wider field of healthcare.',
        'His research and innovation played a significant role in the advancement of imaging technologies that continue to benefit millions of patients around the world today.',
        'Professor Mallard was a longstanding supporter of the British Nuclear Medicine Society and was recognised as an Honorary Member of the Society. In recognition of his exceptional contribution to clinical science and nuclear medicine, he was also awarded the prestigious BNMS Norman Veall Medal, honouring individuals who have made an outstanding contribution to the science and practice of nuclear medicine in the United Kingdom.',
        'Beyond his remarkable scientific achievements, colleagues remember Professor Mallard for his generosity, enthusiasm and willingness to encourage future generations of researchers and healthcare professionals. His vision, leadership and commitment to innovation helped establish the United Kingdom as an international leader in medical imaging.',
        'The British Nuclear Medicine Society remembers Professor John Mallard with profound gratitude. His legacy continues through the advances in medical imaging that he helped pioneer and through the countless professionals whose careers were inspired by his work.',
      ]),
    },
    {
      heading: 'Honours and Recognition',
      html: UL([
        'Honorary Member of the British Nuclear Medicine Society',
        'Recipient of the BNMS Norman Veall Medal',
        'Pioneer of modern medical imaging',
        'Internationally recognised scientist and innovator',
      ]),
      bullets: true,
    },
  ],
});

const FOGELMAN_NEW = memoriam({
  slug: 'professor-ignac-fogelman-new',
  title: 'Professor Ignac Fogelman',
  headline: 'Professor Ignac Fogelman',
  subheadline: '1948\u20132016 \u2014 Professor of Nuclear Medicine, teacher, mentor and internationally recognised pioneer in radionuclide bone imaging.',
  cta: 'Back to In Memoriam',
  introStrapline: 'Remembering Professor Ignac Fogelman',
  intro: [
    'Professor Ignac Fogelman was one of the world\u2019s leading figures in nuclear medicine, whose passion for education, research and patient care transformed the specialty both in the United Kingdom and internationally.',
    'Respected by colleagues across the globe, Ignac combined scientific excellence with warmth, generosity and an infectious enthusiasm for learning. As a teacher, mentor and friend, he inspired generations of clinicians, scientists and researchers, leaving an extraordinary legacy that continues to influence nuclear medicine today.',
    'He is remembered with immense affection and gratitude by the British Nuclear Medicine Society and the international nuclear medicine community.',
  ],
  sections: [
    {
      heading: 'Early Career',
      html: B([
        'Born on 4 September 1948, Ignac completed his medical training at the Glasgow Royal Infirmary, where he developed a lifelong interest in metabolic bone disease while working with Dr Iain Boyle and Dr Rodney Bessent.',
        'At a time when technetium-labelled bone imaging agents were beginning to transform clinical practice, he recognised the enormous potential of nuclear medicine in understanding bone metabolism and disease. This work led to his first scientific publications and the completion of his MD.',
      ]),
    },
    {
      heading: 'Advancing Nuclear Medicine',
      html: B([
        'In 1983, Ignac was appointed Consultant Physician in Nuclear Medicine at Guy\u2019s Hospital, providing the opportunity to expand his research into bone imaging and osteoporosis.',
        'His work helped establish radionuclide bone imaging as an essential diagnostic tool and contributed significantly to improving the understanding and management of metabolic bone disease.',
        'In 1988, he was instrumental in establishing the first osteoporosis screening service in the United Kingdom, initially using dual-photon absorptiometry before introducing one of the country\u2019s first DXA systems.',
        'He also pioneered the use of positron emission tomography (PET) in the study of osteoporosis and regional bone turnover.',
      ]),
    },
    {
      heading: 'Teacher, Author and Mentor',
      html: B([
        'Education was central to Ignac\u2019s career.',
        'In 1996, he became Professor of Nuclear Medicine and went on to supervise at least 17 PhD and MD students, many of whom have themselves become leaders within the specialty.',
        'As Chairman of the Board of Examiners for the MSc in Nuclear Medicine at King\u2019s College London, he helped educate generations of nuclear medicine professionals.',
        'His contribution to medical literature was equally remarkable.',
        'He wrote or edited 15 books, many of which became internationally recognised reference texts. His best-known publication, the Atlas of Clinical Nuclear Medicine, remains a standard reference in nuclear medicine departments around the world and is regarded by many as an essential textbook.',
      ]),
    },
    {
      heading: 'International Recognition',
      html:
        B([
          'Throughout his career, Ignac received numerous honours recognising his outstanding contribution to nuclear medicine.',
          'Among them were:',
        ]) +
        UL([
          'Vikram Sarabhai Oration Award from the Society of Nuclear Medicine of India (2005)',
          'Sir Godfrey Hounsfield Memorial Award from the British Institute of Radiology (2014)',
          'Dent Lecture presented for the Bone Research Society (2015) in recognition of his outstanding contribution to musculoskeletal research',
        ]) +
        B(['These awards reflected the international respect he earned through decades of clinical excellence, research and education.']),
      bullets: true,
    },
    {
      heading: 'A Life Beyond Medicine',
      html:
        B([
          'Although deeply committed to his profession, Ignac embraced life with equal enthusiasm outside work.',
          'He enjoyed:',
        ]) +
        UL(['Theatre', 'Opera', 'Music', 'Literature', 'Travel', 'Fine food and wine', 'Bridge']) +
        B([
          'He maintained close friendships with colleagues across the world, regularly corresponding with friends and collaborators long after projects had ended.',
          'His curiosity, humour and generosity made him not only an exceptional physician but also a treasured friend to many.',
        ]),
      bullets: true,
    },
    {
      heading: 'An Enduring Legacy',
      html: B([
        'Many colleagues affectionately described Ignac as the "Father of Radionuclide Bone Imaging."',
        'Others referred to him as the "Pope of Radionuclide Bone Imaging" in recognition of his unparalleled expertise and lifelong dedication to advancing the field.',
        'His influence can be seen not only in his research and publications, but also in the countless professionals he taught, mentored and inspired throughout his career.',
        'His passion for excellence, intellectual curiosity and commitment to patient care continue to shape nuclear medicine today.',
      ]),
    },
    {
      heading: 'Remembered by Colleagues Around the World',
      html:
        B([
          'Following his passing in July 2016, tributes were received from colleagues across the international nuclear medicine community.',
          'Many spoke not only of his exceptional scientific achievements but also of his kindness, friendship and generosity.',
          'He was remembered as:',
        ]) +
        UL(['An inspiring teacher', 'A trusted mentor', 'A gifted researcher', 'A loyal friend', 'A true gentleman']) +
        B(['His legacy lives on through the people he taught, the services he helped develop and the patients whose lives have benefited from his work.']),
      bullets: true,
    },
    {
      heading: 'A Lasting Tribute',
      html: B([
        'Professor Ignac Fogelman devoted his life to advancing nuclear medicine through innovation, education and collaboration.',
        'His influence extended far beyond his own department, shaping clinical practice, research and education across the world.',
        'The British Nuclear Medicine Society remembers Ignac with profound respect and gratitude for his extraordinary contribution to the specialty and to the many colleagues whose careers he helped shape.',
        'He is survived by his wife Coral, his children Gayle and Richard, and his grandchildren, of whom he was immensely proud.',
      ]),
    },
  ],
});

const TESTA_NEW = memoriam({
  slug: 'professor-h-j-tito-testa-new',
  title: 'Professor H. J. "Tito" Testa',
  headline: 'Professor H. J. "Tito" Testa',
  subheadline: 'Consultant Nuclear Medicine Physician, Honorary Member of the British Nuclear Medicine Society',
  sections: [
    {
      html: B([
        'Professor H. J. "Tito" Testa was a highly respected Consultant Nuclear Medicine Physician whose contribution to nuclear medicine, medical education and the British Nuclear Medicine Society spanned almost five decades.',
        'Born and trained in Argentina, Tito brought his expertise and enthusiasm for nuclear medicine to the United Kingdom, where he became Consultant Nuclear Medicine Physician at Manchester Royal Infirmary, serving patients and colleagues with distinction for more than 25 years.',
        'Throughout his career he combined clinical excellence with a passion for education, helping to advance nuclear medicine services while supporting and mentoring countless healthcare professionals.',
        'Tito was a dedicated member of the British Nuclear Medicine Society for almost fifty years and was recognised with Honorary Membership in acknowledgement of his outstanding contribution to the Society and to the specialty.',
        'Colleagues remember Tito not only for his knowledge and professional leadership but also for his warmth, generosity and friendship. He was always willing to share his experience, encourage others and contribute positively to the nuclear medicine community.',
        'His influence extended far beyond his own department, and his commitment to collaboration and education helped strengthen the specialty throughout the United Kingdom.',
        'The British Nuclear Medicine Society remembers Professor Tito Testa with gratitude and affection. His dedication, kindness and professionalism continue to inspire colleagues, and his contribution to nuclear medicine will be remembered for many years to come.',
      ]),
    },
    {
      heading: 'BNMS Recognition',
      html: UL([
        'Honorary Member of the British Nuclear Medicine Society',
        'Nearly 50 years of membership and service to the Society',
        'Consultant Nuclear Medicine Physician, Manchester Royal Infirmary',
      ]),
      bullets: true,
    },
  ],
});

const WILLIAMS_NEW = memoriam({
  slug: 'professor-edward-sydney-williams-new',
  title: 'Professor Edward Sydney Williams',
  headline: 'Professor Edward Sydney Williams',
  subheadline: '1923\u20132015 \u2014 Nuclear medicine pioneer, educator, researcher and former Director of the Institute of Nuclear Medicine',
  sections: [
    {
      html: B([
        'Professor Edward Sydney Williams was one of the founding pioneers of nuclear medicine in the United Kingdom, whose vision, leadership and commitment to education helped establish the specialty during its formative years.',
        'Throughout his distinguished career, Professor Williams played a significant role in advancing both the science and clinical practice of nuclear medicine. As an educator, researcher and clinical leader, he inspired generations of healthcare professionals and contributed to the development of services that have benefited countless patients.',
        'As Director of the Institute of Nuclear Medicine, he helped build one of the country\u2019s leading centres for nuclear medicine, supporting innovation, education and research at a time when the specialty was rapidly evolving.',
        'Professor Williams was widely respected for his ability to combine scientific excellence with a passion for teaching. His influence extended well beyond his own department, helping to shape the education and professional development of many clinicians, scientists and technologists who went on to make important contributions of their own.',
        'His work helped establish the strong foundations upon which modern nuclear medicine continues to develop today.',
        'The British Nuclear Medicine Society remembers Professor Edward Sydney Williams with gratitude and respect, recognising his outstanding contribution to the advancement of nuclear medicine and the lasting legacy he leaves to the profession.',
      ]),
    },
    {
      heading: 'Professional Contributions',
      html: UL([
        'Former Director of the Institute of Nuclear Medicine',
        'Pioneer of British nuclear medicine',
        'Respected educator and researcher',
        'Influential clinical leader',
        'Mentor to generations of nuclear medicine professionals',
      ]),
      bullets: true,
    },
  ],
});

const CRANE_NEW = memoriam({
  slug: 'ingrid-crane-new',
  title: 'Ingrid Crane',
  headline: 'Ingrid Crane',
  subheadline: '1935\u20132011 \u2014 Founder of the BNMS Nurses\u2019 Group and pioneer of nuclear medicine nursing in the United Kingdom.',
  cta: 'Back to In Memoriam',
  introStrapline: 'Remembering Ingrid Crane',
  intro: [
    'Ingrid Crane was a pioneering nuclear medicine nurse whose vision, dedication and compassion transformed the role of nursing within nuclear medicine.',
    'She is best remembered as the founder of what is now the BNMS Nurses\u2019 Group, creating a professional community that has supported, educated and inspired generations of nuclear medicine nurses.',
    'Throughout her distinguished career, Ingrid championed education, patient care and multidisciplinary working, helping establish nursing as an integral part of modern nuclear medicine services.',
    'Her influence continues to be felt throughout the profession, and the British Nuclear Medicine Society remembers her with great affection and gratitude.',
  ],
  sections: [
    {
      heading: 'Early Life and Career',
      html:
        B([
          'Born in southern Sweden in May 1935, Ingrid trained as a nurse in Stockholm before embarking on an international career that reflected both her adventurous spirit and her passion for healthcare.',
          'Her professional journey took her to several countries, including:',
        ]) +
        UL(['Sweden', 'T\u00fcrkiye', 'United States', 'Germany', 'United Kingdom']) +
        B([
          'Fluent in several languages and committed to lifelong learning, Ingrid brought a wealth of international experience to every role she undertook.',
          'Eventually settling in England, she joined St Thomas\u2019 Hospital, where she worked in the Nuclear Medicine Department for 17 years.',
        ]),
      bullets: true,
    },
    {
      heading: 'A Pioneer for Nuclear Medicine Nursing',
      html: B([
        'At a time when the role of nurses within nuclear medicine was still developing, Ingrid recognised the need for greater professional support, education and collaboration.',
        'Her determination and leadership led to the establishment of the Nuclear Medicine Nurses Association, which has since evolved into today\u2019s BNMS Nurses\u2019 Group.',
        'This achievement created a lasting professional network for nurses working in nuclear medicine and helped ensure that nursing became fully recognised as an essential part of multidisciplinary patient care.',
        'Her contribution continues to benefit nurses throughout the United Kingdom.',
      ]),
    },
    {
      heading: 'Championing Education',
      html: B([
        'Education was one of Ingrid\u2019s greatest passions.',
        'She founded the Nuclear Medicine Course on Radiation and Safety for nurses, providing specialist education for those caring for patients receiving radionuclide therapies.',
        'The programme was later adopted by the English National Board for Nursing, becoming the nationally recognised ENB N10 \u2013 Caring for Patients Receiving Radionuclides.',
        'Although the course eventually closed due to declining student numbers, many colleagues still regard it as one of the most important educational programmes ever developed for nuclear medicine nursing.',
        'Its influence can still be seen in the education and professional standards expected of nuclear medicine nurses today.',
      ]),
    },
    {
      heading: 'Research and Professional Leadership',
      html: B([
        'Alongside her clinical work, Ingrid contributed to numerous research publications and remained actively involved in advancing nursing practice within nuclear medicine.',
        'She became the Founder and later President of the Nuclear Medicine Nurses Association, providing leadership, encouragement and mentorship to colleagues across the UK.',
        'She delivered her final lecture at the BNMS Annual Meeting in Harrogate in 2010, continuing to inspire others almost until the end of her life.',
      ]),
    },
    {
      heading: 'A Lasting Legacy',
      html: B([
        'Ingrid combined professional excellence with kindness, humility and an unwavering commitment to patients.',
        'Those who worked alongside her remember not only her knowledge and leadership but also her generosity, encouragement and genuine care for others.',
        'Her vision helped establish a professional home for nuclear medicine nurses and strengthened the multidisciplinary culture that remains central to BNMS today.',
        'Every nurse who has benefited from the BNMS Nurses\u2019 Group continues to build upon the foundations that Ingrid created.',
      ]),
    },
    {
      heading: 'Remembered with Gratitude',
      html:
        B([
          'Ingrid is remembered with great affection by colleagues throughout the British Nuclear Medicine Society and the wider nuclear medicine community.',
          'She is survived by:',
        ]) +
        UL([
          'Her husband, Richard, whom she described as "my rock"',
          'Her children, Ayse and Mehmet',
          'Her grandchildren, Gemma, Leila, Charley and Max, of whom she was immensely proud',
          'Her brother and niece, Marie',
        ]) +
        B(['Her contribution to nuclear medicine nursing continues to inspire future generations, and her legacy lives on through the BNMS Nurses\u2019 Group she founded.']),
      bullets: true,
    },
  ],
});

const GIMLETTE_NEW = memoriam({
  slug: 'dr-t-m-d-tim-gimlette-new',
  title: 'Dr T. M. D. "Tim" Gimlette',
  headline: 'Dr T. M. D. "Tim" Gimlette',
  subheadline: '1927\u20132019 \u2014 Founding member, former President of the British Nuclear Medicine Society and one of the pioneers of nuclear medicine in the United Kingdom.',
  cta: 'Back to In Memoriam',
  introStrapline: 'Remembering Dr Tim Gimlette',
  intro: [
    'Dr Thomas Michael Desmond "Tim" Gimlette was one of the pioneers of British nuclear medicine and a founding member of the British Nuclear Medicine Society.',
    'Throughout his distinguished career, Tim combined clinical excellence, scientific curiosity and an enduring sense of humour. His contribution to the development of nuclear medicine helped shape the specialty during its formative years, while his leadership within BNMS left a lasting legacy for future generations.',
    'Today, we remember Tim with gratitude for his vision, dedication and friendship, and celebrate the remarkable contribution he made to nuclear medicine in the United Kingdom.',
  ],
  sections: [
    {
      heading: 'Early Life',
      html: B([
        'Thomas Michael Desmond Gimlette was born on 7 January 1927 in Wiesbaden, Germany, where his father, also a physician, was serving with the Army of Occupation.',
        'When he was two years old, his family moved to India, a country he remained deeply fond of throughout his life despite childhood adventures that included dysentery, encounters with leopards and, as he would later recall with characteristic humour, being expelled from nursery school for disobedience.',
      ]),
    },
    {
      heading: 'A Pioneer of Nuclear Medicine',
      html: B([
        'In 1960, Tim was appointed to lead the Isotope Department at St Thomas\u2019 Hospital.',
        'Working with a small, largely self-taught team in modest accommodation, he helped establish one of the earliest nuclear medicine services in the country. It was during this period that technetium-based imaging was beginning to transform clinical practice.',
        'Reflecting on those early years, Tim later wrote:',
        '"What we were doing might be compared to prehistoric cave paintings, but less beautiful perhaps."',
        'Although spoken with typical humility, these early developments helped lay the foundations of modern nuclear medicine.',
      ]),
    },
    {
      heading: 'Founding the British Nuclear Medicine Society',
      html: B([
        'Tim worked alongside many of the pioneers of British medical imaging, including Professor John Mallard, whose work contributed to the development of magnetic resonance imaging, and Professor Ian Donald, recognised for his pioneering work in medical ultrasound.',
        'In 1966, Tim joined colleagues in founding the British Nuclear Medicine Society, helping create the professional organisation that continues to support nuclear medicine professionals across the United Kingdom today.',
        'This was a defining moment in the history of British nuclear medicine, and Tim remained closely associated with the Society throughout his career, later serving as President of BNMS.',
      ]),
    },
    {
      heading: 'Leadership and Clinical Career',
      html:
        B([
          'Also in 1966, Tim was appointed Physician in Nuclear Medicine in Liverpool, where he established a thriving department with excellent facilities and opportunities for both clinical practice and research.',
          'His department supported developments in:',
        ]) +
        UL(['In vivo imaging', 'In vitro diagnostic techniques', 'Whole-body counting', 'Clinical nuclear medicine research']) +
        B([
          'In 1973 he became a Fellow of the Royal College of Physicians, and in 1974 he was elected President of the British Nuclear Medicine Society.',
          'Towards the end of his NHS career he served as Chairman of the Regional Scientific Committee before retiring in 1989.',
        ]),
      bullets: true,
    },
    {
      heading: 'Beyond Nuclear Medicine',
      html:
        B([
          'Tim was remembered not only for his professional achievements but also for his kindness, modesty and humour.',
          'In retirement he enjoyed:',
        ]) +
        UL(['Travelling', 'Painting', 'Conservation']) +
        B([
          'One of his proudest personal achievements was creating a woodland in Cheshire, planting more than 2,000 trees himself.',
          'He married Ruth Curwen in 1957, who sadly predeceased him.',
          'He is survived by their daughter and three sons.',
        ]),
      bullets: true,
    },
    {
      heading: 'A Lasting Legacy',
      html: B([
        'Tim Gimlette helped shape the foundations of British nuclear medicine during a period of extraordinary innovation.',
        'As a clinician, teacher, leader and founding member of the British Nuclear Medicine Society, his influence extended far beyond his own department. His work helped establish the specialty, while his leadership and generosity inspired colleagues across the profession.',
        'His legacy continues through the Society he helped found and through the generations of professionals who have benefited from his vision and dedication.',
      ]),
    },
  ],
});

const BAYLY_NEW = memoriam({
  slug: 'dr-russell-bayly-new',
  title: 'Dr Russell Bayly',
  headline: 'Dr Russell Bayly',
  subheadline: '1924\u20132014 \u2014 Scientist, innovator and early supporter of British nuclear medicine and radiopharmaceutical development',
  sections: [
    {
      html: B([
        'Dr Russell Bayly was one of the early pioneers whose scientific expertise and innovation helped support the development of nuclear medicine and radiopharmaceutical science in the United Kingdom.',
        'Throughout his career, Dr Bayly contributed to a period of rapid scientific progress, helping to advance the understanding and application of radiopharmaceuticals at a time when nuclear medicine was establishing itself as a recognised medical specialty.',
        'His work reflected a commitment to scientific excellence, innovation and collaboration, supporting the development of techniques and technologies that would ultimately improve patient diagnosis and treatment.',
        'As one of the early contributors to British nuclear medicine, Dr Bayly played an important role in helping build the strong scientific foundations upon which today\u2019s specialty continues to develop. His contribution to radiopharmaceutical science and the wider nuclear medicine community remains an important part of the history of the profession.',
        'Colleagues remember Dr Bayly as a dedicated scientist whose work helped shape the future of nuclear medicine through research, innovation and professional collaboration.',
        'The British Nuclear Medicine Society remembers Dr Russell Bayly with gratitude and respect, recognising his lasting contribution to British nuclear medicine and the advancement of radiopharmaceutical science.',
      ]),
    },
    {
      heading: 'Professional Contributions',
      html: UL([
        'Early pioneer of British nuclear medicine',
        'Contributed to the development of radiopharmaceutical science',
        'Respected scientist and innovator',
        'Helped establish the scientific foundations of modern nuclear medicine',
      ]),
      bullets: true,
    },
  ],
});

const BUXTON_THOMAS_NEW = memoriam({
  slug: 'dr-muriel-buxton-thomas-new',
  title: 'Dr Muriel Buxton-Thomas',
  headline: 'Dr Muriel Buxton-Thomas',
  subheadline: '1945\u20132016 \u2014 Internationally recognised Nuclear Medicine Physician, clinician, researcher and leader in diagnostic and therapeutic nuclear medicine.',
  sections: [
    {
      html: B([
        'Dr Muriel Simisola Buxton-Thomas, affectionately known to many colleagues as MBT, was an internationally respected Nuclear Medicine Physician whose leadership, clinical expertise and commitment to patient care made a lasting impact on nuclear medicine in the United Kingdom.',
        'Throughout her distinguished career, Muriel combined academic excellence with an unwavering dedication to developing high-quality clinical services. Her work helped shape the delivery of modern nuclear medicine and established new standards of care for patients across a wide range of specialist services.',
        'After qualifying in Newcastle upon Tyne in 1971, she undertook specialist training in both medicine and nuclear medicine, gaining an MSc in Nuclear Medicine in 1978 before becoming a Senior Registrar at Addenbrooke\u2019s Hospital during the early 1980s.',
        'Muriel served as Consultant Physician in Nuclear Medicine at St Thomas\u2019 Hospital and Medway Hospital before her appointment as Clinical Director of Nuclear Medicine at King\u2019s College Hospital.',
        'During her time at King\u2019s she played a pivotal role in developing both diagnostic and therapeutic nuclear medicine services. She oversaw the relocation of the department to the Golden Jubilee Wing and led the installation of one of the first PET-capable gamma cameras in England, helping position the department at the forefront of clinical innovation.',
        'Alongside her clinical work, Muriel held specialist clinics in endocrine medicine, oncology and osteoporosis, while also serving on numerous hospital committees and undertaking important national roles for both the Department of Health and ARSAC.',
        'Following her retirement from King\u2019s College Hospital in 2010, Muriel continued to support colleagues at Guy\u2019s and St Thomas\u2019 NHS Foundation Trust and City Hospital Birmingham, where she helped establish the local neuroendocrine tumour (NET) therapy service.',
        'Colleagues remember Muriel as a determined and highly respected clinician who was always prepared to champion the very best standards of patient care. Her professionalism, leadership and commitment to the specialty earned her admiration throughout the nuclear medicine community.',
        'The British Nuclear Medicine Society remembers Dr Muriel Buxton-Thomas with gratitude and respect, recognising her lasting contribution to clinical nuclear medicine, education and the patients whose lives she helped improve.',
      ]),
    },
    {
      heading: 'Professional Contributions',
      html: UL([
        'Clinical Director of Nuclear Medicine, King\u2019s College Hospital',
        'Consultant Physician in Nuclear Medicine',
        'National roles with the Department of Health and ARSAC',
        'Pioneer in developing modern diagnostic and therapeutic nuclear medicine services',
        'Helped establish one of England\u2019s earliest PET-capable nuclear medicine departments',
      ]),
      bullets: true,
    },
  ],
});

const HARDING_NEW = memoriam({
  slug: 'dr-leslie-keith-harding-new',
  title: 'Dr Leslie Keith Harding',
  headline: 'Dr Leslie Keith Harding',
  subheadline: '1939\u20132023 \u2014 Past President, Treasurer and recipient of the BNMS President\u2019s Medal',
  sections: [
    {
      html: B([
        'Dr Leslie Keith Harding made an outstanding contribution to the British Nuclear Medicine Society through many years of dedicated service and leadership.',
        'Throughout his career, Leslie was recognised not only for his expertise in nuclear medicine but also for his commitment to supporting colleagues and helping guide the Society through periods of growth and change. His thoughtful leadership and willingness to give his time generously earned him the respect and friendship of many across the profession.',
        'Leslie served the Society with distinction as both Treasurer and later President, helping strengthen the British Nuclear Medicine Society and supporting its continued development as the professional home for nuclear medicine in the United Kingdom.',
        'In recognition of his exceptional contribution to both the Society and the wider specialty, he was awarded the BNMS President\u2019s Medal in 2016\u2014one of the Society\u2019s highest honours.',
        'Those who worked alongside Leslie remember his professionalism, integrity and quiet determination. He believed strongly in supporting multidisciplinary nuclear medicine and was always willing to share his knowledge and experience for the benefit of colleagues and patients alike.',
        'His contribution to BNMS extended far beyond the offices he held. Through his leadership, encouragement and commitment to the profession, he helped shape the Society that continues to support nuclear medicine professionals today.',
        'The British Nuclear Medicine Society remembers Dr Leslie Keith Harding with gratitude, respect and affection, and honours the lasting legacy he leaves to both the Society and the wider nuclear medicine community.',
      ]),
    },
  ],
});

const GEMMELL_NEW = memoriam({
  slug: 'dr-howard-gemmell-new',
  title: 'Dr Howard Gemmell',
  headline: 'Dr Howard Gemmell',
  subheadline: '1949\u20132022 \u2014 Pioneer in nuclear medicine, educator, researcher and long-standing supporter of the British Nuclear Medicine Society.',
  cta: 'Back to In Memoriam',
  introStrapline: 'Remembering Dr Howard Gemmell',
  intro: [
    'Dr Howard Gemmell dedicated his career to advancing nuclear medicine through clinical excellence, research, education and leadership.',
    'Throughout more than four decades in the specialty, he inspired colleagues, mentored future generations of healthcare professionals and helped shape nuclear medicine services in Scotland and across the United Kingdom.',
    'Howard is remembered not only for his professional achievements, but also for his resilience, generosity, humour and unwavering commitment to patients and colleagues.',
  ],
  sections: [
    {
      heading: 'Early Career',
      html: B([
        'Howard graduated from the University of Glasgow in 1971 before completing an MSc in Medical Physics in 1972 and a PhD in Ultrasound in 1978 at the University of Aberdeen.',
        'He began his career in nuclear medicine in Aberdeen and was appointed Head of Nuclear Medicine at Aberdeen Royal Infirmary in 1991.',
        'Throughout his career he combined clinical practice with research, education and service development, helping establish Aberdeen as a centre of excellence in nuclear medicine.',
      ]),
    },
    {
      heading: 'Leadership in Nuclear Medicine',
      html:
        B([
          'Howard led the department through a period of significant change within both the NHS and higher education.',
          'During his leadership he successfully navigated:',
        ]) +
        UL([
          'The transition from a university unit into the NHS',
          'NHS Trust reorganisation',
          'Scottish devolution',
          'National workforce and policy changes',
          'Continued expansion of nuclear medicine services',
        ]) +
        B(['His calm leadership, strategic thinking and ability to bring people together earned him enormous respect from colleagues throughout the profession.']),
      bullets: true,
    },
    {
      heading: 'Research and Innovation',
      html: B([
        'Howard was recognised internationally as one of the pioneers of SPECT imaging.',
        'Among his many achievements was the first demonstration of a SPECT imaging agent capable of differentiating between forms of dementia, published in The Lancet in 1984.',
        'His commitment to innovation extended throughout his career and was reflected in his approach to both research and clinical service development.',
        'He believed that research should directly improve patient care and encouraged those around him to continually seek new ways to develop nuclear medicine services.',
      ]),
    },
    {
      heading: 'Teacher and Mentor',
      html: B([
        'Education was one of Howard\u2019s greatest passions.',
        'For more than thirty years, he lectured on the internationally recognised MSc in Medical Physics at the University of Aberdeen, inspiring countless students and supervising numerous PhD researchers.',
        'Many of those he taught have gone on to lead nuclear medicine departments throughout the United Kingdom and internationally.',
        'His influence therefore extended far beyond his own department, helping shape future generations of nuclear medicine professionals.',
      ]),
    },
    {
      heading: 'Service to the Profession',
      html: B([
        'Howard made an outstanding contribution to the wider nuclear medicine community.',
        'He served on committees within both the British Nuclear Medicine Society and the Institute of Physics and Engineering in Medicine, while also contributing to the editorial board of Physics in Medicine and Biology.',
        'He played an important role in establishing the national PET/CT service in Scotland, serving on its steering committee for many years and helping develop services that continue to benefit patients today.',
        'Howard also co-edited the widely respected textbook:',
        'A Practical Guide to Nuclear Medicine',
        'Affectionately known by many professionals as the "Pink Book", it remains an important reference for practitioners.',
      ]),
    },
    {
      heading: 'A Life Beyond Medicine',
      html: B([
        'Howard approached life with the same enthusiasm that characterised his professional career.',
        'Following retirement, he became an active patient advocate, contributing to a range of health and social care committees.',
        'Outside medicine he had a lifelong interest in politics, serving the Labour Party in a variety of roles over more than thirty years.',
        'Music was another great passion. He helped establish an independent record label in Aberdeen and was known for his encyclopaedic knowledge of music across many genres.',
      ]),
    },
    {
      heading: 'Courage and Character',
      html: B([
        'Howard faced significant personal health challenges throughout his life with remarkable courage.',
        'Diagnosed with multiple sclerosis during the 1980s, he rarely allowed it to define him. On the day he retired from the NHS, he quietly remarked that he had "not missed a day of work because of it."',
        'That determination, resilience and optimism became hallmarks of his career and inspired everyone who worked alongside him.',
      ]),
    },
    {
      heading: 'A Lasting Legacy',
      html: B([
        'Howard Gemmell leaves behind an extraordinary legacy of leadership, innovation and education.',
        'His contributions helped advance nuclear medicine services, influenced clinical practice, inspired generations of professionals and improved the lives of countless patients.',
        'Above all, he is remembered as a trusted colleague, gifted teacher, respected leader and valued friend whose impact on nuclear medicine will continue for many years to come.',
        'He is survived by his wife, Barbara, and is remembered with affection, gratitude and respect by colleagues throughout the United Kingdom and beyond.',
      ]),
    },
  ],
});

const CROFT_NEW = memoriam({
  slug: 'dr-desmond-croft-new',
  title: 'Dr Desmond Croft',
  headline: 'Dr Desmond Croft',
  subheadline: 'Founder Member and Former President of the British Nuclear Medicine Society \u2014 Pioneer of British nuclear medicine and one of the founding figures of the British Nuclear Medicine Society',
  sections: [
    {
      html: B([
        'Dr Desmond Croft played a pivotal role in the establishment and development of nuclear medicine in the United Kingdom.',
        'As a Founder Member of the British Nuclear Medicine Society and later President of the Society, he helped create the professional organisation that has supported, represented and advanced nuclear medicine for more than six decades.',
        'During a period when nuclear medicine was emerging as a new medical specialty, Dr Croft recognised the importance of bringing together clinicians, scientists and healthcare professionals to share knowledge, encourage collaboration and promote the highest standards of patient care. His vision helped lay the foundations for the multidisciplinary Society that BNMS remains today.',
        'Throughout his career, Dr Croft was respected for his professional leadership, commitment to education and dedication to the continued development of nuclear medicine. His contribution extended beyond clinical practice, helping to shape both the direction of the Society and the wider specialty during its formative years.',
        'As one of the early leaders of BNMS, he inspired colleagues through his enthusiasm, wisdom and commitment to professional collaboration. The Society continues to benefit from the foundations established by Dr Croft and his fellow pioneers.',
        'The British Nuclear Medicine Society remembers Dr Desmond Croft with gratitude and respect, honouring his lasting contribution to the Society and to the development of nuclear medicine in the United Kingdom.',
      ]),
    },
    {
      heading: 'BNMS Contributions',
      html: UL([
        'Founder Member of the British Nuclear Medicine Society',
        'Former President of BNMS',
        'Pioneer of British nuclear medicine',
        'Champion of multidisciplinary collaboration',
        'Helped establish nuclear medicine as a recognised medical specialty',
      ]),
      bullets: true,
    },
  ],
});

// ---------------------------------------------------------------------------
// Event & education pages (BNMS) — "-new" slugged copies for manual cross-check.
// ---------------------------------------------------------------------------

const REGIONAL_MEETING_SUPPORT_NEW = (() => {
  const supportHtml =
    P('Depending on the type of event you are organising, BNMS may be able to provide support including:') +
    UL([
      'Promotion through the BNMS website',
      'Promotion through BNMS member newsletters',
      'Meeting announcement templates',
      'Programme templates',
      'Advice on planning educational meetings',
      'Support with CPD applications',
      'Scientific & Education Committee (SEC) endorsement',
      'Increased visibility across the UK nuclear medicine community',
    ]) +
    P('Support is tailored to the needs of each meeting and provided wherever possible by the BNMS Events Team and Scientific & Education Committee.');
  const applyHtml =
    B([
      'If you would like BNMS to support or endorse your regional meeting, we recommend contacting us as early as possible during the planning process.',
      'To help us consider your request, please provide:',
    ]) +
    UL([
      'Event title',
      'Proposed date and venue',
      'Draft programme (if available)',
      'Intended audience',
      'Organising committee or lead organiser',
      'Any specific support you require',
    ]) +
    P('Our team will review your request and advise how BNMS can best support your event.');
  const YEARS = [
    ['2024', ['South Thames Nuclear Medicine Meeting']],
    ['2023', ['South Thames Nuclear Medicine Meeting']],
    ['2020', ['PSMA Masterclass']],
    ['2019', [
      'Nuclear Cardiology Stress Leaders Course',
      'Midlands Nuclear Medicine Meeting',
      'North-East Regional Nuclear Medicine Meeting',
      'Ventilation/Perfusion: 3D Quantification Workshop',
      'New Diagnostic & Therapy Cancer Advances \u2013 FPR Prostate',
      'Nuclear Medicine Masterclass',
    ]],
    ['2018', [
      'GFR Masterclass',
      'East Anglia Regional Meeting',
      'Radiographers & Technologists Nuclear Medicine Update',
      'North Thames Regional Meeting',
      'Midlands Nuclear Medicine Meeting',
    ]],
    ['2017', ['North Thames Regional Meeting']],
    ['2016', ['South Thames Nuclear Medicine Meeting']],
    ['2015', [
      'East Anglia Regional Nuclear Medicine Group',
      'North Thames Regional Nuclear Medicine Meeting',
    ]],
    ['2013', ['North Thames Regional Meeting']],
  ];
  const meetingsHtml =
    B([
      'BNMS has supported regional meetings and educational events across the United Kingdom for many years, helping deliver high-quality education to healthcare professionals working in nuclear medicine.',
      'Examples include:',
    ]) +
    YEARS.map(([yr, ms]) => P(`<strong>${yr}</strong>`) + UL(ms)).join('');
  const whyHtml =
    B(['Partnering with BNMS helps increase the reach and impact of your educational meeting.', 'Benefits include:']) +
    UL([
      'Promotion to the national BNMS membership',
      'Greater visibility through the BNMS website and communications',
      'Recognition through BNMS Scientific & Education Committee endorsement (where applicable)',
      'Support for continuing professional development activities',
      'Helping strengthen regional collaboration across the nuclear medicine community',
    ]);
  return {
    tenantId: BNMS_TENANT_ID,
    slug: 'regional-meeting-support-new',
    title: 'Regional Meeting Support',
    design: buildDesign({
      hero: {
        headline: 'Regional Meeting Support',
        subheadline:
          'Helping you deliver successful regional nuclear medicine meetings through practical support, promotion and professional endorsement.',
        ctaLabel: 'Request Regional Meeting Support',
        bgImageUrl: HERO_IMG_OPEN,
      },
      sections: [
        {
          type: 'text',
          heading: 'Supporting Regional Education',
          html: B([
            'Regional meetings play an important role in the continued education and professional development of the nuclear medicine community.',
            'The British Nuclear Medicine Society is committed to supporting educational meetings across the United Kingdom by helping organisers promote their events, access practical resources and, where appropriate, obtain endorsement from the BNMS Scientific & Education Committee (SEC).',
            'Whether you are organising a regular regional meeting, a specialist workshop or a multidisciplinary educational event, BNMS is here to help.',
          ]),
          h: bodyHeight(B([
            'Regional meetings play an important role in the continued education and professional development of the nuclear medicine community.',
            'The British Nuclear Medicine Society is committed to supporting educational meetings across the United Kingdom by helping organisers promote their events, access practical resources and, where appropriate, obtain endorsement from the BNMS Scientific & Education Committee (SEC).',
            'Whether you are organising a regular regional meeting, a specialist workshop or a multidisciplinary educational event, BNMS is here to help.',
          ])),
        },
        {
          type: 'text',
          heading: 'How BNMS Can Support Your Meeting',
          html: supportHtml,
          h: bodyHeight(supportHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'Applying for Support',
          html: applyHtml,
          h: bodyHeight(applyHtml),
          bullets: true,
          buttons: ['Request Regional Meeting Support', 'Download Regional Meeting Support Guidance'],
        },
        {
          type: 'text',
          heading: 'Previously Supported Meetings',
          html: meetingsHtml,
          h: bodyHeight(meetingsHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'Why Seek BNMS Support?',
          html: whyHtml,
          h: bodyHeight(whyHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'Planning a Meeting?',
          html: B([
            'If you are considering organising a regional educational meeting or would like to discuss your plans, the BNMS Events Team would be delighted to hear from you.',
            'We encourage organisers to contact us early so that we can provide the most appropriate advice, resources and promotional support.',
          ]),
          h: bodyHeight(B([
            'If you are considering organising a regional educational meeting or would like to discuss your plans, the BNMS Events Team would be delighted to hear from you.',
            'We encourage organisers to contact us early so that we can provide the most appropriate advice, resources and promotional support.',
          ])),
          buttons: ['Contact the BNMS Events Team'],
        },
      ],
    }),
  };
})();

const PROMOTE_YOUR_EVENT_NEW = (() => {
  const eventsHtml =
    P('We welcome submissions for a wide range of educational events, including:') +
    UL([
      'Conferences',
      'Regional Meetings',
      'Training Courses',
      'Workshops',
      'Webinars',
      'Study Days',
      'Educational Masterclasses',
      'Other nuclear medicine-related professional events',
    ]);
  const submitHtml =
    P('Please send the following information to the BNMS Events Team:') +
    UL([
      'Event title',
      'Date(s)',
      'Venue or online platform',
      'Short event description',
      'Programme (if available)',
      'Registration or booking link',
      'Organising organisation',
      'Contact details',
      'Event image or logo (optional)',
    ]) +
    P('Our team will review your submission before publishing it on the BNMS Events Calendar.');
  const beforeHtml =
    P('To help us process your request as quickly as possible:') +
    UL([
      'Submit your event as early as possible before the event date.',
      'Ensure all information is accurate and up to date.',
      'Notify us if any event details change after submission.',
    ]) +
    P('BNMS reserves the right to edit event listings for consistency and clarity and to decline events that are not relevant to the nuclear medicine community.');
  return {
    tenantId: BNMS_TENANT_ID,
    slug: 'promote-your-event-new',
    title: 'Promote Your Event',
    design: buildDesign({
      hero: {
        headline: 'Promote Your Event',
        subheadline: 'Share your nuclear medicine meeting, course or educational event with the BNMS community.',
        ctaLabel: 'Submit Your Event',
        bgImageUrl: HERO_IMG_OPEN,
      },
      sections: [
        {
          type: 'text',
          heading: 'Promote Your Event Through BNMS',
          html: B([
            'The BNMS Events Calendar is one of the UK\u2019s leading sources of information for nuclear medicine meetings, conferences, courses and educational events.',
            'If you are organising an event that is relevant to the nuclear medicine community, we would be pleased to consider it for inclusion on the BNMS website.',
            'Listing your event helps increase its visibility and ensures it reaches healthcare professionals across the UK.',
          ]),
          h: bodyHeight(B([
            'The BNMS Events Calendar is one of the UK\u2019s leading sources of information for nuclear medicine meetings, conferences, courses and educational events.',
            'If you are organising an event that is relevant to the nuclear medicine community, we would be pleased to consider it for inclusion on the BNMS website.',
            'Listing your event helps increase its visibility and ensures it reaches healthcare professionals across the UK.',
          ])),
        },
        {
          type: 'text',
          heading: 'Events We Can Promote',
          html: eventsHtml,
          h: bodyHeight(eventsHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'How to Submit Your Event',
          html: submitHtml,
          h: bodyHeight(submitHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'Before You Submit',
          html: beforeHtml,
          h: bodyHeight(beforeHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'Ready to Promote Your Event?',
          html: P('We\u2019re always pleased to help promote educational activities that support the nuclear medicine community.'),
          h: bodyHeight(P('We\u2019re always pleased to help promote educational activities that support the nuclear medicine community.')),
          buttons: ['Submit Your Event', 'Contact the BNMS Events Team'],
        },
      ],
    }),
  };
})();

const ORGANISE_EVENT_NEW = (() => {
  const whyHtml =
    B([
      'Working with BNMS helps ensure your educational event reaches the widest possible audience within the nuclear medicine community.',
      'Depending on the type of event, support may include:',
    ]) +
    UL([
      'Promotion through the BNMS website',
      'Inclusion in member newsletters',
      'Listing in the BNMS Events Calendar',
      'Meeting and programme templates',
      'Guidance on organising educational events',
      'Support with CPD applications',
      'Scientific & Education Committee endorsement',
      'Increased visibility across the UK nuclear medicine community',
    ]);
  const whoHtml =
    P('BNMS welcomes enquiries from organisations and individuals delivering educational activities relevant to nuclear medicine, including:') +
    UL([
      'NHS Trusts and Health Boards',
      'Universities and Higher Education Institutions',
      'Regional Nuclear Medicine Groups',
      'Professional Networks',
      'Specialist Interest Groups',
      'Healthcare Organisations',
      'Collaborative Educational Partnerships',
    ]);
  return {
    tenantId: BNMS_TENANT_ID,
    slug: 'organise-an-event-with-bnms-new',
    title: 'Organise an Event with BNMS',
    design: buildDesign({
      hero: {
        headline: 'Organise an Event with BNMS',
        subheadline:
          'Supporting regional meetings, educational courses and professional events that advance nuclear medicine across the United Kingdom.',
        ctaLabel: 'Contact the BNMS Events Team',
        bgImageUrl: HERO_IMG_OPEN,
      },
      sections: [
        {
          type: 'text',
          heading: 'Supporting Education Across the UK',
          html: B([
            'The British Nuclear Medicine Society is committed to supporting high-quality education and professional development throughout the nuclear medicine community.',
            'Whether you are organising a regional meeting, educational course, specialist workshop or national event, BNMS can provide guidance, endorsement and promotional support to help maximise the success of your event.',
            'Our Events Team and Scientific & Education Committee work closely with organisers to promote educational opportunities and encourage knowledge sharing across the profession.',
          ]),
          h: bodyHeight(B([
            'The British Nuclear Medicine Society is committed to supporting high-quality education and professional development throughout the nuclear medicine community.',
            'Whether you are organising a regional meeting, educational course, specialist workshop or national event, BNMS can provide guidance, endorsement and promotional support to help maximise the success of your event.',
            'Our Events Team and Scientific & Education Committee work closely with organisers to promote educational opportunities and encourage knowledge sharing across the profession.',
          ])),
        },
        {
          type: 'cards',
          heading: 'How Can We Help?',
          columns: 3,
          cardH: 420,
          cards: [
            {
              icon: 'fa-solid fa-people-group',
              heading: 'Regional Meeting Support',
              body:
                '<p>Organising a regional nuclear medicine meeting?</p>' +
                '<p>BNMS can provide practical support to help you deliver successful educational events, including promotional opportunities, programme templates, meeting guidance and assistance with CPD applications.</p>',
              cta: 'Regional Meeting Support',
            },
            {
              icon: 'fa-solid fa-certificate',
              heading: 'Course Endorsement',
              body:
                '<p>Delivering an educational course or training programme?</p>' +
                '<p>BNMS course endorsement recognises high-quality educational activities that support professional development within nuclear medicine.</p>' +
                '<p>Applications are reviewed by the BNMS Scientific & Education Committee against our published endorsement criteria.</p>',
              cta: 'Course Endorsement',
            },
            {
              icon: 'fa-solid fa-bullhorn',
              heading: 'Promote Your Event',
              body:
                '<p>Would you like your meeting, course or workshop included in the BNMS Events Calendar?</p>' +
                '<p>Our Events Team can promote relevant nuclear medicine events to the wider BNMS community through the website and member communications.</p>',
              cta: 'List Your Event',
            },
          ],
        },
        {
          type: 'text',
          heading: 'Why Work with BNMS?',
          html: whyHtml,
          h: bodyHeight(whyHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'Who Can Apply?',
          html: whoHtml,
          h: bodyHeight(whoHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'Ready to Get Started?',
          html: B([
            'Whether you are planning your first educational event or looking to build on an established programme, the BNMS team is here to help.',
            'We encourage organisers to contact us as early as possible so we can provide the most appropriate support and guidance throughout the planning process.',
          ]),
          h: bodyHeight(B([
            'Whether you are planning your first educational event or looking to build on an established programme, the BNMS team is here to help.',
            'We encourage organisers to contact us as early as possible so we can provide the most appropriate support and guidance throughout the planning process.',
          ])),
          buttons: ['Contact the BNMS Events Team', 'View Upcoming BNMS Events'],
        },
      ],
    }),
  };
})();

const COURSE_ENDORSEMENT_NEW = (() => {
  const whoHtml =
    P('Course endorsement is open to organisations and individuals delivering educational activities relevant to nuclear medicine, including:') +
    UL([
      'NHS Trusts and Health Boards',
      'Universities and Higher Education Institutions',
      'Professional Groups',
      'Healthcare Organisations',
      'Specialist Interest Groups',
      'Commercial organisations delivering educational programmes',
    ]);
  const howHtml =
    P('To apply for BNMS Course Endorsement, please:') +
    UL([
      'Review the BNMS Course Endorsement Criteria.',
      'Complete the Course Endorsement Application Form.',
      'Submit the completed form together with your course programme and any supporting documentation.',
    ]) +
    P('Applications are reviewed by the BNMS Scientific & Education Committee and may take up to 12 weeks to process.');
  const beforeHtml =
    P('Please ensure you have the following available:') +
    UL([
      'Completed application form',
      'Full course programme',
      'Learning objectives',
      'Supporting documentation (where applicable)',
    ]);
  return {
    tenantId: BNMS_TENANT_ID,
    slug: 'course-endorsement-new',
    title: 'Course Endorsement',
    design: buildDesign({
      hero: {
        headline: 'Course Endorsement',
        subheadline: 'Apply for BNMS endorsement for educational courses supporting nuclear medicine professionals.',
        ctaLabel: 'Apply for Course Endorsement',
        bgImageUrl: HERO_IMG_OPEN,
      },
      sections: [
        {
          type: 'text',
          heading: 'Why Apply for BNMS Endorsement?',
          html: B([
            'The British Nuclear Medicine Society supports high-quality education by endorsing courses that contribute to the professional development of the nuclear medicine community.',
            'BNMS endorsement demonstrates that a course meets recognised educational standards and supports learning within the specialty. It also provides delegates with confidence that the course has been reviewed by the BNMS Scientific & Education Committee (SEC).',
          ]),
          h: bodyHeight(B([
            'The British Nuclear Medicine Society supports high-quality education by endorsing courses that contribute to the professional development of the nuclear medicine community.',
            'BNMS endorsement demonstrates that a course meets recognised educational standards and supports learning within the specialty. It also provides delegates with confidence that the course has been reviewed by the BNMS Scientific & Education Committee (SEC).',
          ])),
        },
        {
          type: 'text',
          heading: 'Who Can Apply?',
          html: whoHtml,
          h: bodyHeight(whoHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'How to Apply',
          html: howHtml,
          h: bodyHeight(howHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'Before You Apply',
          html: beforeHtml,
          h: bodyHeight(beforeHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'Ready to Apply?',
          html: P('Download the guidance and application form to begin your application.'),
          h: bodyHeight(P('Download the guidance and application form to begin your application.')),
          buttons: ['Download Course Endorsement Criteria', 'Download Application Form'],
        },
        {
          type: 'text',
          heading: 'Need More Information?',
          html: P('If you have any questions about the course endorsement process or would like to discuss your application before submitting it, the BNMS Events Team will be happy to help.'),
          h: bodyHeight(P('If you have any questions about the course endorsement process or would like to discuss your application before submitting it, the BNMS Events Team will be happy to help.')),
          buttons: ['Contact the BNMS Office'],
        },
      ],
    }),
  };
})();

const CARDIAC_SPECT_COURSE_NEW = (() => {
  const whoHtml =
    P('This course is designed for:') +
    UL([
      'Cardiologists',
      'Nuclear Medicine Physicians',
      'Clinical Scientists',
      'Radiographers',
      'Technologists',
      'Trainees',
      'Allied healthcare professionals with an interest in nuclear cardiology',
    ]);
  const learnHtml =
    P('By completing this course, you will be able to:') +
    UL([
      'Understand the principles of myocardial perfusion imaging, including stress testing, radiopharmaceuticals and patient safety.',
      'Identify appropriate patients for myocardial perfusion imaging within current UK cardiac diagnostic pathways.',
      'Interpret myocardial perfusion studies, recognise common artefacts and understand how imaging findings influence patient management.',
      'Understand the practical and governance requirements for delivering a safe, effective myocardial perfusion imaging service.',
    ]);
  const registerHtml = B([
    'Register to gain access to the complete on-demand course recordings and educational resources.',
    'The course can be completed at your own pace, allowing you to revisit individual sessions whenever required.',
  ]);
  const cpdHtml =
    B([
      'This course supports your continuing professional development.',
      'Although CPD certificates are not issued for on-demand learning, you may record the time spent watching the course as Self-Directed Learning within your professional development portfolio.',
    ]) +
    UL([
      'One CPD credit may be claimed for each hour of learning completed.',
      'If you require confirmation of attendance, please contact Caroline Oxley.',
    ]);
  const faculty = [
    'Ian Armstrong', 'Matt Balerdi', 'Ed Butler', 'Neil Davis', 'Leon Menezes',
    'Arum Parthipun', 'Ricardo Petraco', 'Nik Sabharwal', 'Ibrahim Saeed',
    'Rebecca Schofield', 'Hassan Shirsavar', 'Imran Suderji', 'Enrique Sunga',
  ];
  return {
    tenantId: BNMS_TENANT_ID,
    slug: 'cardiac-myocardial-perfusion-spect-course-new',
    title: 'Cardiac Myocardial Perfusion SPECT Course',
    design: buildDesign({
      hero: {
        headline: 'Cardiac Myocardial Perfusion SPECT Course',
        subheadline:
          'A practical, clinically focused on-demand course designed to support healthcare professionals involved in myocardial perfusion imaging.',
        ctaLabel: 'Member - Register for the Course',
        bgImageUrl: HERO_IMG_OPEN,
      },
      sections: [
        {
          type: 'text',
          heading: 'Learn at Your Own Pace',
          html: B([
            'Originally delivered as a joint educational study day by the British Nuclear Medicine Society (BNMS) and the British Nuclear Cardiac Society (BNCS), the Cardiac Myocardial Perfusion SPECT Course is now available as an on-demand learning resource.',
            'Designed for cardiologists, nuclear medicine physicians, clinical scientists, radiographers, technologists and allied healthcare professionals, the course provides a practical overview of myocardial perfusion imaging, from patient selection and stress techniques through to image interpretation and service delivery within contemporary UK cardiac pathways.',
            'Through expert presentations and interactive case-based learning, participants will gain practical knowledge that can be applied immediately within clinical practice.',
          ]),
          h: bodyHeight(B([
            'Originally delivered as a joint educational study day by the British Nuclear Medicine Society (BNMS) and the British Nuclear Cardiac Society (BNCS), the Cardiac Myocardial Perfusion SPECT Course is now available as an on-demand learning resource.',
            'Designed for cardiologists, nuclear medicine physicians, clinical scientists, radiographers, technologists and allied healthcare professionals, the course provides a practical overview of myocardial perfusion imaging, from patient selection and stress techniques through to image interpretation and service delivery within contemporary UK cardiac pathways.',
            'Through expert presentations and interactive case-based learning, participants will gain practical knowledge that can be applied immediately within clinical practice.',
          ])),
        },
        {
          type: 'text',
          heading: 'Who Should Register?',
          html: whoHtml,
          h: bodyHeight(whoHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'What You\u2019ll Learn',
          html: learnHtml,
          h: bodyHeight(learnHtml),
          bullets: true,
        },
        {
          type: 'text',
          heading: 'Course Programme',
          html: P('Explore the full programme, including expert presentations covering the principles, practice and interpretation of myocardial perfusion SPECT imaging.'),
          h: bodyHeight(P('Explore the full programme, including expert presentations covering the principles, practice and interpretation of myocardial perfusion SPECT imaging.')),
          buttons: ['View Programme'],
        },
        {
          type: 'text',
          heading: 'Case-Based Learning',
          html: B([
            'One of the key strengths of this course is its practical, case-based approach.',
            'Participants work through real myocardial perfusion imaging cases alongside experienced faculty, exploring image interpretation, reporting techniques and common diagnostic challenges.',
            'The course has been designed to encourage practical learning that can be applied immediately within clinical practice.',
          ]),
          h: bodyHeight(B([
            'One of the key strengths of this course is its practical, case-based approach.',
            'Participants work through real myocardial perfusion imaging cases alongside experienced faculty, exploring image interpretation, reporting techniques and common diagnostic challenges.',
            'The course has been designed to encourage practical learning that can be applied immediately within clinical practice.',
          ])),
        },
        {
          type: 'text',
          heading: 'Register for the Course',
          html: registerHtml,
          h: bodyHeight(registerHtml),
          buttons: ['Member - Register for the Course', 'Non-member \u2013 Register for the Course'],
        },
        {
          type: 'text',
          heading: 'CPD Information',
          html: cpdHtml,
          h: bodyHeight(cpdHtml),
          bullets: true,
        },
        {
          type: 'cards',
          heading: 'Meet the Faculty',
          columns: 4,
          cardH: 150,
          cards: faculty.map((name) => ({ icon: 'fa-solid fa-user-doctor', heading: name, body: '' })),
        },
        {
          type: 'text',
          heading: 'Delivered in Partnership',
          html: P('This course was developed jointly by the British Nuclear Medicine Society (BNMS) and the British Nuclear Cardiac Society (BNCS), bringing together expertise from across both specialties to support high-quality education in nuclear cardiology.'),
          h: bodyHeight(P('This course was developed jointly by the British Nuclear Medicine Society (BNMS) and the British Nuclear Cardiac Society (BNCS), bringing together expertise from across both specialties to support high-quality education in nuclear cardiology.')),
        },
        {
          type: 'text',
          heading: 'Supported by Industry',
          html: B([
            'This educational course has been made possible through the generous support of our industry partner.',
            'Sponsor support enabled delivery of this educational programme but had no influence over the educational content, faculty or course design.',
          ]),
          h: bodyHeight(B([
            'This educational course has been made possible through the generous support of our industry partner.',
            'Sponsor support enabled delivery of this educational programme but had no influence over the educational content, faculty or course design.',
          ])),
        },
        {
          type: 'placeholder',
          note: NOTE('Sponsor logo: Bracco'),
          h: 110,
        },
        {
          type: 'text',
          heading: 'Continue Your Professional Development',
          html: P('Explore more BNMS educational opportunities, webinars and meetings.'),
          h: bodyHeight(P('Explore more BNMS educational opportunities, webinars and meetings.')),
          buttons: ['Education & Events', 'Upcoming Events'],
        },
      ],
    }),
  };
})();

const RTN_COMMITTEE_NEW = (() => {
  const aboutHtml = B([
    'The BNMS Radiographers, Technologists & Nurses (RTN) Committee represents Radiographers, Technologists and Nurses working across the nuclear medicine community.',
    'The Committee works to support professional collaboration, encourage education and continuing professional development, and represent the interests of these professional groups within the British Nuclear Medicine Society.',
    'Working alongside BNMS Council and other specialist committees, the RTN Committee contributes to the organisation of scientific meetings, shares professional knowledge and promotes best practice across the specialty.',
  ]);
  const objectivesHtml =
    P('The Committee aims to:') +
    UL([
      'Unite Radiographers, Technologists and Nurses working in nuclear medicine.',
      'Encourage education, training and professional development.',
      'Support and promote high standards of clinical practice.',
      'Represent the profession within BNMS.',
      'Contribute to the scientific programme at BNMS meetings.',
      'Encourage collaboration and knowledge sharing across the multidisciplinary workforce.',
    ]);
  const leadershipHtml =
    P('<strong>Co-Chairs</strong>') +
    UL([
      'Monica Casanova Martins \u2013 Singleton Hospital, Swansea',
      'Mariana Pinto \u2013 Belfast Trust',
    ]) +
    P('<strong>Secretary</strong>') +
    UL(['Gerard McKiernan \u2013 Belfast Trust']);
  const membersHtml = UL([
    'Jo Weekes \u2013 The Royal Wolverhampton NHS Trust',
    'Fran Ferrer Avila \u2013 Guy\u2019s and St Thomas\u2019 NHS Foundation Trust',
    'Giorgio Testanera \u2013 KCL PET Centre',
    'Johnathon Goodacre \u2013 Royal Cornwall Hospital',
    'Hannah Chandler \u2013 London North West University Healthcare NHS Trust',
    'Robin McDade \u2013 Glasgow Royal Infirmary',
    'Nia Hopson \u2013 Swansea Bay University Health Board',
    'Georgina Pitts \u2013 University Hospitals Plymouth NHS Trust',
    'Christopher Orongan \u2013 Barts Health NHS Trust',
  ]);
  const getInvolvedHtml =
    B([
      'The RTN Committee welcomes Associate and Full BNMS members who would like to contribute to the work of the Committee.',
      'If you are interested in becoming involved, attending meetings or supporting future initiatives, we would be delighted to hear from you.',
      'Committee members are typically expected to:',
    ]) +
    UL([
      'Attend three committee meetings each year.',
      'Share their professional knowledge and experience.',
      'Support the development of education and professional activities.',
      'Contribute to the ongoing work of the Committee.',
    ]);
  const resourcesHtml =
    B([
      'The RTN Committee supports a number of professional initiatives and resources for members.',
      'Useful links include:',
    ]) +
    UL([
      'RTN Committee Terms of Reference',
      'RTN Community (JISCMail)',
      'Ros Breen Fund',
      'Volunteer Information',
    ]);
  return {
    tenantId: BNMS_TENANT_ID,
    slug: 'radiographers-technologists-and-nurses-committee-new',
    title: 'Radiographers, Technologists & Nurses Committee',
    design: buildDesign({
      hero: {
        headline: 'Radiographers, Technologists & Nurses Committee',
        subheadline:
          'Bringing together Radiographers, Technologists and Nurses to support professional collaboration, education and excellence in nuclear medicine.',
        ctaLabel: 'Contact the RTN Committee',
        bgImageUrl: HERO_IMG_OPEN,
      },
      sections: [
        { type: 'text', heading: 'About the RTN Committee', html: aboutHtml, h: bodyHeight(aboutHtml) },
        { type: 'text', heading: 'Our Objectives', html: objectivesHtml, h: bodyHeight(objectivesHtml), bullets: true },
        { type: 'text', heading: 'Committee Leadership', html: leadershipHtml, h: bodyHeight(leadershipHtml), bullets: true },
        { type: 'text', heading: 'Committee Members', html: membersHtml, h: bodyHeight(membersHtml), bullets: true },
        { type: 'text', heading: 'Get Involved', html: getInvolvedHtml, h: bodyHeight(getInvolvedHtml), bullets: true },
        { type: 'text', heading: 'Resources', html: resourcesHtml, h: bodyHeight(resourcesHtml), bullets: true },
      ],
      closingHero: {
        headline: 'Join the RTN Community',
        subheadline:
          'Whether you would like to contribute to the Committee, share your expertise or support the future development of nuclear medicine, the RTN Committee offers opportunities to become involved with BNMS and connect with colleagues from across the UK.',
        bgImageUrl: HERO_IMG_CLOSE,
      },
    }),
  };
})();

const SCIENTIFIC_EDUCATION_NEW = (() => {
  const introHtml = B([
    'The British Nuclear Medicine Society (BNMS) established the combined Scientific Committee and Education Committee in 2016.',
    'The mandate of the Scientific and Education Committee is to develop an education and scientific programme, nominate invited speakers and the chairs of sessions.',
    'The remit of this committee is to provide resources and encourage the provision of education and training to support Continuing Professional Development/Continuous Medical Education and work towards revalidation. The Education Committee is Multidisciplinary, consisting of Nuclear Medicine Physicians, Technologists, Physicists, Nurses and Radiopharmaceutical Scientists.',
  ]);
  const leadershipHtml =
    P('<strong>Terms of Reference</strong>') +
    P(
      'The Co-Chairs of the BNMS Scientific and Education Committee are Dr Simon Hughes, Miss Hannah Chandler and the Deputy Chair is Dr Sarah McQuaid.'
    );
  const contactHtml =
    P('<strong>Dr Simon Hughes</strong><br>University Hospitals Birmingham') +
    P('<strong>Miss Hannah Chandler</strong><br>Northwick Park Hospital') +
    P('<strong>Dr Sarah McQuaid</strong><br>Barts Health NHS Trust');
  const membersHtml = UL([
    'Carla Abreu',
    'Ramla Awais',
    'Humayun Bashir',
    'Nathan Dickinson',
    'Sabina Dizdarevic',
    'Clara Ferreira',
    'Francesco Fraioli',
    'Fahim Ul Hassan',
    'Phil Hillel',
    'Greg James',
    'Anver Kamil',
    'Chen Low',
    'Monica Martins',
    'Mariana Pinto',
    'Jane Sosabowksi',
    'Giorgio Testanera',
    'Kshama Wechalekar',
  ]);
  return {
    tenantId: BNMS_TENANT_ID,
    slug: 'scientific-education-committee-new',
    title: 'Scientific & Education Committee',
    design: buildDesign({
      hero: {
        headline: 'Scientific & Education Committee',
        bgImageUrl: HERO_IMG_OPEN,
      },
      sections: [
        { type: 'text', html: introHtml, h: bodyHeight(introHtml) },
        { type: 'text', html: leadershipHtml, h: bodyHeight(leadershipHtml) },
        { type: 'text', heading: 'Contact', html: contactHtml, h: bodyHeight(contactHtml) },
        { type: 'text', heading: 'Committee Members', html: membersHtml, h: bodyHeight(membersHtml), bullets: true },
      ],
    }),
  };
})();

const ABOUT_BNMS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'about-bnms',
  title: 'About the British Nuclear Medicine Society',
  design: buildDesign({
    hero: {
      headline: 'About the British Nuclear Medicine Society',
      subheadline:
        'Supporting professionals, advancing nuclear medicine and improving patient care through education, collaboration, research and professional leadership.',
      ctaLabel: 'Become a Member',
      bgImageUrl: HERO_IMG_OPEN,
    },
    sections: [
      {
        type: 'feature',
        heading: 'Supporting the Nuclear Medicine Community Since 1966',
        html:
          P('Founded in 1966, the British Nuclear Medicine Society (BNMS) is the professional membership organisation for everyone working in nuclear medicine across the United Kingdom.') +
          P('As a multidisciplinary society, we bring together clinicians, clinical scientists, radiographers, technologists, nurses, radiopharmacists, radiochemists, trainees, students and industry partners with a shared commitment to advancing nuclear medicine and improving patient care.') +
          P('Through education, collaboration, research and professional leadership, BNMS supports its members throughout every stage of their careers while helping to shape the future of the specialty.'),
        h: 360,
      },
      {
        type: 'cards',
        heading: 'What We Do',
        columns: 4,
        cardH: 340,
        cards: [
          {
            icon: 'fa-solid fa-graduation-cap',
            heading: 'Education & Professional Development',
            body: P('Supporting lifelong learning through conferences, scientific meetings, educational resources and continuing professional development opportunities.'),
          },
          {
            icon: 'fa-solid fa-flask',
            heading: 'Research & Innovation',
            body: P('Encouraging research, recognising excellence and supporting innovation across nuclear medicine, molecular imaging and molecular radiotherapy.'),
          },
          {
            icon: 'fa-solid fa-users',
            heading: 'Professional Community',
            body: P('Connecting professionals from every discipline to share knowledge, collaborate and strengthen the multidisciplinary nuclear medicine community.'),
          },
          {
            icon: 'fa-solid fa-flag',
            heading: 'Leadership & Representation',
            body: P('Representing the interests of UK nuclear medicine, promoting professional standards and helping shape the future of the specialty.'),
          },
        ],
      },
      {
        type: 'text',
        heading: 'Supporting Our Members',
        bullets: true,
        html:
          P('Whether you are beginning your career, undertaking specialist training or leading services within your organisation, BNMS provides opportunities to learn, connect and grow professionally.') +
          P('Membership includes access to:') +
          `<ul>${[
            'National conferences and scientific meetings',
            'Education and CPD opportunities',
            'Research grants, fellowships and awards',
            'Mentoring and career development',
            'Professional networking',
            'Publications, guidance and specialist resources',
            'Opportunities to volunteer and contribute to the Society',
          ]
            .map(LI)
            .join('')}</ul>`,
        h: 620,
      },
      {
        type: 'cards',
        heading: 'Explore BNMS',
        columns: 3,
        cardH: 300,
        cards: [
          {
            icon: 'fa-solid fa-sitemap',
            heading: 'Governance',
            body: P('Learn how BNMS is led through its Council, committees, regional leads and office team.'),
            cta: 'Explore Governance',
          },
          {
            icon: 'fa-solid fa-people-group',
            heading: 'Professional Groups',
            body: P('Discover the multidisciplinary professional groups that represent the diverse expertise within nuclear medicine.'),
            cta: 'Explore Professional Groups',
          },
          {
            icon: 'fa-solid fa-award',
            heading: 'Awards & Recognition',
            body: P('Celebrate the individuals whose dedication, leadership and service have made an outstanding contribution to BNMS and the wider nuclear medicine community.'),
            cta: 'Explore Awards & Recognition',
          },
          {
            icon: 'fa-solid fa-clock-rotate-left',
            heading: 'Our History',
            body: P('Explore more than sixty years of BNMS history and discover the milestones, people and achievements that have shaped the Society since 1966.'),
            cta: 'Explore Our History',
          },
          {
            icon: 'fa-solid fa-handshake-angle',
            heading: 'Volunteering',
            body: P('Find out how you can contribute your skills and experience to support the work of BNMS.'),
            cta: 'Volunteer with BNMS',
          },
          {
            icon: 'fa-solid fa-hand-holding-heart',
            heading: 'Support BNMS',
            body: P('Learn how individuals and organisations can support the Society and help advance nuclear medicine.'),
            cta: 'Support BNMS',
          },
        ],
      },
    ],
    closingHero: {
      headline: 'Join Our Community',
      subheadline:
        'Whether you are a student, trainee, healthcare professional, scientist or industry partner, BNMS provides opportunities to learn, connect and help shape the future of nuclear medicine.',
      ctaLabel: 'Become a Member',
      bgImageUrl: HERO_IMG_CLOSE,
    },
  }),
};

const GOVERNANCE_NEW = {
  tenantId: BNMS_TENANT_ID,
  // 'governance' is an immutable iedit page and 'governance-and-policies' is the
  // existing policies CanvasBuilder page; use a distinct slug for this new
  // leadership/council governance landing page.
  slug: 'bnms-governance',
  title: 'Governance',
  design: buildDesign({
    hero: {
      headline: 'Governance',
      subheadline:
        'Providing the leadership, expertise and support that enables the British Nuclear Medicine Society to serve the nuclear medicine community across the UK.',
      ctaLabel: 'Meet the BNMS Council',
      bgImageUrl: HERO_IMG_OPEN,
    },
    sections: [
      {
        type: 'feature',
        heading: 'Leading the Society',
        html:
          P('The British Nuclear Medicine Society is committed to strong leadership, good governance and supporting the needs of its members.') +
          P('The Society is led by an elected Council and supported by dedicated staff, Regional Leads, Professional Groups and Committees. Together, they provide the strategic direction, professional expertise and operational support that enables BNMS to deliver education, conferences, research, professional guidance and member services while representing the interests of the nuclear medicine community.') +
          P('Working together, they help ensure BNMS continues to advance nuclear medicine and improve patient care across the United Kingdom.'),
        h: 400,
      },
      {
        type: 'feature',
        heading: 'Executive Officers',
        html: P('The Executive Officers provide the leadership of the Society and work closely with Council to guide the strategic direction of BNMS.'),
        h: 140,
      },
      {
        type: 'cards',
        columns: 4,
        cardH: 320,
        cards: [
          {
            icon: 'fa-solid fa-user-tie',
            heading: 'Prof Sabina Dizdarevic',
            body: P('President') + P('Royal Sussex County Hospital'),
            cta: 'Contact by Email',
          },
          {
            icon: 'fa-solid fa-user-tie',
            heading: 'Dr Stewart Redman',
            body: P('President-Elect') + P('Royal United Hospital, Bath'),
            cta: 'Contact by Email',
          },
          {
            icon: 'fa-solid fa-user-tie',
            heading: 'Dr Amy Eccles',
            body: P('Honorary Secretary') + P('Imperial College Healthcare NHS Trust'),
            cta: 'Contact by Email',
          },
          {
            icon: 'fa-solid fa-user-tie',
            heading: 'Mr Charnie Kalirai',
            body: P('Honorary Treasurer') + P('Nottingham University Hospitals NHS Trust'),
            cta: 'Contact by Email',
          },
        ],
      },
      {
        type: 'text',
        heading: 'Meet the BNMS Office',
        bullets: true,
        html:
          P('The BNMS office team supports the day-to-day running of the Society, working closely with members, volunteers, Council and Committees to deliver the wide range of services and activities provided by BNMS.') +
          `<ul>${[
            'Charlotte Weston \u2013 Chief Executive Officer',
            'Caroline Oxley \u2013 Committees Secretary',
            'Angelica Spina \u2013 BNMS Administrator',
            'Lisa Wilshere \u2013 Events &amp; Conferences Officer',
          ]
            .map(LI)
            .join('')}</ul>` +
          P('<strong>General Enquiries</strong>') +
          P('British Nuclear Medicine Society, PO Box 8599, Derby, DE1 9PT') +
          P('0115 671 5703') +
          P('info@bnms.org.uk'),
        h: 560,
      },
      {
        type: 'cards',
        heading: 'Learn More',
        columns: 3,
        cardH: 340,
        cards: [
          {
            icon: 'fa-solid fa-users',
            heading: 'BNMS Council',
            body: P('Meet the full Council, including elected members and representatives who help provide strategic leadership for the Society.'),
            cta: 'Meet the BNMS Council',
          },
          {
            icon: 'fa-solid fa-location-dot',
            heading: 'Regional Leads',
            body: P('Find your Regional Lead and connect with BNMS in your area.'),
            cta: 'Find Your Regional Lead',
          },
          {
            icon: 'fa-solid fa-people-group',
            heading: 'Professional Groups & Committees',
            body: P('Discover the Professional Groups and Committees that support education, research, professional standards and collaboration across the nuclear medicine community.'),
            cta: 'Explore Professional Groups & Committees',
          },
        ],
      },
      {
        type: 'feature',
        heading: 'Supporting the Future of BNMS',
        html:
          P('Good governance is built on collaboration.') +
          P('From the leadership of the Executive Officers and Council to the commitment of our staff, Regional Leads, Professional Groups and Committees, BNMS is supported by people who generously contribute their time, knowledge and expertise for the benefit of the wider nuclear medicine community.') +
          P('Together, they help ensure the Society continues to grow, innovate and support excellence in nuclear medicine for future generations.'),
        h: 360,
      },
      {
        type: 'feature',
        heading: 'Get Involved',
        html:
          P('BNMS is strengthened by the knowledge, experience and enthusiasm of its members.') +
          P('Whether you are interested in joining a Professional Group or Committee, volunteering your expertise or supporting the work of the Society in another way, there are many opportunities to become involved.'),
        buttons: ['Volunteer with BNMS', 'Become a Member'],
        h: 240,
      },
    ],
  }),
};

const BNMS_COUNCIL = {
  tenantId: BNMS_TENANT_ID,
  slug: 'bnms-council',
  title: 'BNMS Council',
  design: buildDesign({
    hero: {
      headline: 'BNMS Council',
      subheadline:
        'Meet the Council members who help provide the leadership, strategic direction and governance of the British Nuclear Medicine Society.',
      ctaLabel: 'Contact the BNMS Office',
      bgImageUrl: HERO_IMG_OPEN,
    },
    sections: [
      {
        type: 'feature',
        heading: 'The Governing Body of BNMS',
        html:
          P('The BNMS Council is responsible for the strategic leadership and governance of the British Nuclear Medicine Society.') +
          P('Working on behalf of the membership, the Council helps shape the Society\u2019s direction, oversees its activities and supports the delivery of its charitable objectives. Council members represent the multidisciplinary nature of nuclear medicine, bringing together expertise from clinical practice, science, education, research, professional standards and patient representation.') +
          P('Working alongside the Executive Officers, the Council helps ensure BNMS continues to support its members and advance nuclear medicine throughout the United Kingdom.'),
        h: 400,
      },
      {
        type: 'text',
        heading: 'Executive Officers',
        bullets: true,
        html:
          P('The Executive Officers provide the leadership of the Society and work closely with the wider Council to guide the strategic direction of BNMS.') +
          `<ul>${[
            'Prof Sabina Dizdarevic \u2013 President',
            'Dr Stewart Redman \u2013 President-Elect',
            'Dr Amy Eccles \u2013 Honorary Secretary',
            'Mr Charnie Kalirai \u2013 Honorary Treasurer',
          ]
            .map(LI)
            .join('')}</ul>`,
        buttons: ['Meet the Executive Officers'],
        h: 380,
      },
      {
        type: 'text',
        heading: 'Council Members',
        bullets: true,
        html:
          P('Alongside the Executive Officers, the Council includes representatives from across the nuclear medicine community, ensuring a broad range of professional expertise contributes to the leadership of the Society.') +
          `<ul>${[
            'Giorgio Testanera \u2013 Council Member',
            'Richard Fernandez \u2013 Council Member',
            'Prof Vineet Prakash \u2013 Council Member',
            'Dr Kshama Wechalekar \u2013 Council Member',
            'Dr Arum Parthipun \u2013 NICE Lead',
            'Mr Andy Irwin \u2013 Chair, Professional Standards Committee',
            'Prof Jonathan Wadsley \u2013 Chair, Molecular Radiotherapy',
            'Dr Rebecca Schofield \u2013 BNCS Representative',
            'Mr Mike Ward \u2013 Chair, Nuclear Medicine Industry Association',
            'Adrian Hardy \u2013 Patient Representative',
            'Dr Bev Ellis \u2013 Radiopharmaceutical Sciences Group Representative',
            'Dr Sweni Shah \u2013 Medical Trainee Representative',
            'Francesc Ferrer Avila \u2013 Nurses Representative',
            'Dr B Drake \u2013 Council Member',
            'Dr Gopinath Gnanasegaran \u2013 Secretary General, World Federation of Nuclear Medicine and Biology',
            'Miss Mariana Pinto \u2013 Radiographers, Technologists &amp; Nurses Committee Co-Chair',
            'Dr Ian Armstrong \u2013 Scientific &amp; Education Committee Co-Chair',
            'Miss Monica Martins \u2013 Radiographers, Technologists &amp; Nurses Committee Co-Chair',
          ]
            .map(LI)
            .join('')}</ul>`,
        h: 1240,
      },
      {
        type: 'text',
        heading: 'The Role of the Council',
        bullets: true,
        html:
          P('The Council meets regularly throughout the year to provide leadership and oversight for the Society.') +
          P('Its responsibilities include:') +
          `<ul>${[
            'Setting the strategic direction of BNMS.',
            'Supporting education, research and professional development.',
            'Promoting professional standards and best practice.',
            'Overseeing the governance and financial stewardship of the Society.',
            'Representing the interests of BNMS members.',
            'Supporting collaboration across the multidisciplinary nuclear medicine community.',
            'Helping shape the future of nuclear medicine in the UK.',
          ]
            .map(LI)
            .join('')}</ul>` +
          P('The Council works closely with the Society\u2019s Professional Groups, Committees, Regional Leads and office team to deliver the Society\u2019s activities and support its members.'),
        h: 720,
      },
      {
        type: 'feature',
        heading: 'National & International Representation',
        html:
          P('Many Council members also represent BNMS on national and international organisations, advisory groups and professional bodies.') +
          P('These appointments help ensure the views and expertise of the UK nuclear medicine community contribute to developments in education, research, workforce planning, professional standards and healthcare policy.'),
        buttons: ['Download the current BNMS Representatives list (PDF)'],
        h: 340,
      },
      {
        type: 'feature',
        heading: 'Interested in Getting Involved?',
        html:
          P('BNMS is strengthened by members who contribute their knowledge, experience and enthusiasm through leadership and volunteering.') +
          P('If you would like to become involved with the work of the Society, explore our Professional Groups &amp; Committees or find out more about volunteering opportunities.'),
        buttons: ['Professional Groups & Committees', 'Volunteer with BNMS'],
        h: 260,
      },
    ],
  }),
};

const REGIONAL_LEADS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'regional-leads',
  title: 'Regional Leads',
  design: buildDesign({
    hero: {
      headline: 'Regional Leads',
      subheadline:
        'Connecting the British Nuclear Medicine Society with members across the United Kingdom through local leadership and support.',
      ctaLabel: 'Contact Your Regional Lead',
      bgImageUrl: HERO_IMG_OPEN,
    },
    sections: [
      {
        type: 'feature',
        heading: 'Supporting Members Across the UK',
        html:
          P('BNMS Regional Leads act as local ambassadors for the Society, helping to strengthen connections between members and the wider nuclear medicine community.') +
          P('Working closely with the BNMS Council, Professional Groups and Committees, Regional Leads encourage collaboration, share information about Society activities and provide a local point of contact for members within their region.') +
          P('Whether you are looking to become more involved with BNMS, connect with colleagues or find out about local activities, your Regional Lead is here to help.'),
        h: 400,
      },
      {
        type: 'feature',
        heading: 'Find Your Regional Lead',
        html:
          P('Our Regional Leads represent BNMS throughout the United Kingdom, helping to maintain strong links with the nuclear medicine community and ensuring members\u2019 views and experiences are reflected within the Society.') +
          P('Use the list below to find your Regional Lead.'),
        h: 240,
      },
      {
        type: 'text',
        heading: 'BNMS Regional Leads',
        bullets: true,
        html: `<ul>${[
          'Scotland \u2013 Dr David Colville \u2013 Glasgow Royal Infirmary',
          'Northern Ireland \u2013 Mr Conor Ferris \u2013 Belfast City Hospital',
          'North East \u2013 Dr George Petrides \u2013 Freeman Hospital, Newcastle upon Tyne',
          'North West \u2013 Dr Rakesh Sajjan \u2013 Central Manchester University NHS Foundation Trust',
          'Yorkshire &amp; the Humber \u2013 Mr Najeeb Ahmed \u2013 Hull University Teaching Hospitals NHS Trust',
          'East Midlands \u2013 Dr Susan Geary \u2013 Nottingham University Hospitals NHS Trust',
          'West Midlands \u2013 Dr Alp Notghi \u2013 City Hospital, Birmingham',
          'North Wales \u2013 Dr David Jones \u2013 Wrexham Maelor Hospital',
          'South Wales \u2013 Dr Patrick Fielding \u2013 University Hospital of Wales, Cardiff',
          'East of England (East Anglia) \u2013 Ms Evelyn Shin \u2013 Addenbrooke\u2019s Hospital, Cambridge',
          'North Thames (London) \u2013 Dr Deena Neriman \u2013 University College Hospital, London',
          'South Thames (London) \u2013 Mr Eugene Lee \u2013 Guy\u2019s &amp; St Thomas\u2019 NHS Foundation Trust',
          'South West \u2013 Mr Peter Young \u2013 Bristol Royal Infirmary',
          'South East &amp; Wessex \u2013 Dr Francis Sundram \u2013 Southampton General Hospital',
          'Oxfordshire, Berkshire &amp; Buckinghamshire \u2013 Dr Daniel McGowan \u2013 Churchill Hospital, Oxford',
        ]
          .map(LI)
          .join('')}</ul>`,
        h: 1100,
      },
      {
        type: 'feature',
        heading: 'Working Together',
        html:
          P('Regional Leads play an important role in helping BNMS maintain strong relationships with members across the UK.') +
          P('By encouraging communication, supporting local engagement and promoting Society activities, they help ensure BNMS remains connected to the needs of the multidisciplinary nuclear medicine community.') +
          P('If you have questions, suggestions or would like to become more involved with BNMS, your Regional Lead will be pleased to hear from you.'),
        h: 400,
      },
      {
        type: 'feature',
        heading: 'Contact Your Regional Lead',
        html:
          P('Complete the contact form below and your enquiry will be forwarded to the appropriate Regional Lead.') +
          P('If you are unsure which region you belong to, the BNMS office will be happy to help direct your enquiry.') +
          P('<strong>General Enquiries</strong>') +
          P('info@bnms.org.uk') +
          P('0115 671 5703'),
        h: 400,
      },
      {
        type: 'feature',
        heading: 'Get Involved with BNMS',
        html:
          P('Regional Leads are just one of the many ways members contribute to the work of the Society.') +
          P('If you are interested in becoming more involved, explore our Professional Groups &amp; Committees or find out more about volunteering opportunities within BNMS.'),
        buttons: ['Professional Groups & Committees', 'Volunteer with BNMS'],
        h: 260,
      },
    ],
  }),
};

const PAST_PRESIDENTS = {
  tenantId: BNMS_TENANT_ID,
  slug: 'past-presidents-of-the-bnms',
  title: 'Past Presidents of the British Nuclear Medicine Society',
  design: buildDesign({
    hero: {
      headline: 'Past Presidents of the British Nuclear Medicine Society',
      subheadline:
        'Honouring the leaders whose vision, dedication and service have helped shape BNMS and advance nuclear medicine since 1968.',
      bgImageUrl: HERO_IMG_OPEN,
    },
    sections: [
      {
        type: 'text',
        heading: 'Past Presidents',
        html: `<ul>${[
          '2023\u20132025 \u2013 Ms Jilly Croasdale \u2013 Birmingham',
          '2021\u20132023 \u2013 Prof Richard Graham \u2013 Bath',
          '2018\u20132021 \u2013 Dr John Buscombe \u2013 London',
          '2016\u20132018 \u2013 Prof Sobhan Vinjamuri \u2013 Liverpool',
          '2014\u20132016 \u2013 Dr Alp Notghi \u2013 Birmingham',
          '2012\u20132014 \u2013 Dr B J Neilly \u2013 Glasgow',
          '2010\u20132012 \u2013 Prof A C Perkins MBE \u2013 Nottingham',
          '2008\u20132010 \u2013 Dr G Vivian \u2013 Cornwall',
          '2006\u20132008 \u2013 Dr J W Frank \u2013 London',
          '2004\u20132006 \u2013 Dr A J Hilson \u2013 London',
          '2002\u20132004 \u2013 Dr M C Prescott \u2013 Manchester',
          '2000\u20132002 \u2013 Prof P J Robinson \u2013 Leeds',
          '1998\u20132000 \u2013 Dr T O Nunan \u2013 London',
          '1996\u20131998 \u2013 Dr H W Gray \u2013 Glasgow',
          '1994\u20131996 \u2013 Dr D H Keeling \u2013 Plymouth',
          '1992\u20131994 \u2013 Dr Susan E M Clarke \u2013 London',
          '1990\u20131992 \u2013 Prof J H McKillop \u2013 Glasgow',
          '1988\u20131990 \u2013 Dr A J Coakley \u2013 Canterbury',
          '1986\u20131988 \u2013 Prof P S Robinson \u2013 Surrey',
          '1984\u20131986 \u2013 Dr L K Harding \u2020 \u2013 Birmingham',
          '1982\u20131984 \u2013 Prof K E Britton \u2013 London',
          '1980\u20131982 \u2013 Dr R F Jewkes \u2013 London',
          '1978\u20131980 \u2013 Prof M M Maisey \u2013 London',
          '1976\u20131978 \u2013 Dr D Croft \u2020 \u2013 London',
          '1974\u20131976 \u2013 Prof E Rhys Davies \u2013 Bristol',
          '1972\u20131974 \u2013 Prof V R McCready \u2013 Sutton',
          '1971\u20131972 \u2013 Prof E S Williams \u2020 \u2013 London',
          '1970\u20131971 \u2013 Dr T M D Gimlette \u2020 \u2013 Liverpool',
          '1969\u20131970 \u2013 Prof E M McGirr \u2020 \u2013 Glasgow',
          '1968\u20131969 \u2013 Dr C J Hayter \u2020 \u2013 Leeds',
        ]
          .map(LI)
          .join('')}</ul>`,
        h: 1760,
        bullets: true,
      },
    ],
  }),
};

// ---------------------------------------------------------------------------
// Celebrating 60 Years of BNMS — Past Presidents Webinar Series.
// Faithful reproduction of attached_assets/Presidents_Webinar_Series_*.docx.
// The document's internal layout notes ("Layout: …", "Primary CTA: …",
// "we do have images of all of these", "we have all the logos", section
// labels) are author instructions, NOT page copy — they are intentionally
// omitted. The ONLY links on the page are the four YouTube URLs given in the
// document, the /timeline secondary CTA, and the in-page anchor from the hero
// primary CTA down to the first webinar card.
//
// Headshots / logos: wired to images ALREADY in BNMS media (public-assets
// uploads). Dr Gillian Vivian has no individual headshot on file and Siemens
// Healthineers / Novartis have no logos on file, so those render as
// BNMS-branded placeholders (accent user icon / text chips) per the document's
// own instruction. Curium's logo IS on file and is used.
// ---------------------------------------------------------------------------
const BNMS_UPLOADS =
  'https://vault.iconn.app/storage/v1/object/public/public-assets/ff2df806-b321-4254-b651-3af11fccf1db/uploads/';
const CPD_LINE =
  '<em>CPD: This webinar provides 1 CPD credit in accordance with the CPD Scheme of The Royal College of Radiologists.</em>';
const LO_1 =
  'Explore the history of BNMS and gain insight into current and future directions from the perspective of BNMS Presidents.';

const PRESIDENTS_WEBINAR_SERIES = {
  tenantId: BNMS_TENANT_ID,
  slug: 'past-presidents-webinar-series',
  title: 'Celebrating 60 Years of BNMS – Past Presidents Webinar Series',
  design: buildDesign({
    // BNMS default branding (orange accent, blue hero) + the 60th-anniversary
    // logo lockup already in BNMS media, per the document's "BNMS 60th
    // branding" hero note.
    theme: {
      ...THEMES.bnms,
      logoUrl: `${BNMS_UPLOADS}1778755163973-x5fbrep-1768490734727-cb475f2-60th_logo.png`,
    },
    hero: {
      headline: 'Celebrating 60 Years of BNMS',
      subheadline:
        'Past Presidents Webinar Series — Six decades of leadership, innovation and collaboration in nuclear medicine.',
      ctaLabel: 'Watch the Webinar Recordings',
      ctaHref: '#watch-webinars',
      cta2Label: 'Explore the 60th Anniversary Timeline',
      cta2Href: '/timeline',
      cta2Variant: 'tenant:secondary',
      // Montage of past Presidents already in BNMS media.
      bgImageUrl: `${BNMS_UPLOADS}1783335573232-w3snwgs-1781524640938-qk9r6hl-Graham_Dizdarevic_Notghi_Clarke_Vivian_Buscombe_Prescott_McCready_Neilly_Frank_Croasdale.jpg`,
    },
    intro: {
      icon: 'fa-solid fa-video',
      html:
        `<p style="text-align: left;"><span style="font-size: 20px;">As part of the British Nuclear Medicine Society\u2019s 60th Anniversary celebrations, we were proud to present a special webinar series bringing together former BNMS Presidents to reflect on the Society\u2019s remarkable journey and the future of nuclear medicine.</span></p>` +
        `<p style="text-align: left;"><span style="font-size: 20px;">Hosted by Professor Sabina Dizdarevic, BNMS President, each webinar features conversations with past Presidents alongside expert presentations exploring key developments within the specialty.</span></p>` +
        `<p style="text-align: left;"><span style="font-size: 20px;">Together, these sessions celebrate the people, achievements and innovations that have shaped BNMS over the past six decades while looking ahead to the future of nuclear medicine.</span></p>`,
      h: 340,
    },
    sections: [
      {
        type: 'cards',
        heading: 'Webinar Series',
        columns: 1,
        cards: [
          {
            anchorId: 'watch-webinars',
            heading: 'Celebrating our Past and Present, Shaping the Future',
            h: 860,
            body:
              P('<strong>13 January 2026</strong>') +
              P('<strong>Featuring:</strong>') +
              `<ul>${LI('Prof John Buscombe')}${LI('Dr David Keeling')}${LI('Prof Sobhan Vinjamuri')}</ul>` +
              P('<strong>Hosted by:</strong> Professor Sabina Dizdarevic') +
              P('<strong>Featured Presentation</strong>') +
              P('<em>Molecular Radiotherapy (MRT): To Infinity and Beyond</em>') +
              P('Professor John Buscombe') +
              P('<strong>Learning Objectives</strong>') +
              `<ul>${LI(LO_1)}${LI('Provide an update on the role of hybrid imaging, cutting-edge diagnostics and theragnostics.')}</ul>` +
              P(CPD_LINE),
            cta: 'Watch on YouTube',
            ctaHref: 'https://www.youtube.com/watch?v=fJiURq4aqDU&feature=youtu.be',
          },
          {
            heading: 'Women in BNMS Leadership & Past, Present and Future of Nuclear Medicine',
            h: 1240,
            body:
              P('<strong>10 February 2026</strong>') +
              P('Join us for an interview with four female past Presidents, hosted by current President Prof Sabina Dizdarevic.') +
              P('<strong>Featuring:</strong>') +
              `<ul>${LI('Dr Sue Clarke')}${LI('Dr Mary Prescott')}${LI('Dr Gillian Vivian')}${LI('Ms Jilly Croasdale')}</ul>` +
              P('<strong>Session Focus</strong>') +
              P('This webinar explores the challenges they faced, the inspirations that shaped their leadership and the key achievements of their terms, including perspectives on gender equality in medicine.') +
              P('The panel also reflects on how the specialty has evolved, shares views on the future of nuclear medicine and discusses how, together with members, BNMS can continue to shape the direction of the field.') +
              P('<strong>Featured Presentation</strong>') +
              P('<em>Working Together to Prioritise Urgent Patient Needs During a Molybdenum Shortage</em>') +
              P('Ms Jilly Croasdale, Immediate Past President') +
              P('<strong>Learning Objectives</strong>') +
              `<ul>${LI(LO_1)}${LI('Promote gender equality in leadership within medicine, highlighting progress, challenges and opportunities for the future.')}${LI('Provide an update on the recent molybdenum shortage, including prioritisation of nuclear medicine procedures and how working collectively as a multi-professional community can help overcome major operational challenges.')}</ul>` +
              P(CPD_LINE),
            cta: 'Watch on YouTube',
            ctaHref: 'https://www.youtube.com/watch?v=zG70PLgAUkE',
          },
          {
            // The document supplies no title line for this webinar — the date
            // heads the card; nothing is invented.
            heading: '24 March 2026',
            h: 620,
            body:
              P('<strong>Featuring:</strong>') +
              `<ul>${LI('Prof Alan Perkins')}${LI('Dr Alp Notghi')}</ul>` +
              P('<strong>With participation from:</strong> Mr Charnie Kalirai, BNMS Honorary Treasurer') +
              P('<strong>Learning Objectives</strong>') +
              `<ul>${LI('Gain up-to-date knowledge of intraoperative probe technologies development and explain their potential impact on surgical and diagnostic practice.')}${LI('Discuss how technological advances and robust incident-management strategies contribute to service resilience.')}</ul>` +
              P(CPD_LINE),
            cta: 'Watch on YouTube',
            ctaHref: 'https://www.youtube.com/watch?v=R5ifIq028mQ&feature=youtu.be',
          },
          {
            heading: '14 April 2026',
            h: 620,
            body:
              P('<strong>Featuring:</strong>') +
              `<ul>${LI('Prof Michael Maisey')}${LI('Prof Richard Graham')}</ul>` +
              P('<strong>With participation from:</strong> Dr Amy Eccles, BNMS Honorary Secretary') +
              P('<strong>Learning Objectives</strong>') +
              `<ul>${LI('Describe the historical milestones that shaped the development of PET, from its conceptual origins to its clinical adoption.')}${LI('Highlight how the evolution of PET informs current clinical guidelines and outline how emerging developments are likely to shape future recommendations.')}</ul>` +
              P(CPD_LINE),
            cta: 'Watch on YouTube',
            ctaHref: 'https://www.youtube.com/watch?v=vdFtPIr1gXs',
          },
        ],
      },
      {
        type: 'cards',
        heading: 'Past Presidents Featured in the Series',
        columns: 4,
        cardH: 420,
        cards: [
          { heading: 'Dr John Buscombe', body: '', imageUrl: `${BNMS_UPLOADS}1774339384390-7migy2o-John_Buscombe_image.png` },
          { heading: 'Dr David Keeling', body: '', imageUrl: `${BNMS_UPLOADS}1774342490563-v91bu85-David_Keeling_imagev2.jpg` },
          { heading: 'Prof Sobhan Vinjamuri', body: '', imageUrl: `${BNMS_UPLOADS}1774339174515-sk7vfjp-2016.04.17_Sobhan_Vinjamuri_image.png` },
          // No individual headshot in BNMS media — branded placeholder icon.
          { heading: 'Dr Gillian Vivian', body: '', icon: 'fa-solid fa-user' },
          { heading: 'Ms Jilly Croasdale', body: '', imageUrl: `${BNMS_UPLOADS}1777125826067-cr7t2md-jilly_croasdale_hon_treasure.jpg` },
          { heading: 'Dr Mary Prescott', body: '', imageUrl: `${BNMS_UPLOADS}1774342960431-c9t0vdm-BNMS_2002_President_Mary_Prescott_in_Robe_President_2002-2006.jpg` },
          { heading: 'Dr Sue Clarke', body: '', imageUrl: `${BNMS_UPLOADS}1774009690259-gd6kusi-1992.04.06_Sue_Clarke_image.JPG` },
          { heading: 'Prof Alan Perkins', body: '', imageUrl: `${BNMS_UPLOADS}1777132190939-0h8xcyn-alan_perkins_2025.jpg` },
          { heading: 'Dr Alp Notghi', body: '', imageUrl: `${BNMS_UPLOADS}1774342273207-67b80bi-Alp_Notghi_image.png` },
          { heading: 'Prof Michael Maisey', body: '', imageUrl: `${BNMS_UPLOADS}1771846006277-hd0gvd2-1978.01.01_Michael_Maisey_image.jpg` },
          { heading: 'Prof Richard Graham', body: '', imageUrl: `${BNMS_UPLOADS}1774344319621-2kz241c-2021.09.27_Richard_Graham_image.png` },
        ],
      },
      {
        type: 'cards',
        heading: 'Thank You to Our Sponsors',
        subheading: 'Series Sponsors',
        columns: 2,
        cardH: 140,
        // No Siemens Healthineers / Novartis logos in BNMS media yet — branded
        // text chips until the user supplies logos.
        cards: [
          { heading: 'Siemens Healthineers', body: '' },
          { heading: 'Novartis', body: '' },
        ],
      },
      {
        type: 'cards',
        subheading: 'Supporting Sponsor',
        columns: 2,
        cardH: 300,
        cards: [
          {
            heading: 'Curium',
            body: P('March webinar only'),
            imageUrl: `${BNMS_UPLOADS}1783009348427-gm39tpa-curium_300_x_125.png`,
          },
        ],
      },
    ],
  }),
};

const PAGES = [
  MRT_HOME,
  MRT_COMMITTEE,
  MRT_PATIENT_STORIES,
  MRT_RESOURCES,
  UKRG_HOME,
  UKRG_ABOUT,
  UKRG_ABOUT_NEW,
  UKRG_COMMITTEE,
  UKRG_EDUCATION,
  UKRG_NEWS,
  UKRG_RESOURCES,
  UKRG_SAFETY,
  STUDENT_PRIZE,
  WELCOME_COMMITTEE,
  SCIENTIFIC_EDUCATION,
  RESEARCH_INNOVATION,
  RADIOPHARMACEUTICAL_SCIENCES,
  RTN_COMMITTEE,
  PROFESSIONAL_STANDARDS,
  PEOPLE,
  ABOUT_US,
  IN_MEMORIAM,
  DR_AJIT_KUMAR_PADHY,
  GOVERNANCE,
  DOI_SPEAKERS,
  DOI,
  CLINICAL_SCIENTISTS,
  MEDICAL_TRAINING,
  RESEARCH_CHAMPIONS,
  PREPARING_APPOINTMENT_NEW,
  AWARDS_RECOGNITION,
  APPRENTICESHIPS,
  ANNUAL_ACHIEVEMENTS,
  RESEARCH_PRESENTATION_AWARDS,
  RTN_AWARD,
  PRESIDENTS_MEDAL_PRIZE,
  NORMAN_VEALL_MEDAL,
  MEDICAL_TRAINING_ESSAY,
  INNOVATIVE_TEAM_AWARD,
  ABOUT_US_NEW,
  TRAVELLING_FELLOWSHIPS_NEW,
  MALLARD_NEW,
  FOGELMAN_NEW,
  TESTA_NEW,
  WILLIAMS_NEW,
  CRANE_NEW,
  GIMLETTE_NEW,
  BAYLY_NEW,
  BUXTON_THOMAS_NEW,
  HARDING_NEW,
  GEMMELL_NEW,
  CROFT_NEW,
  REGIONAL_MEETING_SUPPORT_NEW,
  PROMOTE_YOUR_EVENT_NEW,
  ORGANISE_EVENT_NEW,
  COURSE_ENDORSEMENT_NEW,
  CARDIAC_SPECT_COURSE_NEW,
  RTN_COMMITTEE_NEW,
  SCIENTIFIC_EDUCATION_NEW,
  PAST_PRESIDENTS,
  ABOUT_BNMS,
  GOVERNANCE_NEW,
  BNMS_COUNCIL,
  REGIONAL_LEADS,
  PRESIDENTS_WEBINAR_SERIES,
];

// ---------------------------------------------------------------------------
// Upsert (idempotent on tenant_id + slug).
// ---------------------------------------------------------------------------
async function provision(page, { apply, dumpJson }) {
  const { tenantId, slug, title, design } = page;

  if (dumpJson) {
    console.log(JSON.stringify(design));
    return;
  }

  const { data: existing, error: selErr } = await supabase
    .from('i_edit_page')
    .select('id, slug, builder_type, status')
    .eq('tenant_id', tenantId)
    .eq('slug', slug)
    .maybeSingle();

  if (selErr) {
    console.error(`[${slug}] lookup failed:`, selErr.message);
    return;
  }

  const childCount = design.root.sections[0].children.length;

  if (existing) {
    if (existing.builder_type !== 'canvas') {
      console.error(`[${slug}] existing row is builder_type='${existing.builder_type}' (immutable). Aborting to avoid corruption.`);
      return;
    }
    console.log(`[${slug}] existing canvas page ${existing.id} — will UPDATE (${childCount} blocks).`);
    if (!apply) {
      console.log(`[${slug}] dry-run: no write performed.`);
      return;
    }
    const { error: updErr } = await supabase
      .from('i_edit_page')
      .update({
        title,
        status: 'published',
        published_at: new Date().toISOString(),
        layout_type: 'public',
        public_chrome: 'both',
        hide_chrome: false,
        element_ids: [],
        search_text: title,
        canvas_design: design,
      })
      .eq('id', existing.id);
    if (updErr) console.error(`[${slug}] update failed:`, updErr.message);
    else console.log(`[${slug}] updated OK.`);
    return;
  }

  console.log(`[${slug}] no existing row — will INSERT (${childCount} blocks).`);
  if (!apply) {
    console.log(`[${slug}] dry-run: no write performed.`);
    return;
  }
  const { data: inserted, error: insErr } = await supabase
    .from('i_edit_page')
    .insert({
      tenant_id: tenantId,
      organization_id: null,
      title,
      slug,
      description: '',
      status: 'published',
      published_at: new Date().toISOString(),
      layout_type: 'public',
      public_chrome: 'both',
      hide_chrome: false,
      element_ids: [],
      search_text: title,
      builder_type: 'canvas',
      canvas_design: design,
    })
    .select('id')
    .single();
  if (insErr) console.error(`[${slug}] insert failed:`, insErr.message);
  else console.log(`[${slug}] inserted OK: ${inserted.id}`);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  // --json: print the built canvas_design for the selected page(s) to stdout
  // (no DB access) so content fidelity can be verified before applying.
  const dumpJson = args.includes('--json');
  const slugArg = args.find((a) => a.startsWith('--slug='))?.split('=')[1];

  const targets = slugArg ? PAGES.filter((p) => p.slug === slugArg) : PAGES;
  if (targets.length === 0) {
    console.error(`No page spec matches --slug=${slugArg}`);
    process.exit(1);
  }

  if (!dumpJson) console.log(`Mode: ${apply ? 'APPLY (writing to DEST)' : 'DRY-RUN (no writes)'}`);
  for (const page of targets) {
    await provision(page, { apply, dumpJson });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
