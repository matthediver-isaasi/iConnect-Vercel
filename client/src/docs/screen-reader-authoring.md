# Screen Reader Authoring Guide

A short, plain-language guide for editors who turn on **Screen reader optimised**
on a CMS (page builder) page.

## What the toggle does

Turning on **Screen reader optimised** in Page Settings tells the platform that
this page should be carefully checked and rendered for people who use a screen
reader (NVDA on Windows, VoiceOver on Mac/iOS, TalkBack on Android).

When the toggle is on:

- The page uses a clear heading order (one main heading, then sub-headings).
- The photo gallery viewer becomes a proper accessible dialog.
- Carousels, accordions, tabs and icon-only buttons announce themselves
  correctly.
- Decorative images are marked as decorative so screen readers skip them.
- A video can have an optional transcript and captions.
- Important page changes (form submitted, item saved) are announced.

The toggle is **off by default**. Leave it off for pages you have not had time
to check.

## Headings

Pick one short, descriptive **page title** in Page Settings — it becomes the
single main heading on the page. Use sub-headings within elements (Hero,
Text Block, Section headings) to break the page into logical sections, in
order: page title → section headings → smaller sub-sections. Don't skip
levels (don't jump straight from a page title to a tiny sub-heading).

## Images

For every image on a flagged page, do one of two things:

1. **Add alt text** that describes what the image shows in one short sentence.
   Don't start with "Image of…" — screen readers already say "image". If the
   image contains text (a poster, an infographic), include the text.
2. **Mark it as decorative** if the image is purely there to look nice and a
   blind user would lose nothing by skipping it. Decorative images are
   announced as nothing at all.

If you save an image without alt text on a flagged page, the platform shows
a soft warning in the editor and renders the image as decorative (so it isn't
announced as a meaningless filename).

## Links and buttons

Every link and button needs to make sense out of context. Avoid "Click here",
"Read more", "Learn more" on their own — a screen-reader user often hears just
the link text without the surrounding sentence. Prefer "Read the 2026 annual
report", "Book a place on the spring conference".

For icon-only buttons (a search magnifier, a close X), the editor sets an
**accessible label** so the button is announced as "Search" or "Close" rather
than just "button".

## Videos

For a flagged page, the video element exposes two extra fields:

- **Transcript** — a rich-text version of what is said in the video. This is
  what someone reads if they cannot hear the audio. Even a rough transcript
  is much better than nothing.
- **Captions track URL** — a link to a `.vtt` captions file if you have one.
  These are the on-screen captions a viewer can turn on in the player.

Captions and transcripts are not generated automatically — please supply them
where you can.

## Forms

Forms are out of scope for this pilot — they will get their own dedicated
screen-reader pass in a follow-up. You can still embed a form on a flagged
page; the platform announces "Form submitted" when it is sent.

## Quick checklist before turning the toggle on

- [ ] One clear page title that names the page.
- [ ] Sub-headings break the page into logical sections, in order.
- [ ] Every meaningful image has alt text.
- [ ] Every decorative image is marked decorative.
- [ ] Link text makes sense on its own.
- [ ] Any video has a transcript (and captions if available).

If you're unsure about any of the above, ask the platform team before turning
the toggle on. It is better to leave it off than to claim a page is screen-
reader friendly when it isn't.
