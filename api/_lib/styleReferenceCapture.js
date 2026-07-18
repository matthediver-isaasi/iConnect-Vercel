/**
 * Style-reference capture bundle + DOM/computed-CSS extractor (Task #2879).
 *
 * Drives browserless.io's `/function` endpoint (same transport as
 * browserlessAxe.js) to capture ONE viewport of a reference page:
 *   - full load/settle sequence (network idle, document.fonts.ready, image
 *     waits, stepped lazy-load scroll, return to top, animation freeze,
 *     configurable post-load delay),
 *   - labelled screenshots: full-page overview + region crops (hero,
 *     detected card cluster(s), mid/lower sections),
 *   - a normalised structured-evidence JSON object: page metrics, grouped
 *     typography signatures, colour tokens with roles, derived spacing
 *     scale, surface recipes, layout boxes, image/SVG treatment and
 *     repeated component families with confidence scores.
 *
 * Security (spec §17): callers MUST have validated the URL
 * (validateReferenceUrl + assertPublicUrlTarget). This module additionally
 * re-validates the FINAL post-redirect URL (protocol + host shape) inside
 * the page session and reports it so the endpoint can re-run the DNS/private
 * -IP check. Page height, screenshot count and payload sizes are capped.
 */

import { getBrowserlessConfig, isBrowserlessConfigured } from './browserlessAxe.js';

export { isBrowserlessConfigured };

export const CAPTURE_VERSION = '2.0';

/** Spec §2 defaults — constants for now, configurable later. */
export const CAPTURE_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000, isMobile: false },
  { name: 'tablet', width: 1024, height: 900, isMobile: false },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
];

export const MAX_PAGE_HEIGHT_PX = 12000;       // spec §17 max page height
export const MAX_CROPS_PER_VIEWPORT = 4;       // + 1 full page = 5 shots max
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024; // per image cap
export const POST_LOAD_DELAY_MS_DEFAULT = 1200;
export const RETRY_POST_LOAD_DELAY_MS = 400;   // 2nd attempt: shorter settle
export const FULL_PAGE_CAP_PX = 8000;          // full-page shot height cap
// Total base64 budget for ONE /function response. Keeps the JSON body well
// under browserless/serverless response limits — the runner stops taking
// crops once the budget is spent (the full-page shot always ships).
export const FUNCTION_PAYLOAD_BUDGET_B64 = 3_800_000;
export const MAX_WALK_ELEMENTS = 3500;         // evidence walk cap (was 6000)

// The in-page capture/extraction program. Runs on browserless (Puppeteer).
// Returns { data: { finalUrl, metrics, screenshots: [{label, b64, width,
// height}] } } or { data: { error, message } }.
const CAPTURE_RUNNER_CODE = `
export default async function ({ page, context }) {
  const {
    url, viewport, navigationTimeout, postLoadDelay,
    maxPageHeight, maxCrops, payloadBudget, maxWalkElements, fullPageCap,
  } = context;

  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: !!viewport.isMobile,
    hasTouch: !!viewport.isMobile,
    deviceScaleFactor: 1,
  });
  page.setDefaultNavigationTimeout(navigationTimeout);
  page.setDefaultTimeout(navigationTimeout);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: navigationTimeout });
  } catch (err) {
    return { data: { error: 'navigation_failed', message: String(err && err.message || err) }, type: 'application/json' };
  }

  const finalUrl = page.url();
  // Final-URL protocol guard (redirect revalidation part 1; the server
  // re-runs DNS/private-IP checks on the reported host).
  if (!/^https?:\\/\\//i.test(finalUrl)) {
    return { data: { error: 'redirected_to_unsupported_scheme', message: finalUrl.slice(0, 200) }, type: 'application/json' };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Fonts + late JS settle.
  try { await page.evaluate(() => (document.fonts && document.fonts.ready) || true); } catch {}
  await sleep(Math.max(0, postLoadDelay || 0));

  // Stepped scroll to trigger lazy-loading, then back to top.
  try {
    await page.evaluate(async (maxH) => {
      const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
      const limit = Math.min(document.body.scrollHeight, maxH);
      for (let y = 0; y < limit; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 80));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 200));
    }, maxPageHeight);
  } catch {}

  // Wait for images currently in the document (bounded).
  try {
    await page.evaluate(async () => {
      const imgs = Array.from(document.images || []).slice(0, 80);
      await Promise.race([
        Promise.all(imgs.map((im) => im.complete ? null : new Promise((r) => { im.onload = r; im.onerror = r; }))),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    });
  } catch {}

  // Freeze animations/transitions/carousels/video for capture stability.
  try {
    await page.addStyleTag({ content: '*,*::before,*::after{animation-play-state:paused!important;animation-duration:0.001s!important;transition-duration:0.001s!important;caret-color:transparent!important;scroll-behavior:auto!important}' });
    await page.evaluate(() => {
      for (const v of document.querySelectorAll('video')) { try { v.pause(); v.removeAttribute('autoplay'); } catch {} }
    });
  } catch {}
  await sleep(200);

  // ---------------- Structured evidence extraction ----------------
  let metrics = null;
  try {
    metrics = await page.evaluate((MAX_H, MAX_ELS) => {
      const round = (n) => Math.round(n * 10) / 10;
      const clean = (s, m) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, m || 120);

      function toHex(color) {
        const m = String(color || '').match(/rgba?\\(([^)]+)\\)/);
        if (!m) return /^#/.test(color) ? color : null;
        const parts = m[1].split(',').map((x) => parseFloat(x));
        if (parts.length >= 4 && parts[3] === 0) return null; // transparent
        const hex = '#' + parts.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
        if (parts.length >= 4 && parts[3] < 1) return hex + Math.round(parts[3] * 255).toString(16).padStart(2, '0');
        return hex;
      }
      function isVisible(el, rect, cs) {
        if (!rect || rect.width < 2 || rect.height < 2) return false;
        if (rect.bottom < 0 || rect.top > MAX_H) return false;
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
        return true;
      }
      function selectorFor(el) {
        const parts = [];
        let cur = el;
        for (let i = 0; cur && cur !== document.body && i < 4; i += 1) {
          let p = cur.tagName.toLowerCase();
          if (cur.id) { parts.unshift(p + '#' + cur.id); break; }
          const cls = Array.from(cur.classList || []).slice(0, 2).join('.');
          if (cls) p += '.' + cls;
          parts.unshift(p);
          cur = cur.parentElement;
        }
        return parts.join(' > ').slice(0, 160);
      }

      const doc = document.documentElement;
      const pageHeight = Math.min(Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0), MAX_H);

      // ---- Page-level ----
      const bodyCs = getComputedStyle(document.body);
      const rootVars = {};
      try {
        const rootCs = getComputedStyle(doc);
        for (const sheet of Array.from(document.styleSheets).slice(0, 30)) {
          let rules; try { rules = sheet.cssRules; } catch { continue; }
          for (const rule of Array.from(rules || []).slice(0, 400)) {
            if (rule.selectorText === ':root' && rule.style) {
              for (const name of Array.from(rule.style).slice(0, 120)) {
                if (name.startsWith('--') && Object.keys(rootVars).length < 60) {
                  rootVars[name] = clean(rootCs.getPropertyValue(name), 60);
                }
              }
            }
          }
        }
      } catch {}

      // Landmarks + main content width.
      const landmarks = {};
      for (const [key, sel] of [['header', 'header, [role="banner"]'], ['footer', 'footer, [role="contentinfo"]'], ['nav', 'nav, [role="navigation"]'], ['main', 'main, [role="main"]']]) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          landmarks[key] = { x: round(r.x + scrollX), y: round(r.y + scrollY), w: round(r.width), h: round(r.height) };
        }
      }
      let contentWidth = null;
      const main = document.querySelector('main, [role="main"]') || document.body;
      const widthCounts = new Map();
      for (const el of Array.from(main.querySelectorAll(':scope > *, :scope > * > *')).slice(0, 120)) {
        const r = el.getBoundingClientRect();
        if (r.width > 300 && r.width < viewportWidthSafe()) {
          const w = Math.round(r.width / 10) * 10;
          widthCounts.set(w, (widthCounts.get(w) || 0) + 1);
        }
      }
      function viewportWidthSafe() { return window.innerWidth - 8; }
      let best = 0;
      for (const [w, c] of widthCounts) if (c > best) { best = c; contentWidth = w; }

      // ---- Walk visible elements once ----
      const all = Array.from(document.querySelectorAll('body *')).slice(0, MAX_ELS || 3500);
      const typoMap = new Map();
      const colorMap = new Map();
      const spacingCounts = new Map();
      const surfaceMap = new Map();
      const sections = [];
      const images = [];
      const svgs = [];
      const candidates = []; // component-family candidates

      const bumpColor = (hex, role, el) => {
        if (!hex) return;
        const key = hex + '|' + role;
        const cur = colorMap.get(key) || { color: hex, role, count: 0, examples: [] };
        cur.count += 1;
        if (cur.examples.length < 2) cur.examples.push(selectorFor(el));
        colorMap.set(key, cur);
      };
      const bumpSpacing = (px) => {
        const v = Math.round(px);
        if (v >= 2 && v <= 200) spacingCounts.set(v, (spacingCounts.get(v) || 0) + 1);
      };

      for (const el of all) {
        let rect; let cs;
        try { rect = el.getBoundingClientRect(); cs = getComputedStyle(el); } catch { continue; }
        rect = { x: rect.x + scrollX, y: rect.y + scrollY, top: rect.y + scrollY, bottom: rect.y + scrollY + rect.height, width: rect.width, height: rect.height };
        if (!isVisible(el, { ...rect, top: rect.top - scrollY, bottom: rect.bottom - scrollY, width: rect.width, height: rect.height }, cs)) {
          if (rect.top > MAX_H) continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (rect.width < 2 || rect.height < 2) continue;
        }
        const tag = el.tagName.toLowerCase();

        // Typography: elements with direct text.
        const direct = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
        if (direct) {
          const size = parseFloat(cs.fontSize) || 0;
          if (size >= 9) {
            const sig = [cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), Math.round(size), cs.fontWeight, cs.lineHeight, cs.letterSpacing, cs.textTransform, toHex(cs.color)].join('|');
            const cur = typoMap.get(sig) || {
              fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
              fontSizePx: Math.round(size),
              fontWeight: cs.fontWeight,
              lineHeight: cs.lineHeight,
              letterSpacing: cs.letterSpacing === 'normal' ? null : cs.letterSpacing,
              textTransform: cs.textTransform === 'none' ? null : cs.textTransform,
              color: toHex(cs.color),
              textAlign: cs.textAlign,
              count: 0, tags: {}, selector: selectorFor(el), sampleText: clean(el.textContent, 60),
            };
            cur.count += 1;
            cur.tags[tag] = (cur.tags[tag] || 0) + 1;
            typoMap.set(sig, cur);
            bumpColor(toHex(cs.color), 'text', el);
          }
        }

        // Colours: backgrounds + borders + buttons/badges.
        const bg = toHex(cs.backgroundColor);
        if (bg) {
          let role = 'background';
          if (tag === 'button' || (tag === 'a' && cs.display.includes('inline-block')) || /btn|button/i.test(el.className)) role = 'button';
          else if (rect.width > window.innerWidth * 0.9 && rect.height > 120) role = 'section_background';
          else if (rect.width < 500 && rect.height < 500 && parseFloat(cs.borderRadius) > 0) role = 'card_background';
          bumpColor(bg, role, el);
        }
        if (cs.borderTopWidth !== '0px' && toHex(cs.borderTopColor)) bumpColor(toHex(cs.borderTopColor), 'border', el);

        // Spacing evidence.
        for (const p of [cs.paddingTop, cs.paddingBottom, cs.paddingLeft, cs.marginBottom]) {
          const v = parseFloat(p); if (v > 0) bumpSpacing(v);
        }
        if (cs.gap && cs.gap !== 'normal') { const v = parseFloat(cs.gap); if (v > 0) bumpSpacing(v); }

        // Surfaces: elements with radius/shadow/border + real size.
        const radius = parseFloat(cs.borderRadius) || 0;
        const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
        const hasBorder = cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none';
        if ((radius > 0 || hasShadow || hasBorder) && rect.width > 80 && rect.height > 40 && rect.width < window.innerWidth * 0.98) {
          const skey = [bg, Math.round(radius), hasShadow ? cs.boxShadow.slice(0, 60) : 'none', hasBorder ? cs.borderTopWidth + ' ' + toHex(cs.borderTopColor) : 'none', Math.round(parseFloat(cs.paddingTop) || 0)].join('|');
          const cur = surfaceMap.get(skey) || {
            background: bg, radiusPx: Math.round(radius),
            shadow: hasShadow ? clean(cs.boxShadow, 80) : null,
            border: hasBorder ? (cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + toHex(cs.borderTopColor)) : null,
            paddingPx: { top: Math.round(parseFloat(cs.paddingTop) || 0), right: Math.round(parseFloat(cs.paddingRight) || 0), bottom: Math.round(parseFloat(cs.paddingBottom) || 0), left: Math.round(parseFloat(cs.paddingLeft) || 0) },
            count: 0, selector: selectorFor(el),
            avgW: 0, avgH: 0,
          };
          cur.avgW = Math.round((cur.avgW * cur.count + rect.width) / (cur.count + 1));
          cur.avgH = Math.round((cur.avgH * cur.count + rect.height) / (cur.count + 1));
          cur.count += 1;
          surfaceMap.set(skey, cur);
        }

        // Component-family candidates: parent with >=3 similar-size children.
        if ((cs.display === 'grid' || cs.display === 'flex') && el.children.length >= 3 && rect.width > 400) {
          const kids = Array.from(el.children).filter((k) => {
            const kr = k.getBoundingClientRect();
            return kr.width > 100 && kr.height > 60;
          });
          if (kids.length >= 3) {
            const kr0 = kids[0].getBoundingClientRect();
            const similar = kids.filter((k) => {
              const kr = k.getBoundingClientRect();
              return Math.abs(kr.width - kr0.width) < kr0.width * 0.25;
            });
            if (similar.length >= 3) {
              const kcs = getComputedStyle(kids[0]);
              candidates.push({
                selector: selectorFor(el),
                display: cs.display,
                gridTemplateColumns: cs.display === 'grid' ? clean(cs.gridTemplateColumns, 100) : null,
                gap: cs.gap && cs.gap !== 'normal' ? cs.gap : null,
                occurrences: similar.length,
                childSelector: selectorFor(kids[0]),
                childW: Math.round(kr0.width), childH: Math.round(kr0.height),
                childBackground: toHex(kcs.backgroundColor),
                childRadiusPx: Math.round(parseFloat(kcs.borderRadius) || 0),
                childShadow: kcs.boxShadow !== 'none' ? clean(kcs.boxShadow, 80) : null,
                childBorder: kcs.borderTopStyle !== 'none' ? (kcs.borderTopWidth + ' ' + kcs.borderTopStyle + ' ' + toHex(kcs.borderTopColor)) : null,
                childPaddingPx: Math.round(parseFloat(kcs.paddingTop) || 0),
                hasImage: !!kids[0].querySelector('img, svg, picture'),
                hasHeading: !!kids[0].querySelector('h1,h2,h3,h4,h5,h6'),
                hasLink: !!kids[0].querySelector('a,button'),
                bounds: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
                confidence: Math.min(0.95, 0.5 + similar.length * 0.08 + (parseFloat(kcs.borderRadius) > 0 ? 0.1 : 0)),
              });
            }
          }
        }

        // Sections: top-level-ish wide bands.
        if ((tag === 'section' || (tag === 'div' && el.parentElement === main)) && rect.width > window.innerWidth * 0.9 && rect.height > 160 && sections.length < 24) {
          sections.push({
            selector: selectorFor(el),
            bounds: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
            background: bg,
          });
        }

        // Images.
        if (tag === 'img' && rect.width > 60 && rect.height > 60 && images.length < 40) {
          images.push({
            w: Math.round(rect.width), h: Math.round(rect.height),
            naturalW: el.naturalWidth || null, naturalH: el.naturalHeight || null,
            objectFit: cs.objectFit, radiusPx: Math.round(parseFloat(cs.borderRadius) || 0),
            hasAlt: !!el.getAttribute('alt'),
            aspect: rect.height > 0 ? round(rect.width / rect.height) : null,
            clipPath: cs.clipPath !== 'none' ? clean(cs.clipPath, 60) : null,
          });
        }
        if (tag === 'svg' && rect.width > 10 && rect.height > 10 && svgs.length < 40) {
          const fills = new Set(); const strokes = new Set();
          for (const c of Array.from(el.querySelectorAll('[fill],[stroke]')).slice(0, 30)) {
            const f = c.getAttribute('fill'); const s = c.getAttribute('stroke');
            if (f && f !== 'none' && fills.size < 5) fills.add(f);
            if (s && s !== 'none' && strokes.size < 5) strokes.add(s);
          }
          const parentCs = el.parentElement ? getComputedStyle(el.parentElement) : null;
          svgs.push({
            w: Math.round(rect.width), h: Math.round(rect.height),
            viewBox: clean(el.getAttribute('viewBox'), 40) || null,
            fills: Array.from(fills), strokes: Array.from(strokes),
            strokeWidth: (() => { const c = el.querySelector('[stroke-width]'); return c ? clean(c.getAttribute('stroke-width'), 10) : null; })(),
            container: parentCs && parseFloat(parentCs.borderRadius) >= rect.width / 2 ? 'circle' : (parentCs && parseFloat(parentCs.borderRadius) > 0 ? 'rounded' : 'unframed'),
          });
        }
      }

      // Reduce maps.
      const typography = Array.from(typoMap.values())
        .filter((t) => t.count >= 1)
        .sort((a, b) => b.count - a.count)
        .slice(0, 24)
        .map((t) => ({ ...t, dominantTag: Object.entries(t.tags).sort((a, b) => b[1] - a[1])[0][0], tags: undefined }));

      const colours = Array.from(colorMap.values()).sort((a, b) => b.count - a.count).slice(0, 30);

      const spacingSorted = Array.from(spacingCounts.entries()).sort((a, b) => b[1] - a[1]);
      // Cluster near-identical values to a scale.
      const scale = [];
      for (const [v] of spacingSorted.slice(0, 40)) {
        if (!scale.some((s) => Math.abs(s - v) <= Math.max(2, s * 0.12))) scale.push(v);
        if (scale.length >= 12) break;
      }
      scale.sort((a, b) => a - b);

      const surfaces = Array.from(surfaceMap.values()).filter((s) => s.count >= 2).sort((a, b) => b.count - a.count).slice(0, 12);

      // De-dup component candidates by child signature; keep strongest.
      const famMap = new Map();
      for (const c of candidates) {
        const key = [c.childBackground, c.childRadiusPx, c.hasImage, c.hasHeading].join('|');
        const cur = famMap.get(key);
        if (!cur || c.occurrences > cur.occurrences) famMap.set(key, c);
      }
      const componentFamilies = Array.from(famMap.values()).sort((a, b) => b.occurrences - a.occurrences).slice(0, 8);

      return {
        page: {
          url: location.href,
          title: clean(document.title, 120),
          viewport: { width: window.innerWidth, height: window.innerHeight },
          pageHeight,
          truncated: pageHeight >= MAX_H,
          bodyBackground: toHex(bodyCs.backgroundColor),
          contentWidthPx: contentWidth,
          rootCustomProperties: rootVars,
          landmarks,
          sectionCount: sections.length,
        },
        typography,
        colours,
        spacing: { scalePx: scale, mostFrequent: spacingSorted.slice(0, 6).map(([v]) => v) },
        surfaces,
        sections,
        images,
        svgs,
        componentFamilies,
      };
    }, maxPageHeight, maxWalkElements);
  } catch (err) {
    metrics = { extractError: String(err && err.message || err).slice(0, 300) };
  }

  // ---------------- Screenshots ----------------
  // Budget-aware: the JSON response carries base64 images, so we track the
  // cumulative base64 size and stop taking crops once the budget is spent.
  // The full-page shot always ships (and is height-capped) so a capture can
  // never come back empty just because the page is image-heavy.
  const screenshots = [];
  const vpName = viewport.name;
  const budget = payloadBudget || 3800000;
  let usedB64 = 0;
  const shoot = async (label, clip, quality) => {
    try {
      const b64 = await page.screenshot({
        type: 'jpeg', quality: quality || 72, encoding: 'base64',
        ...(clip ? { clip } : { fullPage: true }),
      });
      if (screenshots.length > 0 && usedB64 + b64.length > budget) return false;
      usedB64 += b64.length;
      screenshots.push({ label, b64, width: clip ? Math.round(clip.width) : viewport.width, height: clip ? Math.round(clip.height) : null });
      return true;
    } catch { return false; }
  };

  // Page height measured directly so a failed metrics pass never forces an
  // uncapped fullPage screenshot of a very tall page.
  let measuredH = 0;
  try {
    measuredH = await page.evaluate(() => Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    ));
  } catch {}
  const pageH = Math.min(
    (metrics && metrics.page && metrics.page.pageHeight) || measuredH || viewport.height,
    maxPageHeight,
  );
  const vw = viewport.width;
  const fpCap = fullPageCap || 8000;

  // Full page (height-capped via clip when the page is tall).
  if (pageH > fpCap) {
    await shoot(vpName + '_full_page', { x: 0, y: 0, width: vw, height: fpCap }, 65);
  } else {
    await shoot(vpName + '_full_page', null, 65);
  }

  // Region crops (spec §3): hero, card cluster(s), mid, lower.
  const crops = [];
  crops.push({ label: vpName + '_hero', y: 0, h: Math.min(viewport.height, pageH) });
  const fams = (metrics && metrics.componentFamilies) || [];
  let cardIdx = 0;
  for (const fam of fams.slice(0, 2)) {
    if (fam.bounds && fam.bounds.h > 100) {
      cardIdx += 1;
      crops.push({
        label: vpName + '_card_cluster_' + cardIdx,
        y: Math.max(0, fam.bounds.y - 40),
        h: Math.min(fam.bounds.h + 80, 1600),
      });
    }
  }
  if (pageH > viewport.height * 2.2) {
    crops.push({ label: vpName + '_mid_section', y: Math.floor(pageH * 0.42), h: Math.min(viewport.height, 1100) });
  }
  if (pageH > viewport.height * 1.5) {
    crops.push({ label: vpName + '_lower_section', y: Math.max(0, pageH - Math.min(viewport.height, 1100)), h: Math.min(viewport.height, 1100) });
  }
  const seen = new Set();
  let taken = 0;
  for (const c of crops) {
    if (taken >= maxCrops) break;
    if (usedB64 >= budget) break;
    const key = Math.round(c.y / 200);
    if (seen.has(key)) continue;
    seen.add(key);
    const h = Math.min(c.h, pageH - c.y);
    if (h < 120) continue;
    const ok = await shoot(c.label, { x: 0, y: Math.round(c.y), width: vw, height: Math.round(h) });
    if (ok) taken += 1;
  }

  return {
    data: { finalUrl, metrics, screenshots, viewport: vpName },
    type: 'application/json',
  };
}
`;

/**
 * Capture ONE viewport of a reference URL via browserless /function.
 * Returns { finalUrl, metrics, screenshots: [{ label, buffer, width, height }] }.
 * Throws Error with a friendly message on failure.
 */
export async function captureViewportBundle(url, viewportName, { postLoadDelayMs = POST_LOAD_DELAY_MS_DEFAULT } = {}) {
  const viewport = CAPTURE_VIEWPORTS.find((v) => v.name === viewportName);
  if (!viewport) throw new Error(`Unknown capture viewport: ${viewportName}`);
  const { token, baseUrl, timeoutMs } = getBrowserlessConfig();
  if (!token) throw new Error('Screenshot capture is not configured on this server.');

  const endpoint = `${baseUrl.replace(/\/$/, '')}/function?token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 15000);
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        code: CAPTURE_RUNNER_CODE,
        context: {
          url,
          viewport,
          navigationTimeout: timeoutMs,
          postLoadDelay: postLoadDelayMs,
          maxPageHeight: MAX_PAGE_HEIGHT_PX,
          maxCrops: MAX_CROPS_PER_VIEWPORT,
          payloadBudget: FUNCTION_PAYLOAD_BUDGET_B64,
          maxWalkElements: MAX_WALK_ELEMENTS,
          fullPageCap: FULL_PAGE_CAP_PX,
        },
      }),
    });
  } catch (err) {
    throw makeCaptureError(
      err?.name === 'AbortError'
        ? 'The page took too long to render for capture.'
        : 'Could not reach the capture service.',
      err?.name === 'AbortError' ? `fetch aborted after ${timeoutMs + 15000}ms` : `fetch failed: ${String(err?.message || err).slice(0, 200)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error('[styleReferenceCapture] non-2xx:', resp.status, detail.slice(0, 300));
    throw makeCaptureError(
      resp.status === 400 || resp.status === 500
        ? 'The reference page could not be rendered — check the URL is public and loads normally.'
        : `Capture service error (${resp.status}).`,
      `capture service HTTP ${resp.status}: ${detail.slice(0, 200)}`,
    );
  }
  let data;
  try { data = await resp.json(); } catch {
    throw makeCaptureError('The capture service returned an unreadable response.', 'non-JSON /function response body');
  }
  if (data?.error) {
    console.error('[styleReferenceCapture] runner error:', data.error, String(data.message || '').slice(0, 300));
    throw makeCaptureError(
      data.error === 'navigation_failed'
        ? 'The reference page could not be loaded.'
        : data.error === 'redirected_to_unsupported_scheme'
          ? 'The reference page redirected somewhere that cannot be captured.'
          : 'The reference page could not be captured.',
      `runner ${data.error}: ${String(data.message || '').slice(0, 200)}`,
    );
  }
  const screenshots = [];
  for (const s of Array.isArray(data?.screenshots) ? data.screenshots : []) {
    if (!s?.b64 || !s?.label) continue;
    const buffer = Buffer.from(s.b64, 'base64');
    if (!buffer.length || buffer.length > MAX_SCREENSHOT_BYTES) continue;
    screenshots.push({ label: String(s.label).slice(0, 60), buffer, width: s.width || null, height: s.height || null });
  }
  if (screenshots.length === 0) {
    throw makeCaptureError(
      'No usable screenshots could be captured from the reference page.',
      `runner returned ${Array.isArray(data?.screenshots) ? data.screenshots.length : 0} screenshots, none usable`,
    );
  }
  return {
    finalUrl: String(data.finalUrl || url),
    metrics: data.metrics && typeof data.metrics === 'object' ? data.metrics : null,
    screenshots,
  };
}

// Minimal fallback runner: goto + one full-page (height-capped) screenshot.
// Deliberately no scroll pass, no metrics walk, no crops — the smallest
// possible browserless session. Returns the REAL post-redirect page.url()
// so the endpoint's redirect revalidation keeps working in fallback mode.
const FALLBACK_RUNNER_CODE = `
export default async function ({ page, context }) {
  const { url, viewport, navigationTimeout, fullPageCap } = context;
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    isMobile: !!viewport.isMobile,
    hasTouch: !!viewport.isMobile,
  });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: navigationTimeout });
  } catch (err) {
    return { data: { error: 'navigation_failed', message: String(err && err.message || err).slice(0, 500) }, type: 'application/json' };
  }
  const finalUrl = page.url();
  if (!/^https?:\\/\\//i.test(finalUrl)) {
    return { data: { error: 'redirected_to_unsupported_scheme', message: finalUrl.slice(0, 200) }, type: 'application/json' };
  }
  await new Promise((r) => setTimeout(r, 500));
  let pageH = viewport.height;
  try {
    pageH = await page.evaluate(() => Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    )) || viewport.height;
  } catch {}
  const clip = pageH > fullPageCap
    ? { x: 0, y: 0, width: viewport.width, height: fullPageCap }
    : null;
  let b64;
  try {
    b64 = await page.screenshot({
      type: 'jpeg', quality: 60, encoding: 'base64',
      ...(clip ? { clip } : { fullPage: true }),
    });
  } catch (err) {
    return { data: { error: 'screenshot_failed', message: String(err && err.message || err).slice(0, 500) }, type: 'application/json' };
  }
  return {
    data: {
      finalUrl,
      metrics: null,
      screenshots: [{ label: viewport.name + '_full_page', b64, width: viewport.width, height: null }],
    },
    type: 'application/json',
  };
}
`;

/**
 * Fallback capture: one full-page screenshot via a minimal /function runner.
 * Returns the same bundle shape as captureViewportBundle (metrics: null).
 */
async function captureFallbackScreenshot(url, viewportName) {
  const viewport = CAPTURE_VIEWPORTS.find((v) => v.name === viewportName);
  if (!viewport) throw new Error(`Unknown capture viewport: ${viewportName}`);
  const { token, baseUrl, timeoutMs } = getBrowserlessConfig();
  if (!token) throw new Error('Screenshot capture is not configured on this server.');

  const endpoint = `${baseUrl.replace(/\/$/, '')}/function?token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 15000);
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        code: FALLBACK_RUNNER_CODE,
        context: {
          url,
          viewport,
          navigationTimeout: timeoutMs,
          fullPageCap: FULL_PAGE_CAP_PX,
        },
      }),
    });
  } catch (err) {
    throw makeCaptureError(
      err?.name === 'AbortError'
        ? 'The page took too long to render for capture.'
        : 'Could not reach the capture service.',
      `fallback fetch: ${err?.name === 'AbortError' ? `aborted after ${timeoutMs + 15000}ms` : String(err?.message || err).slice(0, 200)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw makeCaptureError(`Capture service error (${resp.status}).`, `fallback HTTP ${resp.status}: ${detail.slice(0, 200)}`);
  }
  let data;
  try { data = await resp.json(); } catch {
    throw makeCaptureError('The capture service returned an unreadable response.', 'fallback: non-JSON /function response body');
  }
  if (data?.error) {
    throw makeCaptureError(
      data.error === 'navigation_failed'
        ? 'The reference page could not be loaded.'
        : data.error === 'redirected_to_unsupported_scheme'
          ? 'The reference page redirected somewhere that cannot be captured.'
          : 'The reference page could not be captured.',
      `fallback runner ${data.error}: ${String(data.message || '').slice(0, 200)}`,
    );
  }
  const shot = Array.isArray(data?.screenshots) ? data.screenshots[0] : null;
  const buffer = shot?.b64 ? Buffer.from(shot.b64, 'base64') : null;
  if (!buffer || !buffer.length || buffer.length > MAX_SCREENSHOT_BYTES) {
    throw makeCaptureError(
      'No usable screenshots could be captured from the reference page.',
      'fallback: empty or oversized screenshot',
    );
  }
  return {
    finalUrl: String(data.finalUrl || url),
    metrics: null,
    screenshots: [{ label: `${viewportName}_full_page`, buffer, width: viewport.width, height: null }],
  };
}

// Error with a user-friendly `message` plus a technical `detail` string the
// endpoint can log / persist for debugging (never invented, never a secret).
function makeCaptureError(message, detail) {
  const err = new Error(message);
  if (detail) err.detail = String(detail).slice(0, 300);
  return err;
}

/**
 * Reliability wrapper (Task #2882): try the full /function capture, retry
 * once with a shorter settle delay, then fall back to a plain full-page
 * /screenshot capture (no metrics, no crops) so a flaky rich capture never
 * hard-fails the whole flow. Returns:
 *   { bundle, usedFallback, attempts: [{ mode, attempt?, error, detail? }] }
 * Throws only when every route failed — the error carries a combined
 * `detail` describing each attempt.
 */
export async function captureViewportWithFallback(url, viewportName) {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const bundle = await captureViewportBundle(url, viewportName, {
        postLoadDelayMs: attempt === 1 ? POST_LOAD_DELAY_MS_DEFAULT : RETRY_POST_LOAD_DELAY_MS,
      });
      return { bundle, usedFallback: false, attempts };
    } catch (err) {
      attempts.push({ mode: 'function', attempt, error: err.message, detail: err.detail || null });
    }
  }
  // Fallback: minimal /function runner — goto + ONE full-page shot only.
  // Still /function (not /screenshot) so we get the REAL post-redirect
  // page.url() back and the endpoint's redirect revalidation keeps working.
  try {
    const bundle = await captureFallbackScreenshot(url, viewportName);
    return { bundle, usedFallback: true, attempts };
  } catch (err) {
    attempts.push({ mode: 'fallback', error: err.message, detail: err.detail || null });
    const first = attempts[0];
    const combined = new Error(first?.error || err.message);
    combined.detail = attempts
      .map((a) => `${a.mode}${a.attempt ? `#${a.attempt}` : ''}: ${a.error}${a.detail ? ` [${a.detail}]` : ''}`)
      .join(' | ')
      .slice(0, 600);
    combined.attempts = attempts;
    throw combined;
  }
}
