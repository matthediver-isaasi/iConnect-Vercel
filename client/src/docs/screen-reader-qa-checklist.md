# Screen Reader QA Checklist (Pilot)

Manual checklist for verifying a CMS page that has **Screen reader optimised**
turned on. Run through this with NVDA (Windows / Firefox or Chrome) and
VoiceOver (macOS Safari) before declaring a page ready.

## Setup

- NVDA: download from <https://www.nvaccess.org/>. Toggle with `Insert+N`.
- VoiceOver: built into macOS. Toggle with `Cmd+F5`.
- Test in an **incognito** window with no member logged in, then again logged
  in as a member, to cover both rendering paths.

## Page-level

- [ ] `<html lang="en">` is set (or the tenant's configured language).
- [ ] First focusable element is **Skip to main content**; Enter jumps focus
      into the main content region.
- [ ] Page `<title>` is unique and descriptive (matches what the page is
      about, not just the site name).
- [ ] Exactly **one `<h1>`** on the page. Sub-headings use `<h2>` / `<h3>`
      with no skipped levels (no `<h1>` directly to `<h3>`).
- [ ] Landmarks present: `<header>`, `<main id="main-content">`, `<footer>`.
      VoiceOver rotor (`VO+U`) and NVDA elements list (`Insert+F7`) show
      them.

## Images

- [ ] Each meaningful image is announced with a sensible alt text.
- [ ] Each decorative image is silent (announced as nothing) — not as the
      filename or "graphic".
- [ ] No image is announced as `image_1234.jpg` or similar.

## Interactive controls

- [ ] Every CTA button announces its purpose (button text or `aria-label`).
- [ ] Icon-only buttons (close, prev, next, play, search) announce a name.
- [ ] All controls are reachable with the keyboard (`Tab` / `Shift+Tab`).
- [ ] Focus ring is visible on every focused control.

## Carousel (banner_carousel / hero_carousel)

- [ ] Announced as a carousel (region with "carousel").
- [ ] Each slide is a labelled region: "Slide 1 of 5", etc.
- [ ] Prev / Next buttons have names ("Previous slide", "Next slide").
- [ ] If autoplay is on, a **Pause** control exists and works.

## Accordion

- [ ] Each trigger announces "expanded" or "collapsed".
- [ ] Activating a trigger toggles the state and the screen reader announces
      the new state.
- [ ] The associated panel is linked (focus moves logically into it on
      expand).

## Tabs

- [ ] Tab list is announced ("tab list").
- [ ] Each tab announces "selected" / "not selected".
- [ ] Arrow keys move between tabs; Enter / Space activates.

## Gallery → Lightbox dialog

- [ ] Activating a gallery card opens a dialog announced as "dialog" with a
      title (the gallery title).
- [ ] Focus moves into the dialog when it opens.
- [ ] `Tab` cycles only through controls inside the dialog (focus trap).
- [ ] `Escape` closes the dialog.
- [ ] On close, focus returns to the gallery card that opened it.
- [ ] Prev / Next buttons inside the dialog have names.

## Video

- [ ] The video iframe has an accessible name (the video title, not just
      "iframe").
- [ ] If a transcript is authored, a **Show transcript** control is present
      below the video and the transcript content is reachable.
- [ ] If captions are configured, the player exposes them.

## Live region (async UI)

- [ ] Submitting an embedded form triggers a polite announcement (e.g.
      "Form submitted").
- [ ] Toast / error messages on this page announce in the live region.
- [ ] No live region spam — announcements happen once per change, not on
      every render.

## Sign-off

- [ ] Tested with NVDA + Firefox.
- [ ] Tested with VoiceOver + Safari.
- [ ] Both desktop and mobile-width viewports.
- [ ] No `axe-core` console errors (dev mode).

Record date, tester, and any deviations against the page in the platform
team's accessibility tracker.
