// AI Design Studio V2 Phase 0 — hand-authored BNMS "I'm having a scan" proof
// fixture (Task #2904, spec §2/§25).
//
// This is the RAW V2 code package (schemaVersion "2.0") exactly as a model
// would return it: semantic HTML + inline SVG + un-scoped CSS with design
// tokens on :root. It must pass runAiCodePipeline unchanged, and the scoped
// output must render inside the ai-code-composition Canvas block.
//
// Structure mirrors the benchmark package described in the spec:
//   two-column hero with a bespoke inline-SVG scanner illustration and
//   layered labels · reassurance strip · four-stage patient journey ·
//   highlighted safety panel · six scan-information cards ·
//   <details>-based FAQ · closing CTA. Responsive Grid/Flex at 1024/640.
//   No JavaScript, no external resources.

const HTML = `
<section data-ai-id="scan-hero" class="scan-hero">
  <div class="scan-hero-inner">
    <div class="scan-hero-copy">
      <p class="scan-eyebrow" data-ai-id="scan-hero-eyebrow">Patients &amp; carers</p>
      <h1 data-ai-id="scan-hero-heading">I&rsquo;m having a scan</h1>
      <p class="scan-lead" data-ai-id="scan-hero-lead" data-content-key="hero_lead">
        A nuclear medicine scan is a safe, routine test that helps your care team
        see how part of your body is working. This page explains what happens
        before, during and after your appointment &mdash; so you know exactly
        what to expect.
      </p>
      <div class="scan-hero-actions">
        <a data-ai-id="hero-find-scan" data-ai-action="find-scan" class="scan-btn scan-btn-primary" href="#">Find your scan</a>
        <a data-ai-id="hero-faq-link" class="scan-btn scan-btn-ghost" href="#scan-faq">Common questions</a>
      </div>
    </div>
    <figure class="scan-hero-art" data-ai-id="scan-hero-illustration">
      <svg viewBox="0 0 420 320" role="img" aria-labelledby="scanArtTitle scanArtDesc">
        <title id="scanArtTitle">Illustration of a patient having a scan</title>
        <desc id="scanArtDesc">A stylised gamma camera arcs over a patient lying comfortably on a scanner bed.</desc>
        <defs>
          <linearGradient id="scanSky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#eef6fb"/>
            <stop offset="1" stop-color="#d9ecf6"/>
          </linearGradient>
          <linearGradient id="scanArc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#1c6ea4"/>
            <stop offset="1" stop-color="#2f9e8f"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="420" height="320" rx="24" fill="url(#scanSky)"/>
        <circle cx="352" cy="58" r="30" fill="#f7c948" opacity="0.85"/>
        <path d="M60 210 a150 150 0 0 1 300 0" fill="none" stroke="url(#scanArc)" stroke-width="18" stroke-linecap="round"/>
        <rect x="178" y="52" width="64" height="46" rx="10" fill="#1c6ea4"/>
        <rect x="196" y="98" width="28" height="26" rx="6" fill="#155a87"/>
        <rect x="52" y="216" width="316" height="26" rx="13" fill="#ffffff" stroke="#c3d9e8"/>
        <ellipse cx="120" cy="206" rx="18" ry="14" fill="#f2b9a0"/>
        <rect x="134" y="196" width="150" height="22" rx="11" fill="#2f9e8f"/>
        <rect x="278" y="198" width="66" height="18" rx="9" fill="#7fc4b8"/>
        <rect x="52" y="242" width="14" height="42" fill="#9db9cc"/>
        <rect x="354" y="242" width="14" height="42" fill="#9db9cc"/>
        <g class="scan-art-label">
          <rect x="36" y="120" width="126" height="34" rx="17" fill="#ffffff" stroke="#c3d9e8"/>
          <circle cx="56" cy="137" r="6" fill="#2f9e8f"/>
          <text x="68" y="142" font-size="13" font-family="inherit" fill="#15425f">Gamma camera</text>
        </g>
        <g class="scan-art-label">
          <rect x="252" y="252" width="132" height="34" rx="17" fill="#ffffff" stroke="#c3d9e8"/>
          <circle cx="272" cy="269" r="6" fill="#1c6ea4"/>
          <text x="284" y="274" font-size="13" font-family="inherit" fill="#15425f">Comfortable bed</text>
        </g>
      </svg>
      <figcaption class="scan-visually-hidden">The scanner never touches you and the bed stays still for most scans.</figcaption>
    </figure>
  </div>
</section>

<section data-ai-id="scan-reassurance" class="scan-reassure" aria-label="Reassurance">
  <ul class="scan-reassure-list">
    <li data-ai-id="reassure-painless"><strong>Painless</strong><span>The scan itself doesn&rsquo;t hurt &mdash; you simply lie still.</span></li>
    <li data-ai-id="reassure-time"><strong>30&ndash;60 minutes</strong><span>Most appointments are over within the hour.</span></li>
    <li data-ai-id="reassure-dose" data-content-key="dose_statement"><strong>Very small dose</strong><span>The tracer dose is comparable to other routine imaging.</span></li>
    <li data-ai-id="reassure-home"><strong>Home the same day</strong><span>Nearly everyone goes straight home afterwards.</span></li>
  </ul>
</section>

<section data-ai-id="scan-journey" class="scan-journey">
  <h2 data-ai-id="scan-journey-heading">Your appointment, step by step</h2>
  <ol class="scan-journey-steps">
    <li data-ai-id="journey-before">
      <span class="scan-step-num" aria-hidden="true">1</span>
      <h3>Before you arrive</h3>
      <p>Your letter tells you if you need to stop eating, drink extra water or pause any medicines. If nothing is mentioned, carry on as normal.</p>
    </li>
    <li data-ai-id="journey-tracer">
      <span class="scan-step-num" aria-hidden="true">2</span>
      <h3>The tracer</h3>
      <p>You&rsquo;ll have a small injection of a radioactive tracer. You won&rsquo;t feel any different &mdash; there may be a short wait while it settles.</p>
    </li>
    <li data-ai-id="journey-scan">
      <span class="scan-step-num" aria-hidden="true">3</span>
      <h3>The scan</h3>
      <p>You lie on the scanner bed while the camera moves slowly around you. It never touches you, and you can usually keep your own clothes on.</p>
    </li>
    <li data-ai-id="journey-after">
      <span class="scan-step-num" aria-hidden="true">4</span>
      <h3>Afterwards</h3>
      <p>You can eat, drive and go back to your day. Your results go to the doctor who referred you, usually within a couple of weeks.</p>
    </li>
  </ol>
</section>

<aside data-ai-id="scan-safety" class="scan-safety" aria-labelledby="scan-safety-heading">
  <div class="scan-safety-icon" aria-hidden="true">
    <svg viewBox="0 0 48 48" role="presentation">
      <circle cx="24" cy="24" r="22" fill="#fdf3d7" stroke="#e0b400" stroke-width="2"/>
      <rect x="22" y="12" width="4" height="18" rx="2" fill="#8a6d00"/>
      <circle cx="24" cy="35" r="2.6" fill="#8a6d00"/>
    </svg>
  </div>
  <div>
    <h2 id="scan-safety-heading" data-ai-id="scan-safety-heading">Important safety information</h2>
    <p data-ai-id="scan-safety-pregnancy" data-content-key="safety_pregnancy">
      Tell the department <strong>before your appointment</strong> if you are pregnant,
      think you might be pregnant, or are breastfeeding &mdash; the team may adjust
      or rearrange your scan.
    </p>
    <p data-ai-id="scan-safety-contact">If you have any concerns on the day, the nuclear medicine team will be happy to talk them through with you.</p>
  </div>
</aside>

<section data-ai-id="scan-types" class="scan-types">
  <h2 data-ai-id="scan-types-heading">Common types of scan</h2>
  <p class="scan-types-intro">Every scan looks at a different part of the body. Your appointment letter tells you which one you&rsquo;re having.</p>
  <div class="scan-cards">
    <article class="scan-card" data-ai-id="card-bone">
      <h3>Bone scan</h3>
      <p>Shows how your bones are working and highlights areas of change earlier than an X-ray can.</p>
    </article>
    <article class="scan-card" data-ai-id="card-thyroid">
      <h3>Thyroid scan</h3>
      <p>Checks how your thyroid gland is behaving. Usually a short scan with little preparation.</p>
    </article>
    <article class="scan-card" data-ai-id="card-kidney">
      <h3>Kidney (renogram)</h3>
      <p>Watches how each kidney takes up and clears the tracer. You&rsquo;ll be asked to drink plenty of water first.</p>
    </article>
    <article class="scan-card" data-ai-id="card-heart">
      <h3>Heart (MPI)</h3>
      <p>Looks at the blood supply to your heart muscle, sometimes in two visits &mdash; one at rest and one after gentle stress.</p>
    </article>
    <article class="scan-card" data-ai-id="card-lung">
      <h3>Lung (V/Q)</h3>
      <p>Compares the air flow and blood flow in your lungs. Often used to check for clots.</p>
    </article>
    <article class="scan-card" data-ai-id="card-pet">
      <h3>PET-CT</h3>
      <p>A detailed whole-body scan combining PET and CT pictures. You&rsquo;ll rest quietly while the tracer settles.</p>
    </article>
  </div>
</section>

<section data-ai-id="scan-faq" id="scan-faq" class="scan-faq">
  <h2 data-ai-id="scan-faq-heading">Questions patients often ask</h2>
  <details data-ai-id="faq-radioactive">
    <summary>Will I be radioactive afterwards?</summary>
    <p>The tracer loses its activity quickly and leaves your body naturally. For most scans you only need to take simple precautions, such as limiting close contact with small children for a few hours &mdash; your letter will say if this applies to you.</p>
  </details>
  <details data-ai-id="faq-eat">
    <summary>Can I eat and drink beforehand?</summary>
    <p>For many scans, yes. Some scans need you to fast or avoid caffeine &mdash; always follow your appointment letter, and if you&rsquo;re unsure, call the department.</p>
  </details>
  <details data-ai-id="faq-bring">
    <summary>What should I bring with me?</summary>
    <p>Your appointment letter, a list of your medicines, and something to pass the time if there&rsquo;s a wait after your injection. Wear comfortable clothes without metal fastenings if you can.</p>
  </details>
  <details data-ai-id="faq-children">
    <summary>Can someone come with me?</summary>
    <p>Yes &mdash; a friend or relative is welcome to accompany you, although they may be asked to wait outside the scan room. Pregnant visitors and small children are usually asked not to come into the department.</p>
  </details>
</section>

<section data-ai-id="scan-cta" class="scan-cta">
  <h2 data-ai-id="scan-cta-heading">Still have questions?</h2>
  <p>Browse our patient leaflets for detailed information about your specific scan, written by nuclear medicine professionals.</p>
  <a data-ai-id="cta-leaflets" data-ai-action="patient-leaflets" class="scan-btn scan-btn-inverse" href="#">Browse patient leaflets</a>
</section>
`;

const CSS = `
:root {
  --scan-ink: #15425f;
  --scan-ink-soft: #3f6a85;
  --scan-brand: #1c6ea4;
  --scan-accent: #2f9e8f;
  --scan-wash: #eef6fb;
  --scan-warn-bg: #fdf6e3;
  --scan-warn-edge: #e0b400;
  --scan-card-shadow: 0 14px 34px rgba(21, 66, 95, 0.12);
  --scan-radius: 16px;
}
.scan-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.scan-hero { background: linear-gradient(135deg, var(--scan-wash), #ffffff 70%); border-radius: var(--scan-radius); padding: 48px 40px; }
.scan-hero-inner { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 40px; align-items: center; max-width: 1080px; margin: 0 auto; }
.scan-eyebrow { text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.8rem; font-weight: 700; color: var(--scan-accent); margin: 0 0 8px; }
.scan-hero h1 { font-size: clamp(2rem, 4vw, 3rem); color: var(--scan-ink); margin: 0 0 16px; line-height: 1.1; }
.scan-lead { font-size: 1.125rem; color: var(--scan-ink-soft); line-height: 1.6; margin: 0 0 24px; }
.scan-hero-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.scan-btn { display: inline-block; padding: 12px 24px; border-radius: 999px; font-weight: 600; text-decoration: none; }
.scan-btn-primary { background: var(--scan-brand); color: #ffffff; box-shadow: var(--scan-card-shadow); }
.scan-btn-primary:hover { background: #155a87; }
.scan-btn-ghost { color: var(--scan-brand); border: 2px solid var(--scan-brand); }
.scan-btn-inverse { background: #ffffff; color: var(--scan-brand); }
.scan-hero-art { margin: 0; }
.scan-hero-art svg { width: 100%; height: auto; display: block; }
.scan-reassure { margin-top: 28px; }
.scan-reassure-list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; list-style: none; margin: 0 auto; padding: 0; max-width: 1080px; }
.scan-reassure-list li { background: #ffffff; border: 1px solid #dcebf4; border-radius: var(--scan-radius); padding: 18px 20px; display: flex; flex-direction: column; gap: 4px; }
.scan-reassure-list strong { color: var(--scan-brand); font-size: 1.05rem; }
.scan-reassure-list span { color: var(--scan-ink-soft); font-size: 0.92rem; line-height: 1.45; }
.scan-journey { max-width: 1080px; margin: 56px auto 0; }
.scan-journey h2, .scan-types h2, .scan-faq h2 { color: var(--scan-ink); font-size: clamp(1.5rem, 2.6vw, 2rem); margin: 0 0 20px; }
.scan-journey-steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; list-style: none; margin: 0; padding: 0; counter-reset: step; }
.scan-journey-steps li { background: var(--scan-wash); border-radius: var(--scan-radius); padding: 24px 20px; position: relative; }
.scan-step-num { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; background: var(--scan-accent); color: #ffffff; font-weight: 700; margin-bottom: 12px; }
.scan-journey-steps h3 { margin: 0 0 8px; color: var(--scan-ink); font-size: 1.05rem; }
.scan-journey-steps p { margin: 0; color: var(--scan-ink-soft); font-size: 0.95rem; line-height: 1.55; }
.scan-safety { display: flex; gap: 20px; align-items: flex-start; background: var(--scan-warn-bg); border: 1px solid #f0dfa8; border-radius: var(--scan-radius); padding: 28px 32px; max-width: 1080px; margin: 48px auto 0; }
.scan-safety-icon svg { width: 56px; height: 56px; }
.scan-safety h2 { margin: 0 0 10px; color: #6e5600; font-size: 1.25rem; }
.scan-safety p { margin: 0 0 10px; color: #5d4d10; line-height: 1.55; }
.scan-types { max-width: 1080px; margin: 56px auto 0; }
.scan-types-intro { color: var(--scan-ink-soft); margin: 0 0 24px; }
.scan-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.scan-card { background: #ffffff; border-radius: var(--scan-radius); border: 1px solid #dcebf4; box-shadow: var(--scan-card-shadow); padding: 24px; }
.scan-card h3 { margin: 0 0 8px; color: var(--scan-brand); font-size: 1.1rem; }
.scan-card p { margin: 0; color: var(--scan-ink-soft); font-size: 0.95rem; line-height: 1.55; }
.scan-faq { max-width: 820px; margin: 56px auto 0; }
.scan-faq details { border: 1px solid #dcebf4; border-radius: 12px; padding: 0 20px; margin-bottom: 12px; background: #ffffff; }
.scan-faq summary { cursor: pointer; font-weight: 600; color: var(--scan-ink); padding: 16px 0; list-style-position: outside; }
.scan-faq details[open] summary { border-bottom: 1px solid #e8f1f7; }
.scan-faq details p { color: var(--scan-ink-soft); line-height: 1.6; padding: 14px 0 18px; margin: 0; }
.scan-cta { background: linear-gradient(120deg, var(--scan-brand), var(--scan-accent)); color: #ffffff; border-radius: var(--scan-radius); text-align: center; padding: 48px 32px; max-width: 1080px; margin: 56px auto 0; }
.scan-cta h2 { color: #ffffff; margin: 0 0 12px; font-size: clamp(1.5rem, 2.6vw, 2rem); }
.scan-cta p { margin: 0 auto 24px; max-width: 560px; line-height: 1.6; opacity: 0.95; }
@media (max-width: 1024px) {
  .scan-hero-inner { grid-template-columns: 1fr; gap: 28px; }
  .scan-reassure-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .scan-journey-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .scan-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .scan-hero { padding: 32px 20px; }
  .scan-reassure-list { grid-template-columns: 1fr; }
  .scan-journey-steps { grid-template-columns: 1fr; }
  .scan-cards { grid-template-columns: 1fr; }
  .scan-safety { flex-direction: column; padding: 22px 20px; }
  .scan-hero-actions { flex-direction: column; align-items: stretch; text-align: center; }
}
`;

export const BNMS_SCAN_FIXTURE = {
  schemaVersion: '2.0',
  compositionType: 'page_body',
  title: "I'm having a scan",
  html: HTML,
  css: CSS,
  assets: [],
  actions: [
    { key: 'find-scan', type: 'anchor', anchorId: 'scan-faq', status: 'unresolved' },
    { key: 'patient-leaflets', type: 'internal_page', pageId: null, status: 'unresolved' },
  ],
  slots: [],
  contentManifest: [
    { key: 'hero_lead', purpose: 'Reassuring page introduction' },
    { key: 'dose_statement', purpose: 'Radiation dose reassurance — clinically reviewed wording' },
    { key: 'safety_pregnancy', purpose: 'Pregnancy / breastfeeding safety notice' },
  ],
  protectedValues: [
    { key: 'safety_pregnancy', value: 'Tell the department before your appointment if you are pregnant, think you might be pregnant, or are breastfeeding.', reason: 'medical' },
    { key: 'dose_statement', value: 'The tracer dose is comparable to other routine imaging.', reason: 'medical' },
  ],
  responsiveTargets: { desktop: 1440, tablet: 1024, mobile: 390 },
  promptRequirements: [
    'Two-column hero with bespoke SVG scanner illustration',
    'Reassurance strip', 'Four-stage journey', 'Safety panel',
    'Six scan cards', 'Accessible FAQ', 'Closing CTA', 'Distinct mobile composition',
  ],
  generationSummary: 'Hand-authored Phase 0 proof fixture modelled on the BNMS benchmark package.',
};
