---
title: "Accessibility in the iConnect CanvasBuilder"
subtitle: "A Board Report on Design-Time Safeguards, Built-In Protections and Independent Verification"
date: "July 2026"
version: "1.0"
classification: "Commercial in Confidence"
---

# Accessibility in the iConnect CanvasBuilder

## A Board Report on Design-Time Safeguards, Built-In Protections and Independent Verification

*July 2026 — Version 1.0*

*Classification: Commercial in Confidence*

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Why Accessibility Matters to iConnect Clients](#2-why-accessibility-matters-to-iconnect-clients)
3. [Design-Time Safeguards for Page Authors](#3-design-time-safeguards-for-page-authors)
4. [Built-In Accessibility of Published Pages](#4-built-in-accessibility-of-published-pages)
5. [Independent Verification with Industry-Standard Tooling](#5-independent-verification-with-industry-standard-tooling)
6. [Foundational Platform Choices](#6-foundational-platform-choices)
7. [Known Limitations and Managed Risks](#7-known-limitations-and-managed-risks)
8. [Summary and Possible Next Steps](#8-summary-and-possible-next-steps)

---

## 1. Executive Summary

CanvasBuilder is iConnect's visual page-building tool. It allows non-technical administrators to design and publish public-facing web pages — landing pages, information pages, campaign pages — without writing any code. Because these pages are often the first thing a member of the public sees, their accessibility directly affects the reputation and legal exposure of every organisation using the platform.

iConnect takes a **layered approach** to accessibility in CanvasBuilder, oriented around the **Web Content Accessibility Guidelines (WCAG) 2.1 Level AA** — the internationally recognised standard referenced by UK and EU public-sector accessibility regulations and by most corporate accessibility policies. Rather than relying on a single check at the end of the process, accessibility is enforced at three distinct stages:

1. **While the page is being designed.** A live audit engine, built into the editor itself, re-checks the page on every change and surfaces issues to the author immediately — before the page ever reaches the public. Must-fix issues (such as images without alternative text, or a page without a main heading) are flagged prominently, and the author cannot publish without explicitly acknowledging them.

2. **In what the platform renders.** Every published CanvasBuilder page carries a set of accessibility protections that authors get automatically and cannot accidentally remove: semantic page structure, screen-reader support, keyboard navigation, visible focus indicators, a skip-to-content link, and respect for users who have asked their device to reduce motion.

3. **Through independent, industry-standard verification.** Live published pages can be scanned — both from inside the editor and from a dedicated administration area — with **axe-core**, the open-source accessibility engine developed by Deque Systems. axe-core is the same engine used inside Google Lighthouse and by the majority of enterprise accessibility programmes worldwide, so the results are directly comparable with what an external auditor or a regulator's tooling would find.

This report describes each layer in turn, names the specific standards, tools and mechanisms involved, and — in the interests of transparency — sets out the current limitations and how they are managed. iConnect does not claim formal WCAG certification or a completed third-party conformance audit; what it offers is a robust, verifiable, tooling-backed process that makes accessible outcomes the default and makes deviations visible.

---

## 2. Why Accessibility Matters to iConnect Clients

Organisations using iConnect — membership bodies, trade associations, professional institutes, charities — publish pages that serve the general public as well as their own members. Two audiences are therefore affected:

- **Public visitors** encounter CanvasBuilder pages as ordinary websites: event listings, campaign pages, information pages. Roughly one in five people has some form of disability; an inaccessible public page excludes them and, in many jurisdictions, creates legal risk under equality legislation.
- **Portal users** — the administrators and editors who build pages, and the members who log in to use the portal — interact with the platform's own interface every day. Their experience is governed by the accessibility of the platform's components themselves.

CanvasBuilder is designed so that both audiences are protected: authors are guided and checked as they work, and the pages they produce inherit accessible foundations regardless of the author's expertise.

---

## 3. Design-Time Safeguards for Page Authors

### A live audit on every change

The CanvasBuilder editor contains its own accessibility audit engine that runs **continuously as the author works**. Every time a block is added, moved, edited or restyled, the entire page design is re-audited and the results update in real time. There is no separate "check my page" step the author might forget — the audit is always on.

Findings are classified into three severities:

| Severity | Meaning |
|----------|---------|
| **Error** | A genuine accessibility failure that must be addressed — treated as a must-fix issue at publish time |
| **Warning** | A likely problem or risky pattern the author should review |
| **Info** | Advisory information — something to be aware of, not necessarily wrong |

### The must-fix list at publish time

When an author attempts to publish, the platform assembles every must-fix finding — from the live audit and, where one has been run, from the axe-core scan of the rendered page — and presents them in a confirmation dialogue. The author sees exactly what is wrong, grouped by rule, and must make a deliberate, informed choice before the page goes live. The dialogue also warns the author if no full audit has been run yet, or if the page has changed since the last audit, prompting a re-scan.

The rules treated as must-fix include:

- **Images without alternative text** — including images inside cards, testimonial photographs and logo strips. Authors may legitimately mark an image as decorative, in which case it is correctly hidden from screen readers instead.
- **No main heading (H1) on the page** — every page must have exactly one top-level heading, the anchor point for screen-reader navigation.
- **Buttons without an accessible name** — a button with no visible label and no screen-reader label cannot be announced to assistive technology.
- **Linked images without an accessible name** — an image acting as a link must describe its destination.
- **Elements hidden from screen readers but still keyboard-focusable** — a contradiction that strands keyboard and screen-reader users on unannounced elements.

Separately, hard block-validation errors (missing required content) prevent publishing outright.

### Colour-contrast checking to WCAG AA thresholds

The audit engine computes colour-contrast ratios using the WCAG formula wherever both the text colour and the background colour of a block are knowable at design time, and applies the **WCAG 2.1 AA thresholds: 4.5:1 for normal text and 3:1 for large text**. Failures are reported with the actual measured ratio and the required target, so authors understand precisely how far short a combination falls. Severe failures are raised as errors; marginal ones as warnings.

### Heading-structure enforcement

Screen-reader users navigate by headings, so the engine enforces a coherent document outline:

- Exactly one H1 per page (extra H1s are flagged, missing H1 is a must-fix error).
- No skipped heading levels (jumping from H2 to H4 is flagged).
- When a new block is added, the editor **suggests the correct heading level automatically**, based on what already exists on the page — making the accessible outline the path of least resistance.

### Further checks beyond the must-fix list

The live audit also covers, among others: icons with no label and no decorative marking; misuse of positive tab-index values that scramble reading order; a page whose visual order diverges from its screen-reader reading order; pricing-table tiers with unlabelled calls-to-action; interactive elements smaller than the recommended 44×44 pixel touch target on mobile; content that overflows the mobile viewport; text below 14 pixels on mobile; and content hidden on mobile but shown on desktop.

### The in-editor Accessibility panel

All findings are presented in a dedicated **Accessibility panel** inside the editor. Each finding shows the affected block, the rule, a plain-language explanation and, where available, a link to further guidance. Two tools make remediation fast:

- **Jump to block** — selects the offending block in the editor so the author can fix it immediately.
- **Locate** — highlights the block on the canvas itself.

A running count of errors, warnings and informational items is always visible in the editor toolbar, and each block in the layers panel carries an inline badge when it has open findings.

---

## 4. Built-In Accessibility of Published Pages

Authors' choices are only half the picture. The renderer that turns a CanvasBuilder design into a live web page applies a set of protections automatically, on every page, for every visitor:

- **Semantic landmark structure.** Every page has a single, correctly placed `main` content region, and authors can designate sections as `header`, `navigation`, `aside` or `footer` landmarks. The renderer actively prevents invalid combinations — for example, it will not allow nested main regions or landmark roles on elements that cannot legitimately carry them — so the landmark map screen readers rely on is always well-formed.
- **Screen-reader controls on every block.** Blocks support screen-reader labels, decorative hiding and per-block language tagging, so multilingual content is announced with the correct pronunciation.
- **Skip-to-content link.** The first element keyboard users reach on any page is a "Skip to content" link (visually hidden until focused) that jumps straight past any surrounding chrome to the main content.
- **Visible focus indication.** Every focusable element on a CanvasBuilder page receives a consistent, clearly visible focus ring, so keyboard users always know where they are. This is applied at the page level and cannot be switched off by individual block styling.
- **Accessible in-page navigation.** Anchor links scroll smoothly to their target, offset the position so content is not hidden behind sticky headers, and — critically — **move keyboard focus to the target**, so screen-reader and keyboard users land where the link promised, not merely where the viewport scrolled.
- **Reduced-motion support.** Visitors whose operating system requests reduced motion get exactly that: animations and transitions on CanvasBuilder pages are effectively disabled, and anchor scrolling jumps instantly rather than animating.
- **Dedicated alternative-text fields.** Every image-bearing block — images, cards, testimonials, logo strips — has an explicit alt-text field in its editing panel, with the option to mark genuinely decorative images so they are hidden from screen readers rather than announced as unlabelled.
- **No-JavaScript-first layout.** Page layout is delivered as a stylesheet rather than computed by scripts, so pages render correctly and immediately even for users on slow connections or with scripting restricted.

---

## 5. Independent Verification with Industry-Standard Tooling

Heuristic checks at design time are valuable, but confidence requires verification of the **real rendered page** with a tool the wider industry trusts. iConnect provides this at two levels, both built on **axe-core**, the open-source accessibility testing engine developed by Deque Systems. axe-core is the de facto industry standard: it powers the accessibility audits in Google Lighthouse and Chrome DevTools and underpins most enterprise accessibility programmes, which means iConnect's results are directly comparable with what an external auditor's tooling would report.

### In-editor full audits

From inside the editor, an author can run a full axe-core scan (using the axe-core 4.11 engine bundled with the platform) against the rendered preview of the page — including, for pages that appear differently to logged-in members and anonymous visitors, **both views**, so the public experience is verified as well as the portal one. The scan waits for the page, its images and its fonts to finish rendering before measuring, so results reflect what a visitor actually sees. Results are persisted per page, so authors can review past runs, and the publish flow warns when the latest audit is missing or has gone stale since the design changed.

### The administration Accessibility Audits area

A dedicated **Accessibility Audits** page in the administration area lets authorised administrators scan any of the organisation's live public URLs on demand:

- Scans run **axe-core version 4.10.2 in a real headless Chrome browser**, hosted by **browserless.io**, against the live published URL — the same page a member of the public receives, not a simulation.
- Results are stored per organisation with a full severity breakdown — **critical, serious, moderate and minor** — alongside pass counts and an overall score.
- Every finding can be drilled into: the specific rule, the WCAG success criterion tags it maps to, a link to remediation guidance, and the exact page elements that failed, so issues can be located and fixed precisely.
- Individual URLs can be re-run after a fix to confirm the issue is resolved, and full results can be exported for record-keeping or sharing with external reviewers.
- Access to the feature is controlled through the platform's role-based access control, so only authorised administrators can run and view audits.

The current (version 1) service applies deliberate limits: up to **10 URLs per run**, public web addresses only (no credentialed or internal URLs), with a per-page time budget. These limits keep the service predictable and are revisited as usage grows.

---

## 6. Foundational Platform Choices

Accessibility in the portal interface itself — the experience of the administrators and members who use iConnect every day — rests on deliberate foundational choices rather than after-the-fact fixes:

- **Radix UI component primitives.** The platform's interface components — dialogues, menus, tabs, tooltips, form controls and more — are built on Radix UI, a component library engineered specifically for accessibility. Radix primitives implement the WAI-ARIA design patterns: correct roles and states for assistive technology, managed keyboard focus (including focus trapping in dialogues and focus return on close), and full keyboard operability out of the box. iConnect uses these primitives across the portal, so accessibility in the day-to-day interface is a property of the platform's building blocks, not something each screen must re-implement.
- **A semantic colour system with AA-checked tokens.** The platform's design system defines semantic colour roles (including a dedicated warning colour) whose default pairings are chosen to meet WCAG AA contrast in both light and dark themes.
- **Accessibility as a first-class product feature.** The audit engine, the editor panel, the publish gate and the administration audit area are maintained, tested product surfaces — not internal tooling — which keeps accessibility visible to the people who own the content.

---

## 7. Known Limitations and Managed Risks

Transparency about limits is part of a credible accessibility posture. The current, known limitations are set out below, together with how each is managed.

| Limitation | How it is managed |
|------------|-------------------|
| **Custom HTML blocks cannot be deeply scanned at design time.** Authors can embed their own HTML, whose internals the live audit cannot fully interpret. | Every custom HTML block is automatically flagged in the Accessibility panel with an explicit prompt for manual review — the risk is surfaced, never silent. The axe-core scans of the rendered page **do** examine the real output of custom HTML, providing a second line of defence. |
| **Contrast checks are best-effort where branding colours resolve at runtime.** Some colours come from each organisation's branding theme and are only final when the page renders. | The design-time audit checks contrast wherever both colours are knowable, using conservative assumptions where they are not, and flags uncertain cases as warnings rather than passing them silently. The rendered-page axe-core scans then measure the actual resolved colours. |
| **Dynamic list blocks inherit their accessibility from the underlying platform components.** Blocks that render live content (event lists, directories and similar) reuse the platform's standard components rather than being audited element-by-element at design time. | Those shared components are built on the Radix UI foundations described above, and the rendered output is covered by the axe-core scans of the live page. |
| **No formal third-party conformance audit has yet been commissioned.** iConnect does not claim WCAG certification or publish a conformance report (such as a VPAT/ACR). | The tooling in place — axe-core against live pages, with exportable results — means the evidence base for such an audit already exists. Commissioning one is a realistic future step should client or regulatory demand warrant it (see Section 8). |

It is also worth stating plainly what automated tooling can and cannot do: automated engines such as axe-core reliably detect the majority of *machine-detectable* accessibility failures, but no automated tool can certify full WCAG conformance — some criteria (such as the appropriateness of alternative text, or the logic of a form's error recovery) require human judgement. iConnect's layered approach narrows that gap by guiding authors at the moment of creation, but human review remains part of any complete accessibility programme.

---

## 8. Summary and Possible Next Steps

CanvasBuilder gives non-technical authors the freedom to build public web pages while keeping accessibility on rails:

- **Prevention** — a continuously running audit engine in the editor, WCAG AA contrast thresholds, heading-structure enforcement, and an informed-consent gate on publishing with must-fix issues outstanding.
- **Protection** — accessible foundations built into every rendered page: landmarks, skip links, focus visibility, keyboard-friendly navigation, reduced-motion support and dedicated alt-text everywhere an image can appear.
- **Proof** — independent verification of live pages with axe-core, the industry-standard engine, run in real browsers against real URLs, with stored, exportable, drill-down results.

Possible next steps the board may wish to consider, in rough order of effort:

1. **Scheduled automatic audits** — running the axe-core scans on a recurring schedule and alerting administrators to regressions, rather than relying on on-demand runs.
2. **Raising the version-1 audit limits** as usage grows (more URLs per run; authenticated page scanning).
3. **A commissioned third-party accessibility audit** of representative tenant pages, producing a formal conformance statement — the strongest possible external signal, and one the existing tooling has already prepared the ground for.

The direction of travel is clear: accessibility in CanvasBuilder is not a bolt-on check but a property of how pages are designed, rendered and verified — measured with the same tools the rest of the industry uses.

---

*This document reflects the platform as implemented at the date shown above. Statements about tooling and behaviour are drawn directly from the current production codebase.*
