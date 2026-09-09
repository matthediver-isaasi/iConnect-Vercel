---
title: "iConnect — Event Microsite User Guide"
subtitle: "Plan, build, launch and retire an in-person event microsite"
date: "9 September 2026"
version: "1.0"
---

# Event Microsite User Guide

**Audience:** Non-technical site and event administrators  
**Example used:** Northstar Summit, an in-person conference  
**Version:** 1.0 · 9 September 2026

---

# Contents

1. [What an event microsite does](#1-what-an-event-microsite-does)
2. [Plan before you build](#2-plan-before-you-build)
3. [Create the microsite](#3-create-the-microsite)
4. [Create, assign and publish pages](#4-create-assign-and-publish-pages)
5. [Choose the home page](#5-choose-the-home-page)
6. [Build the navigation](#6-build-the-navigation)
7. [Brand the microsite](#7-brand-the-microsite)
8. [Set microsite typography](#8-set-microsite-typography)
9. [Preview, test and launch](#9-preview-test-and-launch)
10. [Promote and operate the event](#10-promote-and-operate-the-event)
11. [Retire the microsite safely](#11-retire-the-microsite-safely)
12. [Troubleshooting and checklists](#12-troubleshooting-and-checklists)

---

# 1. What an event microsite does

A microsite is a group of public pages with its own URL section, navigation, header, footer and optional branding. It is useful when an in-person event needs a focused visitor journey without creating a separate website.

For example, a microsite with the prefix **northstar-2026** and a page slug **agenda** is served at:

`https://your-site.example/northstar-2026/agenda`

If an assigned page is selected as the home page, the shorter base address also opens it:

`https://your-site.example/northstar-2026`

## Microsite versus event management

| Use the microsite for | Use event management for |
|---|---|
| Overview and promotional content | Event record, dates and operational status |
| Agenda presentation and speaker stories | Sessions, tracks and speaker assignments |
| Venue, travel, sponsors and FAQs | Tickets, prices, eligibility and capacity |
| Clear links to registration | Registration, payment and attendee records |
| Event-specific navigation and branding | Confirmations, check-in and attendance |

**Important:** a microsite does not create or manage the event itself. Create the event and registration journey in the event area, then link to the correct registration page from the microsite.

---

# 2. Plan before you build

## Recommended information architecture

| Page | Purpose | Suggested call to action |
|---|---|---|
| Overview | Event promise, date, place and key reasons to attend | Register now |
| Agenda | Day-by-day programme or summary | View tickets |
| Speakers | Biographies, headshots and session highlights | See the agenda |
| Venue & travel | Address, map link, transport, hotels and accessibility | Plan your journey |
| Sponsors | Sponsor levels, logos and approved links | Become a sponsor |
| FAQs | Registration, accessibility, dress, food and contact answers | Contact the team |

You may also add a single registration link directly to the header. Keep the main navigation short: five to seven top-level choices is usually enough.

## Prerequisites

- Permission to use **Microsites** and the page editor.
- Existing or planned public pages for the event.
- Final event name and a short, durable URL prefix.
- Approved logos, colours, social-sharing image and sponsor assets.
- The correct event registration URL.
- A colleague who can test as a signed-out visitor on desktop and mobile.

## Naming and URL decisions

Choose a prefix containing lowercase letters, numbers and hyphens, such as **northstar-2026**. It must be one URL segment and cannot duplicate a reserved route or an existing page slug.

Changing a prefix changes every microsite page URL. Decide it before promotion and avoid changing it after launch.

---

# 3. Create the microsite

1. Open **Microsites**.
2. Select **New microsite**.
3. Enter a clear internal **Name**, for example *Northstar Summit 2026*.
4. Enter the **URL prefix**, for example *northstar-2026*.
5. Add an optional description.
6. Optionally enter a **Logo URL**. More complete image controls are available later under **Header & Footer**.
7. Leave **Active** on while configuring if only unpublished pages are assigned. If published pages already exist, consider switching it off until launch.
8. Select **Save**.

### Interface illustration — New microsite

1. **Name** identifies the microsite in the management list.  
2. **URL prefix** creates the first part of every microsite page URL.  
3. **Active** controls whether the microsite can be resolved publicly.  
4. **Save** creates the microsite; choose its home page after assigning pages.

**Active and published are separate controls.** The microsite must be active *and* each page must be published for ordinary visitors to see it.

---

# 4. Create, assign and publish pages

## Create or prepare each page

Use the normal page management and editor workflow. For event information pages, choose a public view type. Build the content, save it and use **Preview as visitor** during editing.

Publishing is controlled in the page editor using **Publish** / **Unpublish**. Saving content does not publish it.

## Assign an existing page

1. Open **Microsites** and select the event microsite.
2. Open the **Pages** tab.
3. Under **Assign an existing page**, search by title or slug.
4. Select **Assign** beside the page.
5. Confirm that it appears under **Pages in this microsite** with the expected prefixed URL.
6. Repeat for the overview, agenda, speakers, venue/travel, sponsors and FAQs.

### What happens when a page is assigned

Before assignment, a page with slug **agenda** is served at `/agenda`. After assignment to **northstar-2026**, it moves to `/northstar-2026/agenda`. The bare `/agenda` address no longer serves that page.

Update links, QR codes and campaign content that used the old address. Navigation is not created automatically.

## Remove a page

Select **Remove** beside an assigned page. It returns to the default site and is again served at its bare slug. If it was the microsite home page, choose another home page. Review navigation links manually.

**Do not move a live page casually.** Assignment and removal change its public address.

---

# 5. Choose the home page

The home page opens at the microsite’s short base URL and is the destination for the microsite logo.

1. Assign the intended overview page to the microsite.
2. Select **Edit** beside the microsite name.
3. Open **Home page**.
4. Choose the assigned overview page.
5. Select **Save**.
6. Test both `/northstar-2026` and `/northstar-2026/overview`.

Only pages already assigned to this microsite appear in the home-page list. If no home page is selected, do not assume the base prefix is a visitor landing page; promote a full page URL instead.

---

# 6. Build the navigation

Microsite navigation replaces the tenant’s normal navigation on microsite pages.

## Add page links

1. Select the microsite and open **Navigation**.
2. Select **Add item**.
3. Enter a short **Label**, such as *Agenda*.
4. For an internal microsite page, enter the full prefixed path, such as `/northstar-2026/agenda`.
5. Choose a location: **Main navigation**, **Top bar** or **Footer**.
6. Leave the item active and save it.
7. Use the up/down controls to set the order.
8. Optionally add sub-items for dropdowns. Navigation supports up to three levels; footer items remain flat.

Use an external link for a destination outside the site, such as a hotel or registration provider. Check that the saved destination opens correctly.

## Header elements

The **Header Elements** card can add **Search**, **Social Icons** and **Account**. Each can be added once and starts in the Top bar; it can then be moved to the Main navigation.

For Search, decide whether results may include the whole site or only this microsite. Search-result font and type-label colour can be overridden; blank values fall back to tenant styling.

## Navigation safety

- A hidden navigation item does not unpublish its destination.
- A published page does not automatically appear in navigation.
- Internal microsite links must include the prefix.
- Navigation can link to event registration, but does not configure registration.
- Test every menu item while signed out.

---

# 7. Brand the microsite

Open **Header & Footer**. Each branding card has an **Override** switch. When Override is off, the microsite inherits the current tenant branding. When it is on, the microsite stores its own value for that section.

This inheritance model is useful: override only what the event needs. Future main-site branding changes continue to flow through all non-overridden sections.

## Supported branding controls

| Section | What you can tailor |
|---|---|
| Colors | Primary and secondary colours |
| Logo | General logo used on pages, footer and previews |
| Header Logo | Header image, dimensions and optional shrink-on-scroll |
| Header Gradient Colors | Header background gradient |
| Top Navigation Bar | Link colour, hover colour, font, size, weight and wrapping width |
| Login / Member Area buttons | Separate labels and styling for signed-out and signed-in visitors |
| Secondary Lower Navigation Bar | Optional lower bar, height, colours and active indicator |
| Link Previews | 1200×630 share image, tagline and description |
| Footer source | Main-site footer, configured microsite footer or reusable Canvas footer |
| Footer Configuration | Columns, colours, address, contact and legal text |
| Social Icon Colors | Header and footer social icon colours |

Select **Save branding** after changes.

## Practical event choices

- Use the event logo in the header, with legible dimensions on desktop and mobile.
- Use event colours selectively and keep text/background contrast strong.
- Create a 1200×630 social image containing the event name, date and location.
- Keep legal and contact content current in the footer.
- If using a reusable Canvas footer, select one before saving.
- If using a configured microsite footer, enable its Footer Configuration override.

**Fallback reminder:** turning an Override off removes the microsite-specific values for that section and returns it to tenant branding.

---

# 8. Set microsite typography

Typography styles are managed separately from the Header & Footer tab.

1. Open the installed fonts / typography area.
2. Select the event microsite in the **scope** selector, not **Main site**.
3. Create or edit styles for H1, H2, H3, H4 and paragraph text as needed.
4. Choose an installed font, size, weight, line height, letter spacing, text transform, colour and spacing.
5. Optionally set tablet and mobile values.
6. Mark a style as the default for its type if required, keep it active and save.
7. Preview several microsite pages at desktop, tablet and mobile widths.

Microsite typography falls back to the corresponding main-site default when the microsite has no default for that style type. Font installation makes a font available; the scoped typography style applies it to page content.

---

# 9. Preview, test and launch

## Preview before publishing

Use **Preview as visitor** in the page editor. For an assigned page, the preview uses the prefixed microsite URL. Draft preview is an editing tool; it does not mean the page is public.

## Launch order

1. Finish and save all page content.
2. Assign every page and verify its new URL.
3. Choose and test the home page.
4. Build navigation with prefixed internal links.
5. Apply branding and microsite-scoped typography.
6. Publish the pages.
7. Switch the microsite **Active** on.
8. Test as a signed-out visitor in a private browser window.
9. Test desktop and mobile layouts.
10. Only then distribute links and QR codes.

## Launch checklist

- [ ] Base URL opens the intended home page.
- [ ] Every promoted page is assigned and published.
- [ ] No old bare-slug link is used.
- [ ] Main navigation, top bar, dropdowns and footer links work.
- [ ] Registration buttons open the correct event journey.
- [ ] Search behaves as intended for microsite-only or whole-site results.
- [ ] Logo links to the microsite home page.
- [ ] Header, footer and typography are readable on mobile.
- [ ] Social share image, title and description are suitable.
- [ ] Venue, travel, accessibility and contact details are accurate.
- [ ] A signed-out visitor can use all intended public pages.

---

# 10. Promote and operate the event

Use the base URL in general promotion and deep links for agenda, venue or FAQs where helpful. Generate QR codes only after URLs are final.

During the event:

- Keep agenda and venue updates short and prominent.
- Put urgent updates near the top of the overview page.
- Re-test registration links if ticket availability changes.
- Use the microsite for information; use event management for bookings, attendee records, check-in and attendance.
- After edits, save and confirm the public page. Content edits do not require a new microsite.

Search and navigation help visitors find published content; they do not override page publication or microsite active status.

---

# 11. Retire the microsite safely

Do not delete the microsite immediately after the event. Old emails, bookmarks and QR codes may still be used.

## Recommended retirement

1. Replace the overview with a post-event message and useful next steps.
2. Remove or update registration calls to action.
3. Keep venue, sponsor and selected recap information only as long as required.
4. Unpublish pages that should no longer be public.
5. When the archive period ends, edit the microsite and switch **Active** off.
6. Check campaign, QR-code and external links before any deletion.
7. Delete only when you intentionally want its pages returned to the default site.

## What deletion does

Deleting the microsite removes its navigation items and returns its pages to the default site, where their bare slugs are served again. This cannot be undone from the microsite screen and may expose still-published pages at new addresses.

For most events, **inactive** is safer than **delete**. If deletion is necessary, unpublish or review every assigned page first.

---

# 12. Troubleshooting and checklists

## A page shows “not found”

- Confirm the microsite is active.
- Confirm the page is assigned to this microsite.
- Confirm the page is published.
- Use `/{prefix}/{slug}`, not the old bare slug.

## The base URL does not show the overview

Edit the microsite and choose an assigned page under **Home page**. Save, then test the base URL again.

## A page disappeared from the main site

This is expected after assignment. Its public address has moved from `/{slug}` to `/{prefix}/{slug}`. Remove it from the microsite only if it should return to the main site.

## Branding looks like the main site

Open **Header & Footer**, enable Override for the required section, set its values and select **Save branding**. Sections without Override intentionally inherit tenant branding.

## A navigation link opens the wrong place

Edit the item and use the complete prefixed path for an internal microsite page. Confirm it points to the page’s current slug and that the item is active.

## Search includes unwanted main-site results

Edit the Search header element and set it to search this microsite only. Remember that the search control must be added to navigation before visitors can use it.

## Pre-launch handover

Record the prefix, base URL, home page, page owners, event-management registration URL, retirement date and person responsible for post-event content. This small handover prevents accidental URL changes and abandoned registration links.

---

*Document control: Event Microsite User Guide · Version 1.0 · 9 September 2026.*