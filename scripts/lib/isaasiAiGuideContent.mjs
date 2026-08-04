// Task #3371 — content for the isaasi "AI for Membership Organisations" guide
// page, a pixel-faithful responsive web recreation of the guide infographic
// (attached_assets/AI_for_membership_organisations_(1)_1785864416704.png).
//
// Consumed by scripts/seed-isaasi-ai-guide-page.mjs, which runs the HTML/CSS
// through api/_lib/staticPageContent.js (sanitize + scope) before persisting.
//
// Authoring rules (must survive the store-time sanitiser):
//   - no <script>/<style>/<button>/<form>/iframes, no inline style attributes
//   - links limited to #anchors, /relative, https:, mailto:, tel:
//   - icons are inline SVG (allowed, restricted profile)
//   - all presentation lives in GUIDE_CSS, scoped at store time under
//     [data-static-page="<page id>"]

const PINK = '#EC008C';

// Small inline SVG icon helpers (stroke icons drawn in the guide's style).
const icon = {
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>`,
  brain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4a3 3 0 0 0-3 3v9a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z"></path><path d="M9 8H7.5A2.5 2.5 0 0 0 5 10.5v0A2.5 2.5 0 0 0 7.5 13H9"></path><path d="M15 8h1.5A2.5 2.5 0 0 1 19 10.5v0a2.5 2.5 0 0 1-2.5 2.5H15"></path><path d="M9 16H8a2 2 0 0 1-2-2"></path><path d="M15 16h1a2 2 0 0 0 2-2"></path></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path></svg>`,
  doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"></path><path d="M14 3v5h5"></path><path d="M9 13h6"></path><path d="M9 17h6"></path></svg>`,
  people: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"></circle><path d="M3 20a6 6 0 0 1 12 0"></path><circle cx="17" cy="9" r="2.5"></circle><path d="M15.5 14.5A5 5 0 0 1 21 19.5"></path></svg>`,
  chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16"></path><rect x="6" y="12" width="3" height="8"></rect><rect x="11" y="8" width="3" height="12"></rect><rect x="16" y="4" width="3" height="16"></rect></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 3 8.4 7 10 4-1.6 7-5.5 7-10V6l-7-3Z"></path><path d="m9 12 2 2 4-4"></path></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12h.01M12 12h.01M16 12h.01"></path><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"></path></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12 5 5L20 7"></path></svg>`,
  arrowRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h16"></path><path d="m14 6 6 6-6 6"></path></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v10"></path><path d="m7 10 5 5 5-5"></path><path d="M5 20h14"></path></svg>`,
};

const startCards = [
  {
    n: '1.',
    icon: icon.mail,
    title: 'Communicate better',
    text: 'Draft emails, newsletters and updates faster and tailor messages to your audience.',
  },
  {
    n: '2.',
    icon: icon.doc,
    title: 'Work smarter',
    text: 'Summarise documents, extract key points and turn information into action.',
  },
  {
    n: '3.',
    icon: icon.people,
    title: 'Support members',
    text: 'Improve FAQs, create knowledge resources and personalise the experience.',
  },
  {
    n: '4.',
    icon: icon.chart,
    title: 'Make better decisions',
    text: 'Analyse data, spot trends and generate insights to guide your strategy.',
  },
];

const responsiblyItems = [
  'Protect data and respect privacy',
  'Be transparent with your team and members',
  'Check outputs and use human judgement',
  'Focus on value, not just automation',
];

/**
 * Build the guide page HTML.
 * @param {object} opts
 * @param {string} opts.downloadUrl  https URL of the downloadable guide asset
 * @param {string} opts.contactHref  "Let's talk" destination (page URL or mailto:)
 */
export function buildGuideHtml({ downloadUrl, contactHref }) {
  return `
<div class="g-page">

  <header class="g-topbar">
    <div class="g-wordmark">
      <div class="g-wordmark-text" aria-label="isaasi">is<span class="g-wordmark-accent">aa</span>si</div>
      <div class="g-wordmark-tagline">intelligent solutions for sustainable impact</div>
    </div>
    <div class="g-topbar-crumb"><span class="g-crumb-guide">GUIDE</span><span class="g-crumb-sep">|</span><span class="g-crumb-title">AI FOR MEMBERSHIP ORGANISATIONS</span></div>
  </header>

  <section class="g-hero">
    <div class="g-hero-main">
      <p class="g-kicker">GUIDE</p>
      <h1 class="g-title">AI for Membership Organisations</h1>
      <div class="g-rule" aria-hidden="true"></div>
      <p class="g-strap">Practical AI. Real impact. Time back for your people.</p>
      <p class="g-intro">A short guide to help membership organisations use AI&nbsp;in ways that are practical, responsible and valuable.</p>
      <p class="g-readtime"><span class="g-readtime-icon">${icon.clock}</span> 2 MINUTE READ</p>
    </div>
    <div class="g-hero-mark" aria-hidden="true">
      <div class="g-mark-dot"></div>
      <div class="g-mark-stem"></div>
    </div>
  </section>

  <section class="g-split">
    <div class="g-card g-card-grey g-start-card">
      <div class="g-icon-badge g-icon-badge-outline">${icon.brain}</div>
      <div class="g-start-copy">
        <h2 class="g-h2">AI isn&rsquo;t the starting point.</h2>
        <p>It&rsquo;s a capability that can help you solve the right problems, faster.</p>
        <p>Start with your people, your challenges and the outcomes you want to achieve.</p>
        <p class="g-pink g-semibold">Technology should give you time back.<br>Not create more work.</p>
      </div>
    </div>
    <figure class="g-quote">
      <div class="g-quote-mark g-quote-open" aria-hidden="true">&ldquo;</div>
      <blockquote>
        <p class="g-quote-black">AI shouldn&rsquo;t replace people.</p>
        <p class="g-quote-pink">It should give them their&nbsp;time back.</p>
      </blockquote>
      <div class="g-quote-mark g-quote-close" aria-hidden="true">&rdquo;</div>
    </figure>
  </section>

  <section class="g-start">
    <h2 class="g-h2 g-start-heading">Where to start: 4 practical ways AI can help</h2>
    <div class="g-start-grid">
      ${startCards.map((c) => `
      <div class="g-start-item">
        <div class="g-icon-badge g-icon-badge-tint">${c.icon}</div>
        <h3 class="g-h3"><span class="g-pink g-num">${c.n}</span> ${c.title}</h3>
        <p>${c.text}</p>
      </div>`).join('')}
    </div>
  </section>

  <section class="g-split">
    <div class="g-card g-card-pink g-resp-card">
      <div class="g-icon-badge g-icon-badge-outline">${icon.shield}</div>
      <div class="g-resp-copy">
        <h2 class="g-h2">Use AI responsibly</h2>
        <ul class="g-checklist">
          ${responsiblyItems.map((t) => `<li><span class="g-check">${icon.check}</span>${t}</li>`).join('')}
        </ul>
      </div>
    </div>
    <figure class="g-quote">
      <div class="g-quote-mark g-quote-open" aria-hidden="true">&ldquo;</div>
      <blockquote>
        <p class="g-quote-black">The best results come from curiosity, not complexity.</p>
        <p class="g-quote-pink">Start small. Learn fast.<br>Improve continuously.</p>
      </blockquote>
      <div class="g-quote-mark g-quote-close" aria-hidden="true">&rdquo;</div>
    </figure>
  </section>

  <section class="g-card g-card-grey g-cta">
    <div class="g-icon-badge g-icon-badge-outline">${icon.chat}</div>
    <div class="g-cta-copy">
      <h2 class="g-h2">Continue the conversation</h2>
      <p>Every organisation is different.<br>If this guide has raised questions about AI in your organisation, we&rsquo;d love to continue the conversation.</p>
    </div>
    <a class="g-btn" href="${contactHref}">Let&rsquo;s talk <span class="g-btn-arrow">${icon.arrowRight}</span></a>
  </section>

  <footer class="g-footbar">
    <a class="g-download" href="${downloadUrl}" target="_blank" rel="noopener noreferrer"><span class="g-download-icon">${icon.download}</span> DOWNLOAD THIS GUIDE</a>
    <p class="g-next"><strong>NEXT GUIDE:</strong>&nbsp; DIGITAL MATURITY FOR MEMBERSHIP ORGANISATIONS <span class="g-next-arrow">${icon.arrowRight}</span></p>
  </footer>

</div>`.trim();
}

// Page CSS. Authored unscoped; the seed script scopes every selector under
// [data-static-page="<page id>"] at store time.
export const GUIDE_CSS = `
.g-page {
  --g-pink: ${PINK};
  --g-pink-tint: #FDE7F3;
  --g-ink: #171717;
  --g-grey: #F4F4F5;
  --g-border: #E4E4E7;
  max-width: 1060px;
  margin: 0 auto;
  padding: 32px 24px 48px;
  color: var(--g-ink);
  font-family: 'Poppins', 'Helvetica Neue', Arial, system-ui, sans-serif;
  line-height: 1.55;
  font-size: 16px;
}
.g-page p { margin: 0 0 0.75em; }
.g-page svg { width: 100%; height: 100%; display: block; }

/* ---- top bar ---- */
.g-topbar {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; padding-bottom: 20px; border-bottom: 1px solid var(--g-border);
}
.g-wordmark-text { font-size: 40px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
.g-wordmark-accent { color: var(--g-pink); }
.g-wordmark-tagline { font-size: 11px; letter-spacing: 0.02em; color: #52525B; margin-top: 4px; }
.g-topbar-crumb { font-size: 12px; letter-spacing: 0.08em; font-weight: 600; margin-top: 10px; white-space: nowrap; }
.g-crumb-guide { color: var(--g-pink); }
.g-crumb-sep { margin: 0 10px; color: #A1A1AA; }
.g-crumb-title { color: var(--g-ink); }

/* ---- hero ---- */
.g-hero { display: flex; gap: 40px; padding: 48px 0 40px; align-items: stretch; }
.g-hero-main { flex: 1 1 auto; min-width: 0; }
.g-kicker { color: var(--g-pink); font-weight: 700; letter-spacing: 0.12em; font-size: 14px; margin-bottom: 12px; }
.g-title { font-size: clamp(38px, 6vw, 60px); line-height: 1.08; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 20px; max-width: 14em; }
.g-rule { width: 56px; height: 4px; background: var(--g-pink); margin-bottom: 24px; }
.g-strap { font-size: 20px; font-weight: 700; margin-bottom: 14px; }
.g-intro { max-width: 32em; color: #3F3F46; }
.g-readtime { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; margin-top: 26px; }
.g-readtime-icon { width: 22px; height: 22px; color: var(--g-pink); flex: none; }
.g-hero-mark { flex: 0 0 150px; display: flex; flex-direction: column; align-items: center; gap: 22px; padding-top: 8px; }
.g-mark-dot { width: 96px; height: 96px; border-radius: 50%; background: var(--g-pink); }
.g-mark-stem { width: 96px; flex: 1 1 auto; min-height: 180px; background: var(--g-pink); border-radius: 14px 14px 48px 48px; }

/* ---- shared cards / icon badges ---- */
.g-card { border-radius: 14px; padding: 30px 32px; }
.g-card-grey { background: var(--g-grey); }
.g-card-pink { background: var(--g-pink-tint); }
.g-icon-badge { width: 64px; height: 64px; border-radius: 50%; padding: 15px; flex: none; color: var(--g-pink); }
.g-icon-badge-outline { background: #fff; border: 2px solid var(--g-pink); }
.g-icon-badge-tint { background: var(--g-pink-tint); margin: 0 auto 14px; }
.g-h2 { font-size: 21px; font-weight: 700; margin: 0 0 12px; letter-spacing: -0.01em; }
.g-h3 { font-size: 16px; font-weight: 700; margin: 0 0 8px; }
.g-pink { color: var(--g-pink); }
.g-semibold { font-weight: 600; }

/* ---- split rows (card + pull quote) ---- */
.g-split { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 36px; padding: 26px 0; border-top: 1px solid var(--g-border); align-items: center; }
.g-start-card, .g-resp-card { display: flex; gap: 24px; align-items: flex-start; }
.g-start-copy p, .g-resp-copy p { font-size: 15px; }
.g-quote { margin: 0; padding: 8px 12px 8px 36px; border-left: 1px solid var(--g-border); position: relative; }
.g-quote blockquote { margin: 0; padding: 0 24px; }
.g-quote-mark { color: var(--g-pink); font-size: 64px; line-height: 0.6; font-weight: 800; font-family: Georgia, serif; }
.g-quote-open { margin-bottom: 6px; }
.g-quote-close { text-align: right; margin-top: 10px; }
.g-quote-black { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
.g-quote-pink { font-size: 22px; font-weight: 700; color: var(--g-pink); margin: 0; }

/* ---- where to start grid ---- */
.g-start { padding: 30px 0 34px; border-top: 1px solid var(--g-border); }
.g-start-heading { font-size: 19px; margin-bottom: 26px; }
.g-start-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 30px; }
.g-start-item { text-align: left; }
.g-start-item .g-icon-badge { margin-left: 0; }
.g-start-item p { font-size: 14px; color: #3F3F46; margin: 0; }
.g-num { margin-right: 2px; }

/* ---- responsibly checklist ---- */
.g-checklist { list-style: none; margin: 0; padding: 0; }
.g-checklist li { display: flex; align-items: flex-start; gap: 10px; font-size: 15px; margin-bottom: 8px; }
.g-check { width: 18px; height: 18px; color: var(--g-pink); flex: none; margin-top: 3px; }

/* ---- CTA band ---- */
.g-cta { display: flex; align-items: center; gap: 26px; margin-top: 26px; }
.g-cta-copy { flex: 1 1 auto; min-width: 0; }
.g-cta-copy p { margin: 0; font-size: 15px; color: #3F3F46; }
.g-btn {
  display: inline-flex; align-items: center; gap: 12px; flex: none;
  background: var(--g-pink); color: #fff; text-decoration: none;
  font-weight: 700; font-size: 16px; padding: 16px 28px; border-radius: 10px;
}
.g-btn:hover { background: #C4007A; color: #fff; }
.g-btn-arrow { width: 22px; height: 22px; flex: none; }

/* ---- footer strip ---- */
.g-footbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 34px; padding-top: 22px; border-top: 1px solid var(--g-border); flex-wrap: wrap; }
.g-download { display: inline-flex; align-items: center; gap: 8px; color: var(--g-pink); font-weight: 700; font-size: 13px; letter-spacing: 0.08em; text-decoration: none; }
.g-download:hover { text-decoration: underline; }
.g-download-icon { width: 18px; height: 18px; flex: none; }
.g-next { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; letter-spacing: 0.06em; margin: 0; color: var(--g-ink); }
.g-next strong { font-weight: 700; }
.g-next-arrow { width: 18px; height: 18px; color: var(--g-pink); flex: none; }

/* ---- responsive ---- */
@media (max-width: 900px) {
  .g-start-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .g-split { grid-template-columns: 1fr; }
  .g-quote { border-left: none; border-top: 1px solid var(--g-border); padding: 20px 4px 4px; }
  .g-hero-mark { flex-basis: 110px; }
  .g-mark-dot { width: 70px; height: 70px; }
  .g-mark-stem { width: 70px; min-height: 130px; }
}
@media (max-width: 620px) {
  .g-page { padding: 22px 16px 36px; }
  .g-topbar { flex-direction: column; gap: 8px; }
  .g-topbar-crumb { white-space: normal; margin-top: 0; }
  .g-hero { flex-direction: column; padding: 30px 0 26px; gap: 22px; }
  .g-hero-mark { flex-direction: row; justify-content: flex-start; padding-top: 0; }
  .g-mark-stem { min-height: 0; height: 70px; flex: 0 0 150px; border-radius: 14px 48px 48px 14px; }
  .g-start-grid { grid-template-columns: 1fr; }
  .g-start-card, .g-resp-card, .g-cta { flex-direction: column; align-items: flex-start; }
  .g-quote-black, .g-quote-pink { font-size: 19px; }
  .g-footbar { flex-direction: column; align-items: flex-start; }
}
`.trim();
