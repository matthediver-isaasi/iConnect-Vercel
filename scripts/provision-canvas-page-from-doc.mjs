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
import { buildDesign } from '../api/_lib/canvasLayoutEngine.js';

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
        type: 'placeholder',
        heading: 'Committee Leadership & Members',
        note: NOTE('The Scientific & Education Committee leadership \u2014 including the Co-Chairs and Deputy Chair \u2014 together with the full committee membership will be displayed here through the searchable member directory.'),
        h: 150,
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
        type: 'placeholder',
        heading: 'Committee Members',
        note: NOTE('The full membership of the Professional Standards Committee, together with the areas each member represents, will be displayed here through the searchable member directory.'),
        h: 150,
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
      subheadline: 'Supporting medical students and doctors in training to explore and develop careers in nuclear medicine.',
      ctaLabel: 'Explore Careers',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-user-doctor',
      strapline: 'About the Medical Training Committee',
      html:
        P('The BNMS Medical Training Committee supports medical students and doctors in training who are interested in nuclear medicine.') +
        P('The Committee works to raise awareness of the specialty, provide opportunities for learning and development, and encourage the next generation of nuclear medicine physicians.'),
      h: 300,
    },
    sections: [
      {
        type: 'text',
        heading: 'Our Aims',
        html:
          P('The Committee works to:') +
          `<ul>${LI('Raise awareness of nuclear medicine as a career.')}${LI('Support medical students and doctors in training.')}${LI('Provide opportunities for learning, research and presentation.')}${LI('Encourage engagement with BNMS and the wider community.')}</ul>`,
        h: 320,
      },
      {
        type: 'placeholder',
        heading: 'Committee Leadership & Members',
        note: NOTE('The Medical Training Committee leadership and its full membership will be displayed here through the searchable member directory.'),
        h: 150,
      },
      {
        type: 'cards',
        heading: 'Opportunities for Trainees',
        columns: 3,
        cardH: 540,
        cards: [
          {
            icon: 'fa-solid fa-pen-nib',
            heading: 'Medical Training Essay Competition',
            body:
              P('An opportunity for medical students and doctors in training to showcase their knowledge and presentation skills.') +
              P('The two highest-scoring entrants are invited to give a seven-minute oral presentation at the BNMS Annual Spring Meeting. Winners receive a Certificate of Merit, complimentary one-day conference registration and reimbursement of UK economy travel expenses.') +
              P('<strong>Current status:</strong> submissions are currently closed.'),
          },
          {
            icon: 'fa-solid fa-globe',
            heading: 'NEXUS-NL Weekend',
            body:
              P('An international event for university students and young professionals with an interest in nuclear medicine.') +
              P('The programme combines education, networking and personal development, helping participants build relationships and learn from colleagues across Europe.') +
              P('<strong>18\u201320 September 2026</strong>'),
            cta: 'Find Out More',
          },
          {
            icon: 'fa-solid fa-award',
            heading: 'Residents4Residents at EANM\u201926',
            body:
              P('The European Association of Nuclear Medicine offers residents the opportunity to present clinical PET cases during the Residents4Residents session at the annual congress.') +
              P('Successful applicants receive complimentary EANM Congress registration, three nights\u2019 accommodation, and the opportunity to present alongside international colleagues.'),
            cta: 'Read More',
          },
        ],
      },
    ],
    closingHero: {
      headline: 'Supporting the Next Generation of Nuclear Medicine',
      subheadline: 'Whether you are exploring a career in nuclear medicine or already in training, BNMS offers opportunities to learn, connect and develop throughout your professional journey.',
      ctaLabel: 'Explore Careers',
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
      subheadline: 'Celebrating the people whose dedication, leadership and service continue to shape nuclear medicine.',
      ctaLabel: 'Nominate a Colleague',
      bgImageUrl: HERO_IMG_OPEN,
    },
    intro: {
      icon: 'fa-solid fa-trophy',
      strapline: 'Celebrating Excellence in Nuclear Medicine',
      html:
        P('The British Nuclear Medicine Society is proud to recognise the individuals whose dedication, leadership and service have made an outstanding contribution to nuclear medicine.') +
        P('Our awards celebrate excellence across the profession and honour the people who continue to shape and strengthen the specialty.'),
      h: 320,
    },
    sections: [
      {
        type: 'text',
        heading: 'Our Awards',
        html:
          P('BNMS presents a number of awards recognising achievement, leadership and outstanding contribution to nuclear medicine.') +
          P('Each award celebrates a different aspect of the dedication and expertise found across our community.'),
        h: 240,
      },
      {
        type: 'text',
        heading: 'President\u2019s Medal & President\u2019s Prize',
        html:
          P('The President\u2019s Medal is awarded in recognition of an exceptional and sustained contribution to nuclear medicine and to the British Nuclear Medicine Society.') +
          P('The President\u2019s Prize recognises outstanding achievement and service to the Society.') +
          P('These are among the highest honours BNMS can bestow.'),
        cta: 'Learn More',
        h: 340,
      },
      {
        type: 'text',
        heading: 'Norman Veall Medal',
        html:
          P('The Norman Veall Medal recognises a distinguished and lasting contribution to the science of nuclear medicine.') +
          P('It honours the legacy of Norman Veall, a pioneer of British nuclear medicine.'),
        cta: 'Learn More',
        h: 300,
      },
      {
        type: 'text',
        heading: 'Radiographers, Technologists & Nurses Award',
        html:
          P('The Radiographers, Technologists & Nurses (RTN) Award recognises outstanding contribution by a Radiographer, Technologist or Nurse working within nuclear medicine.') +
          P('It celebrates the vital role these professionals play in delivering high-quality patient care.'),
        h: 260,
      },
      {
        type: 'accordion',
        h: 320,
        items: [
          {
            q: 'About the Award',
            a:
              P('The RTN Award is presented each year to a Radiographer, Technologist or Nurse who has made an outstanding contribution to nuclear medicine.') +
              P('The award recognises excellence in practice, leadership, education or service to the profession.'),
          },
          {
            q: 'Nominations',
            a:
              P('Nominations are welcomed from members across the nuclear medicine community.') +
              P('Nominees should have demonstrated an outstanding contribution to the profession through their work, leadership or service.'),
          },
          {
            q: 'Previous Recipients',
            a:
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
                LI('<strong>2013</strong> \u2014 Bernadette Cronin, The Royal Marsden Hospital') +
                LI('<strong>2011</strong> \u2014 John Jones, Cardiff & Vale NHS Trust') +
                LI('<strong>2010</strong> \u2014 Sally Farrell, Derriford Hospital') +
                LI('<strong>2009</strong> \u2014 Robert Blair, Sunderland Royal Infirmary') +
                LI('<strong>2008</strong> \u2014 Joyce Davidson, Aberdeen Royal Infirmary')
              }</ul>`,
          },
        ],
      },
      {
        type: 'text',
        heading: 'Roll of Honour',
        html:
          P('The BNMS Roll of Honour records the individuals who have received the Society\u2019s awards over the years.') +
          P('It stands as a lasting tribute to those whose contributions have shaped nuclear medicine.') +
          P('Explore the Roll of Honour to discover the people behind these achievements.'),
        cta: 'Explore the Roll of Honour',
        h: 320,
      },
      {
        type: 'feature',
        heading: 'Celebrating the People Behind BNMS',
        html:
          P('Behind every award is a colleague whose dedication has made a real difference to the profession.') +
          P('We are proud to celebrate the people who give their time, expertise and commitment to nuclear medicine.') +
          P('You can also read tributes to colleagues we remember on our In Memoriam page.'),
        buttons: ['Celebrate a Colleague', 'In Memoriam'],
        h: 360,
      },
      {
        type: 'feature',
        heading: 'Celebrating Research and Innovation',
        html:
          P('BNMS also recognises excellence in research and innovation through a range of research awards and prizes.') +
          P('These awards celebrate the discoveries and ideas that continue to advance nuclear medicine.'),
        cta: 'Explore Research Awards',
        h: 300,
      },
    ],
    closingHero: {
      headline: 'Help Us Recognise Excellence',
      subheadline: 'Every achievement helps strengthen our profession and inspire future generations. If you know someone whose contribution deserves recognition, we would love to hear from you.',
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
        P('The UKRG Committee is made up of radiopharmacy professionals who volunteer their time to support and represent the profession.') +
        P('Committee members bring experience from across hospital, manufacturing and research settings, working together to guide the Group and deliver its activities.'),
      h: 220,
    },
    sections: [
      {
        type: 'text',
        heading: 'What the Committee Does',
        bullets: true,
        html:
          P('The Committee leads and supports the work of the UKRG, including:') +
          `<ul>${LI('Developing professional guidance and reference resources.')}${LI('Supporting education, events and professional development.')}${LI('Promoting quality improvement and patient safety.')}${LI('Representing the profession and working with partner organisations.')}</ul>` +
          P('Committee members are elected and co-opted from across the radiopharmacy community.'),
        h: 380,
      },
      {
        type: 'placeholder',
        heading: 'Meet the Committee',
        note: NOTE('The current UKRG Committee members, their roles and areas of responsibility will be displayed here through the committee directory.'),
        h: 150,
      },
      {
        type: 'feature',
        heading: 'Working Groups',
        html:
          P('Alongside the main Committee, the UKRG runs working groups that focus on specific areas such as guidance development, quality assurance and education.') +
          P('These groups draw on the expertise of members across the profession to deliver focused, practical outcomes.'),
        h: 240,
      },
      {
        type: 'feature',
        heading: 'Get Involved',
        html:
          P('The UKRG is powered by the enthusiasm and expertise of its members. There are many ways to contribute, from joining a working group to standing for the Committee.') +
          P('If you would like to help shape the future of radiopharmacy, we would love to hear from you.'),
        h: 240,
        cta: 'Find Out How to Get Involved',
      },
      {
        type: 'feature',
        heading: 'Working with BNMS',
        html:
          P('The UKRG Committee works closely with the British Nuclear Medicine Society (BNMS) to represent radiopharmacy within the wider nuclear medicine community.'),
        h: 180,
      },
    ],
    closingHero: {
      headline: 'Contact the Committee',
      subheadline:
        'Have a question or want to get involved? The UKRG Committee is always happy to hear from members and colleagues.',
      ctaLabel: 'Contact the Committee',
      bgImageUrl: HERO_IMG_CLOSE,
    },
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
        type: 'placeholder',
        heading: 'Meet the Committee',
        note: NOTE('The current Consortium Committee members, their roles and organisations will be displayed here through the committee directory.'),
        h: 150,
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

const PAGES = [
  MRT_HOME,
  MRT_COMMITTEE,
  MRT_PATIENT_STORIES,
  MRT_RESOURCES,
  UKRG_HOME,
  UKRG_ABOUT,
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
  GOVERNANCE,
  DOI_SPEAKERS,
  DOI,
  CLINICAL_SCIENTISTS,
  MEDICAL_TRAINING,
  AWARDS_RECOGNITION,
  APPRENTICESHIPS,
  ANNUAL_ACHIEVEMENTS,
];

// ---------------------------------------------------------------------------
// Upsert (idempotent on tenant_id + slug).
// ---------------------------------------------------------------------------
async function provision(page, { apply }) {
  const { tenantId, slug, title, design } = page;

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
  const slugArg = args.find((a) => a.startsWith('--slug='))?.split('=')[1];

  const targets = slugArg ? PAGES.filter((p) => p.slug === slugArg) : PAGES;
  if (targets.length === 0) {
    console.error(`No page spec matches --slug=${slugArg}`);
    process.exit(1);
  }

  console.log(`Mode: ${apply ? 'APPLY (writing to DEST)' : 'DRY-RUN (no writes)'}`);
  for (const page of targets) {
    await provision(page, { apply });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
