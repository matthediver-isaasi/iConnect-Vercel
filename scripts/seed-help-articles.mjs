/**
 * Seed the Help Center articles.
 *
 * Task #2199 introduced a thin pilot; Task #2208 rewrites and expands every
 * pilot area to a professional depth and adds RBAC awareness:
 *   - `required_feature` gates a whole article (hidden on the index + not
 *     openable by URL for members who lack that feature).
 *   - {{feature: KEY}} ... {{/feature}} markers gate a section inside an
 *     article, so members only see the sub-features they can actually use.
 *
 * GLOBAL content — shared across every tenant. Idempotent: matches existing
 * rows by slug and updates them, otherwise inserts. Safe to re-run; supersedes
 * the thin pilot bodies. Slugs no longer authored are left untouched (delete
 * them from the platform editor if you want them gone).
 *
 * Uses @supabase/supabase-js against the destination (prod) Supabase, which is
 * IPv4-reachable from this workspace (the direct Postgres host is not).
 *
 * Usage:
 *   node scripts/seed-help-articles.mjs            # dry-run (prints plan)
 *   node scripts/seed-help-articles.mjs --apply    # write changes
 */
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');

const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;

if (!url || !key) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const ARTICLES = [
  // ------------------------------------------------------------------ Basics
  {
    slug: 'getting-started',
    title: 'Getting started with your member portal',
    category: 'Getting started',
    summary: 'A quick tour of the portal, how to sign in, and where to find everything.',
    status: 'published',
    sort_order: 0,
    required_feature: null,
    body: `Welcome to your member portal. This guide gives you the lay of the land so you always know where to go.

## Signing in
You sign in with the email address your organisation holds for you.

- Go to your organisation's portal address and choose to sign in.
- Enter your email and password. If your organisation uses Google sign-in, you can use the "Continue with Google" button instead.
- Forgotten your password? Use the "Forgot password" link on the sign-in page and follow the email you receive.

{{screenshot: The sign-in page}}

## Finding your way around
The main navigation lists everything available to you. What you see depends on your membership and your role, so your menu may be shorter or longer than a colleague's — that's normal.

Common areas include:

- Events — browse what's on and book your place
- My Tickets — see and manage bookings you've made
- Balances — your training fund and any training vouchers
- Resources — documents and guides your organisation shares
- About Me — your profile, contact details and communication preferences

{{screenshot: The main portal navigation}}

## What to do first
- Open About Me and check your name, contact details and email are correct.
- Review your communication preferences so you only get the emails you want.
- Have a look at Events to see what's coming up.

If a menu item you expect is missing, it usually means your role doesn't include that area. Your organisation's administrator can adjust this.`,
  },
  {
    slug: 'getting-help',
    title: 'Getting help and support',
    category: 'Getting started',
    summary: 'How to find answers and reach your organisation when you need a hand.',
    status: 'published',
    sort_order: 1,
    required_feature: null,
    body: `If you can't find what you need, help is close by.

## Search the Help Center
The fastest route is usually right here. Use the search box at the top of the Help Center to find an article by keyword — for example "cancel", "voucher" or "password".

{{screenshot: Searching the Help Center}}

## Contact your organisation
If an article doesn't answer your question, your organisation can help directly.

- Use the Support area (where available) to send a message. Choosing the right request type helps it reach the right person.
- Include as much detail as you can (see below) so they can help quickly.

{{screenshot: The support request form}}

## What to include when you ask for help
- A clear description of what you were trying to do.
- What actually happened instead.
- Any error message you saw, word for word if possible.
- The page or event you were on.

The more detail you give, the faster your organisation can sort it out.`,
  },

  // ------------------------------------------------------------------ Events
  {
    slug: 'browsing-and-booking-events',
    title: 'Browsing events and making a booking',
    category: 'Events',
    summary: 'Find what\'s on, understand the event details, and start a booking.',
    status: 'published',
    sort_order: 10,
    required_feature: 'events.browse-events',
    body: `The Events area lists everything your organisation is running. This article covers finding an event and starting a booking; the next articles cover who you're booking for, ticket types, discounts and payment.

## Finding an event
Open Events from the navigation to see upcoming events.

- Use the search box and filters to narrow the list by keyword, programme or tag.
- Each card shows the title, date and time, and whether the event is online or in person.

{{screenshot: The Events listing with filters}}

## Understanding an event page
Select an event to open its details page. Here you'll find:

- The full date and time, shown in the event's timezone.
- The location, or an "Online Event" label with a video icon for webinars. For online events, the join link appears once you're booked (and when your organisation has chosen to show it).
- An "About this event" description. If it's long, use "Show more" to expand it.
- Seat availability where your organisation shows it — for example "5 seats available", "Sold out", or "Open Registration" for events with no limit.
- Any early-bird pricing, shown with a countdown and the standard price crossed out while the early-bird period is running.

{{screenshot: An event details page}}

## Starting a booking
When you're ready, use the booking button on the event page. This begins the booking flow where you'll:

1. Choose who is attending (yourself and/or colleagues and guests).
2. Pick a ticket type if the event has more than one.
3. Apply any discount code, voucher or training fund.
4. Choose how to pay and confirm.

If the booking button isn't available, the event is either full or bookings have closed.`,
  },
  {
    slug: 'registering-yourself-and-colleagues',
    title: 'Registering yourself, colleagues and guests',
    category: 'Events',
    summary: 'Book a place for yourself, add team members, or register external guests.',
    status: 'published',
    sort_order: 11,
    required_feature: 'events.browse-events',
    body: `When you book an event you decide who is attending. You can book just for yourself, add colleagues from your organisation, or register external guests — depending on what your access allows.

{{feature: events.event-details.self-registration}}
## Registering yourself
By default you're added as the first attendee. If you're only booking for yourself, you can move straight on to choosing a ticket and paying.

You can also add options for each attendee where the event asks for them:

- Dietary requirements (for example Vegan or Gluten-Free).
- Allergies, with a severity of Mild, Moderate or Severe.
- Accessibility needs.

{{screenshot: Attendee details with dietary and accessibility options}}
{{/feature}}

{{feature: events.event-details.add-colleagues}}
## Adding colleagues from your organisation
You can book places for other people in your organisation.

- Use the colleague search to find team members by name or email. Only colleagues who can sign in and are eligible for the event appear.
- Select a colleague to add them as an attendee.
- A green highlight means they're a recognised member; a blue highlight means they belong to your organisation but haven't set up their portal account yet — that's fine, they can still attend.

{{screenshot: Searching for a colleague to add}}
{{/feature}}

{{feature: events.event-details.register-external}}
## Registering external guests
If the event allows it, you can add someone who isn't part of your organisation.

- Enter their email address. If it isn't recognised, you'll be asked for their first and last name.
- External guests are marked so organisers know they're not members.

{{screenshot: Adding an external guest}}
{{/feature}}

## Booking as a guest (not signed in)
If you reach an event page without signing in, you can still book by entering your first name, last name, email, organisation and phone number. If your email matches an existing member, you'll be prompted to sign in first so the booking is linked to your account.

## Removing an attendee
Made a mistake? Remove any attendee from the list before you confirm, and the total updates automatically.`,
  },
  {
    slug: 'ticket-types-and-member-only-tickets',
    title: 'Ticket types and member-only tickets',
    category: 'Events',
    summary: 'Understand standard, member-only and volume tickets, and who can book them.',
    status: 'published',
    sort_order: 12,
    required_feature: 'events.browse-events',
    body: `Some events offer a single place; others have several ticket types at different prices. This article explains the choices you might see.

## Choosing a ticket type
Where an event has more than one ticket, pick the one that applies to you before you continue. The price for each ticket is shown next to it, including any early-bird price while that's running.

{{screenshot: An event with multiple ticket types}}

## Member-only tickets
Some tickets are reserved for members, or for particular membership groups or roles. If a ticket isn't available to you, it may be hidden or shown with a lock icon and disabled.

- A "Show all tickets" switch lets you see every ticket, including ones you can't book, so you understand the full picture.
- If you believe you should be able to book a member-only ticket, contact your organisation's administrator to check your membership.

{{screenshot: A member-only ticket shown with a lock}}

## Volume and bundle offers
Events can offer better value when you book several places at once:

- Buy X, get Y free — for example buy four places and get the fifth free.
- Bulk discount — a percentage off once you reach a threshold, for example 10% off for five or more.

These are applied automatically once you add enough attendees, and you'll see the saving reflected in the total.

Next, see "Discount codes, vouchers and training funds" and "Paying for your booking" to complete your booking.`,
  },
  {
    slug: 'discount-codes-vouchers-training-funds',
    title: 'Discount codes, vouchers and training funds',
    category: 'Events',
    summary: 'Reduce the cost of a booking with a code, a training voucher, or your fund.',
    status: 'published',
    sort_order: 13,
    required_feature: 'events.browse-events',
    body: `There are three ways the cost of an event booking can come down: a discount code, a training voucher, or your organisation's training fund. You can often combine them, and card payment covers anything left over.

## Discount codes
If you've been given a discount code, enter it in the "Discount Code" field during booking and apply it. A valid code reduces the total straight away, before any voucher or fund is applied.

- If a code is rejected, check for typos and that it hasn't expired or reached its usage limit.

{{screenshot: Entering a discount code}}

{{feature: events.event-details.use-vouchers}}
## Training vouchers
Training vouchers are prepaid credit you can spend on eligible events.

- Choose a voucher from your available vouchers during booking. They're listed with their value and expiry, soonest expiry first.
- If a voucher doesn't cover the whole cost, you'll see the remaining balance and can pay the rest another way.
- If it more than covers the cost, the leftover value stays on the voucher for next time.

You can review your vouchers any time in the Balances area.

{{screenshot: Selecting a training voucher}}
{{/feature}}

{{feature: events.event-details.use-training-fund}}
## Training fund
Your organisation may hold a training fund that you can draw on.

- Enter the amount you'd like to use from the fund toward this booking.
- The amount you enter can't exceed your available fund balance.
- Anything not covered by the fund can be paid by card or purchase order.

You can see your fund balance, including any pending amount awaiting an invoice payment, in the Balances area.

{{screenshot: Applying training fund to a booking}}
{{/feature}}

## Making a donation (optional)
Some events invite an optional donation. You can add a preset or custom amount, and UK taxpayers can add Gift Aid to boost it by 25% at no extra cost.

Once you've applied any of the above, move on to "Paying for your booking" to settle any remaining balance.`,
  },
  {
    slug: 'paying-for-your-booking',
    title: 'Paying for your booking',
    category: 'Events',
    summary: 'Pay the remaining balance by card or by purchase order, and confirm.',
    status: 'published',
    sort_order: 14,
    required_feature: 'events.browse-events',
    body: `After you've chosen attendees and applied any discount, voucher or fund, you settle whatever is left. This article covers the payment step and confirming your booking.

## What's left to pay
The booking summary shows the total, any reductions applied, and the remaining balance. If a voucher or fund covers everything, there may be nothing left to pay and you can confirm directly.

{{screenshot: The booking summary and payment options}}

## Paying by card
For any remaining balance you can pay securely by card.

- Enter your card details when prompted.
- If your bank asks you to confirm the payment (3D Secure), you'll be taken to their verification step and returned automatically. Your booking completes once payment is confirmed — don't refresh or close the page while this happens.

## Paying by purchase order
Where your organisation allows account payment, you can pay by purchase order (PO) instead of card.

- Choose the purchase order option.
- Either enter your PO number now, or choose to supply it later if you don't have it yet.
- Your organisation will be invoiced and the booking is recorded against the account.

{{screenshot: Choosing to pay by purchase order}}

## Confirming
Once payment is arranged, confirm the booking. You'll see a confirmation and your booking reference, and the booking then appears under My Tickets. If the event is online, your join link becomes available there.

If a card payment fails, nothing is charged twice — check the card details and try again, or choose another payment method.`,
  },
  {
    slug: 'managing-transferring-cancelling-tickets',
    title: 'Managing, transferring and cancelling your tickets',
    category: 'Events',
    summary: 'View bookings, add them to your calendar, transfer a place, or request a cancellation.',
    status: 'published',
    sort_order: 15,
    required_feature: 'events.my-tickets',
    body: `Everything you've booked lives under My Tickets. From here you can check the details, add an event to your calendar, transfer a place, or ask to cancel.

## Viewing your tickets
Open My Tickets to see your bookings, each with its status and booking reference:

- Confirmed — your place is secured.
- Pending — the booking is awaiting something, such as payment or approval.
- Cancelled — the booking has been cancelled.

{{screenshot: The My Tickets list}}

## Adding an event to your calendar
Use "Add to Calendar" on a booking to download a calendar file you can open in your usual calendar app.

## Transferring a place
If you can't attend, you may be able to pass your place to an eligible colleague.

- Choose "Transfer" on the booking.
- Select the person to transfer to and confirm.

{{screenshot: Transferring a ticket to a colleague}}

## Requesting a cancellation
Where self-service cancellation is available, you can request to cancel a booking.

- Choose "Cancel" on the booking.
- Add a reason if asked, and accept the cancellation terms and conditions.
- Submit your request.

Two things to know:

- There may be a cancellation deadline. If the event is too close, self-service cancellation is closed and you'll see a "deadline has passed" message — contact your organisation if you still need to cancel.
- Cancellations may need approval. Until an administrator approves it, the booking shows a "Cancellation Pending" badge. Any refund of card payments, vouchers or fund follows your organisation's process once approved.

{{screenshot: Requesting a cancellation with terms}}`,
  },
  {
    slug: 'running-in-person-events-checkin',
    title: 'Running in-person events: QR check-in, scanning and reports',
    category: 'Events',
    summary: 'Everything for the door on event day — QR codes, the scanner app, the check-in dashboard, walk-ins, badges and attendance reporting.',
    status: 'published',
    sort_order: 16,
    required_feature: 'events.event-checkin',
    body: `If you help run events, this article covers what's available for the day itself: getting attendees registered, checking them in at the door with QR codes or the dashboard, handling walk-ins, and reporting on who came.

## Getting attendees registered
Attendees usually book themselves through the normal booking flow — see "Browsing events and making a booking" and "Registering yourself, colleagues and guests". A booker can register colleagues and external guests in one booking, and events can offer member-only ticket types.

Admins can also add attendees directly from the event's attendee management screen:

- Import a CSV of attendees (name, email, organisation, job title) or paste a simple list of email addresses.
- Each row is matched against your members by email. Recognised members are added as member bookings (their member record's details are used); everyone else is added as a guest booking.
- For multi-session events you choose which ticket class imported attendees go into; if a guest is imported into a members-only ticket class you'll see a warning so you can double-check.
- Duplicate emails within the file, and people who already have a booking, are skipped automatically — so re-importing the same file is safe.
- Confirmation emails are sent to imported attendees by default; untick the option if you're adding people quietly (for example a walk-in you've already greeted).

{{screenshot: Importing attendees from a CSV}}

## QR codes on booking confirmations
When someone books an in-person event, their confirmation email can include a personal QR code — this is what door staff scan to check them in.

- The QR code is unique to each booking. For multi-session events, attendees get a separate QR code per session they're registered for.
- The "Include QR code on confirmation" toggle when creating or editing an event controls this. It's on by default for in-person events; online events don't get check-in QR codes.

{{screenshot: A confirmation email with a check-in QR code}}

## Scanning at the door
Door staff use the mobile scanner app to check people in:

- Point the camera at the attendee's QR code. The app looks the booking up and shows the attendee's details — their name, email, designation, the session the ticket is for, and any dietary requirements, allergies or accessibility needs they gave when booking.
- One tap marks them as arrived. If a code has already been used, staff see "Already checked in" with the time, so a duplicate scan can't count someone twice.
- A live counter at the top shows how many people have arrived out of the total, updating as the team scans.
- Check-ins can be undone — staff must enter a reason, so there's always a record of why.
- Important form answers can be flagged so they appear as alert badges when that attendee is scanned — for example "Has ID" or a VIP marker — and speakers are highlighted so staff know to direct them appropriately.

{{screenshot: The scanner app with an attendee's details}}

## The Event Check-In Dashboard
The Event Check-In page gives you the full picture from a laptop or tablet:

- See live counts of arrived vs. expected, updating in real time as staff scan.
- Search attendees by name or email, and filter by check-in status, ticket type, track or session, and other markers such as speaker or badge.
- Check anyone in manually — useful when someone arrives without their QR code — and undo a check-in with a reason if needed.
- Each attendee row shows their profile photo (where one is on file) alongside their key markers — designation, speaker, badge and any flagged form answers — so the team knows who they're greeting.
- Dietary, allergy and accessibility needs appear on the scanner when the attendee is scanned in, and in the Event Registration Report for planning ahead of the day.

{{screenshot: The Event Check-In Dashboard}}

## Badges and walk-ins
- Each attendee has a "badge" marker (on by default) that you can switch on or off from the event's attendee list — handy for tracking who needs a name badge printed. The marker also shows on the check-in dashboard and in the registration report.
- For walk-ins, either check the person in manually from the dashboard, or add them on the spot via the attendee import (a single row with their email is enough) and then check them in.

## Multi-session events
For larger events with multiple sessions and tracks:

- Check-in works per session — each attendee has a separate QR code for each session, and the scanner and dashboard count arrivals session by session.
- Ticket classes can be limited to particular tracks, so an attendee's ticket only covers the sessions they're entitled to attend.

{{feature: events.event-report}}
## Reporting after the event
The Event Registration Report pulls everything together:

- A full attendee list for one event or several, grouped by booking, showing who booked whom — including each attendee's dietary requirements, allergies and accessibility needs.
- A financial summary covering revenue and how it was paid — including vouchers, training funds, discount codes, account payments and card payments.
- For events with Zoom sessions, online attendance is matched against registrations so you can see who joined, for how long, and who didn't show. (In-person arrivals are tracked live on the Event Check-In Dashboard.)
- Export the report to CSV for spreadsheets or your own analysis.

{{screenshot: The Event Registration Report}}
{{/feature}}

For cancellations, transfers and refunds, see "Managing, transferring and cancelling tickets".`,
  },

  // ------------------------------------------------------------ Your account
  {
    slug: 'your-profile-and-account',
    title: 'Your profile and account',
    category: 'Your account',
    summary: 'Update your details, photo, password, and see your groups, badges and stats.',
    status: 'published',
    sort_order: 20,
    required_feature: 'user.about-me',
    body: `Your About Me area is where you keep your details current and manage your account. Not every section below appears for everyone — it depends on your access — but here's the full picture.

## Your contact details
Open About Me and edit your first and last name, job title, and phone numbers, then save. Keeping these up to date helps your organisation reach you.

{{screenshot: The profile edit form}}

## Your profile photo
Upload a photo and crop it to fit. Photos can be up to 5MB.

{{feature: user.about-me.professional-biography}}
## Professional biography
Add a short professional summary (up to 500 words). This may appear alongside your profile in directories.
{{/feature}}

{{feature: user.about-me.show-in-directory}}
## Appearing in the member directory
Use the "Show in Directory" switch to control whether other members can find your profile. Turn it off to keep your profile private.
{{/feature}}

{{feature: user.about-me.change-password}}
## Changing your password
In the account security section, enter your current password and choose a new one. A strength meter and checklist help you pick a strong password. Forgotten your current password? Sign out and use "Forgot password" on the sign-in page instead.
{{/feature}}

{{feature: user.about-me.additional-info}}
## Additional information
Your organisation may ask for extra details through custom fields — for example areas of interest or country. Fill these in and save; they help your organisation tailor what you see.
{{/feature}}

{{feature: user.about-me.groups}}
## Your groups
See the groups you belong to and any role you hold within them.
{{/feature}}

{{feature: user.about-me.engagement-stats}}
## Engagement stats
See a summary of your activity, such as events attended, articles published and jobs posted.
{{/feature}}

{{feature: user.about-me.engagement-awards}}
## Engagement awards
As you take part, you can earn awards shown as badges on your profile.
{{/feature}}

{{feature: user.about-me.membership-badges}}
## Membership badges
Download your official membership badge (for example "Full Member") as an image to use in your email signature or online.
{{/feature}}

If a section you expect is missing, your role may not include it — your organisation's administrator can help.`,
  },
  {
    slug: 'communication-preferences',
    title: 'Managing your communication preferences',
    category: 'Your account',
    summary: 'Choose which emails you receive, or opt out of everything.',
    status: 'published',
    sort_order: 21,
    required_feature: 'user.about-me.communication-preferences',
    body: `You're in control of the emails your organisation sends you. Manage this from the communication preferences section of your About Me area.

## Choosing categories
Communications are grouped into categories — for example newsletters or event alerts — each with a short description. Turn a category on to receive those emails, or off to stop them.

{{screenshot: Communication preference toggles}}

## Opting out of everything
There's a master "Opt out of all communications" switch. Turning it on unsubscribes you from every category at once.

## Good to know
- Turning a category off stops those marketing-style emails, but essential account emails (such as password resets or booking confirmations) still reach you.
- Changes save right away and sync to your organisation's email tools in the background, so it can take a short while to take full effect.`,
  },

  // --------------------------------------------------------------- Resources
  {
    slug: 'finding-resources',
    title: 'Finding resources and documents',
    category: 'Resources',
    summary: 'Search, filter, sort and download the files your organisation shares.',
    status: 'published',
    sort_order: 30,
    required_feature: 'content.resources',
    body: `Your organisation shares documents, guides, links and videos in the Resources area. This guide shows you how to find what you need quickly.

## Browsing
Open Resources to see everything available to you, shown as a grid. Recently added items are marked with a "New" badge.

{{screenshot: The Resources library}}

## Filtering and searching
- Use the subcategories (such as Guides or Templates) to narrow the list.
- Use the search box to find a resource by name or keyword.

## Sorting
Sort the list by newest, oldest, or alphabetically (A–Z or Z–A) to find things the way you prefer.

## Saving your default view
Set the filters the way you like them and choose "Save as Default". Next time you visit Resources, your saved filters are applied automatically.

{{screenshot: Saving a default filter view}}

## Opening and sharing
Select any item to view or download it. Where sharing is enabled, you can copy a link or share to LinkedIn or X.

## Why you might not see everything
Access to some resources depends on your membership — for example, certain items are only available to particular groups, or to people who attended a linked event. If you can't see something you expect, check with your organisation.`,
  },
  {
    slug: 'creating-resources',
    title: 'How to create a resource',
    category: 'Resources',
    summary: 'Add downloads, videos and external links to your resource library, and control who can see them.',
    status: 'published',
    sort_order: 31,
    required_feature: 'content.resource-management',
    body: `Resources are the documents, videos and links your organisation shares in the Resources area. You create and manage them from the Resource Management admin page. This guide walks through creating a resource: choosing its type, adding the content, setting who can see it, and publishing it.

## Creating a new resource
To create a resource, open Resource Management and select "Add Resource". In the dialog:

1. Give the resource a title (required) and a short description. The description has a character limit (500 by default; your organisation may have changed this in Resource Settings).
2. Choose the resource type — Download, Video or External Link.
3. Select at least one category subcategory (required) so members can find it.
4. Add the content itself — a file, an embed code, or a link — as described in the sections below.
5. Set visibility, an image and any tags, then save.

{{screenshot: The Create New Resource dialog}}

## The three resource types
Every resource is one of three types, chosen from the Resource Type dropdown:

- Download — a file members can download, such as a PDF guide or a template. The file can come from your File Repository or be any direct file URL.
- Video — an embedded video, played on the resource card using an embed code from a platform like YouTube or Vimeo.
- External Link — a link to another website, with the option to open it in a new browser tab.

## Adding a downloadable file (Download resources)
For a Download resource, the "Download File" field accepts either:

- A direct file URL — paste a link to a file hosted anywhere.
- A file from your File Repository — choose "Select from Repository" and browse your organisation's uploaded files, including folders, with search and pagination.

{{screenshot: Selecting a download file from the repository}}

{{feature: content.files}}
## Uploading files for resources (File Repository)
Files used by Download resources are uploaded on the File Management page, which is your organisation's File Repository. Uploads are organised into folders and can be any common file type — documents (PDF, Word, Excel, PowerPoint, text, CSV), images (JPEG, PNG, GIF, WebP, SVG) or videos (MP4, WebM).

The maximum size per uploaded file is 25MB by default. This limit is configurable per organisation via the resource_max_upload_mb system setting, so yours may be higher or lower. Uploads also count toward your plan's overall storage allowance — if an upload is rejected for storage reasons, you'll see a prompt about your plan limit.
{{/feature}}

## Embedding a video (Video resources)
For a Video resource, paste the complete embed code from your video platform into the "Video Embed Code" field — for example, the full iframe embed snippet that YouTube or Vimeo provides under Share → Embed. Pasting only the watch-page link is not enough; use the embed code so the video plays correctly on the resource card.

{{screenshot: Pasting a video embed code}}

## Linking to an external page (External Link resources)
For an External Link resource, enter the destination URL in the "External Link URL" field. An "Open in new tab" switch (on by default) controls whether the link opens in a new browser tab or in the same tab.

## Public vs private: who can see a resource
The "Public Resource" switch controls the audience:

- Public (on) — the resource is visible to everyone, including non-members browsing your public Resources page.
- Private (off) — the resource is only available to signed-in members. Visitors who aren't signed in see it locked, with a prompt to sign in.

Private resources can be narrowed further:

- Role Access Control — tick the member roles allowed to access the resource. Leave every role unchecked to allow all member roles.
- Linked Events — restrict access to members who attended specific events. A member needs a confirmed booking for at least one linked event (or a specific session of a multi-session event) to see the resource.

{{screenshot: The visibility and role access settings}}

## Group resources
Resources that belong to a member group are managed from that group's own admin page, not from the tenant-wide Resource Management library. A group resource stays private to its group unless it is tagged with one of the subcategories the group has linked, in which case it also appears in the main Resources area.

## Card images and social sharing images
Two separate images can be set on a resource:

- Image URL — the thumbnail shown on the resource card in the Resources grid. Recommended for every resource, as cards with images are far more inviting. Paste an image URL or choose "Select from Repository" to pick an image from your File Repository; a preview appears once set.
- SEO / social sharing image — in the SEO settings section you can set an SEO title, search description, and a social sharing (Open Graph) image used when the resource link is shared on social media. These are optional overrides; leave them blank to fall back to the resource's own title and description.

{{screenshot: Setting a card image for a resource}}

## Categories, subcategories, tags and folders
Resources are organised in several ways:

- Subcategories (required) — every resource must have at least one subcategory ticked. Subcategories belong to categories managed in Category Management, and members use them to filter the Resources area.
- Tags — free-text labels for finer-grained search. As you type, matching tags already used on other resources are suggested so naming stays consistent.
- Folders — you can file resources into folders inside Resource Management. Folders are for your admin team's organisation only; members browsing Resources see the grid with category filters, not your folders.

## Choosing an author
A resource can optionally credit an author. The Author dropdown lists members and team members whose roles have been designated as author roles in Resource Settings; if no author roles are configured, the dropdown doesn't appear. The author's name is shown with the resource.

## Draft vs active, and release dates
Two controls decide when members see a resource:

- Status — the Active/Draft switch at the top of the dialog. Active resources are visible to users; Draft resources are hidden from members while you work on them.
- Release Date & Time — the date shown on the resource and used for newest-first ordering. Setting a future date flags the resource as scheduled in the admin screen; a past date shows when it was originally published. If you want a resource fully hidden until launch, keep it in Draft and switch it to Active when you're ready.

For how members browse and filter what you publish, see "Finding resources and documents".`,
  },

  // ---------------------------------------------------------------- Balances
  {
    slug: 'balances-training-fund-vouchers',
    title: 'Your balances: training fund, vouchers and tickets',
    category: 'Balances',
    summary: 'Check your training fund, training vouchers and pre-purchased programme tickets.',
    status: 'published',
    sort_order: 40,
    required_feature: 'commerce.balances',
    body: `The Balances area shows the credit you have available to spend on events and programmes. What appears depends on what your organisation offers and your access.

{{feature: commerce.balances.training-fund-card}}
## Training fund
Your training fund is credit your organisation can spend on eligible bookings.

- The card shows your current balance.
- It may also show a "pending" amount — funds you've added that are waiting on an invoice to be paid before they become spendable.
- You can apply the fund to a booking during the event payment step.

{{screenshot: The training fund balance card}}
{{/feature}}

{{feature: commerce.balances.buy-funds}}
## Buying more training funds
Where enabled, use "Buy Funds" to top up your training fund. Follow the prompts to choose an amount and pay; the balance updates once the payment is complete.
{{/feature}}

{{feature: commerce.balances.training-vouchers-card}}
## Training vouchers
Training vouchers are prepaid credit for eligible events.

{{feature: commerce.balances.vouchers-list}}
- See your active vouchers with their code, remaining value and expiry date.
- Expired vouchers are listed separately so you can tell them apart.
{{/feature}}

You can choose a voucher during booking, and any unused value stays on it for next time.

{{screenshot: The training vouchers list}}
{{/feature}}

{{feature: commerce.balances.program-tickets-card}}
## Programme tickets
If your organisation runs programmes with pre-purchased tickets, you'll see your remaining ticket balances here (for example a set of places on a course), ready to use when you book.
{{/feature}}

## Live updates
Balances update automatically. If you make a booking in another tab, you'll see your balance here change without needing to refresh.

{{feature: commerce.balances.availability}}
## Managing who can spend (organisation admins)
If you manage your organisation's fund and vouchers, you can set role restrictions to control which member roles are allowed to spend the training fund or use vouchers. Adjust these using the checkboxes in the availability settings.
{{/feature}}`,
  },

  // ------------------------------------------------------------- Fundraising
  {
    slug: 'browsing-fundraising-campaigns',
    title: 'Browsing fundraising campaigns',
    category: 'Fundraising',
    summary: 'See the fundraising campaigns running, how they\'re going, and how to get involved.',
    status: 'published',
    sort_order: 50,
    required_feature: null,
    body: `The Campaigns page lists the fundraising campaigns your organisation is running, so you can see what's happening, follow the progress, and get involved — by donating or by becoming a fundraiser yourself.

## Finding campaigns
Open the Campaigns page to see every live campaign. Each campaign card shows:

- The campaign name, cover image and a short description.
- A progress bar with the total raised so far against the goal (unless the organisation has chosen to hide the target).
- How many fundraisers are taking part and how many donations have been made.
- The end date, where the campaign has one.

{{screenshot: The fundraising campaigns page}}

## Getting involved
From a campaign card you can:

- Choose "Start Fundraising" to register as a fundraiser for that campaign — see "Becoming a fundraiser".
- Open a fundraiser's personal page (for example from a link they've shared) to read their story and donate — see "Making a donation and Gift Aid".

If a campaign shows "Registration Closed", it isn't currently accepting new fundraisers, and "Campaign Ended" means it has finished — though you can still see how it went.`,
  },
  {
    slug: 'becoming-a-fundraiser',
    title: 'Becoming a fundraiser',
    category: 'Fundraising',
    summary: 'Register for a campaign as an individual, a team or an organisation, and sign in to your fundraiser dashboard.',
    status: 'published',
    sort_order: 51,
    required_feature: null,
    body: `When a campaign has registration open, anyone can sign up to fundraise for it — you don't need an existing portal account. This article covers registering and signing back in later.

## Registering for a campaign
Choose "Start Fundraising" on a campaign to begin. The registration is a short, guided set of steps:

1. Choose how you're taking part. Depending on the campaign you can register as an individual or as a team (some campaigns offer both).
2. If the campaign supports organisation sign-up, search for your organisation by name — or enter its details (address, city, postcode and country) if it isn't listed yet.
3. Enter your own details: first name, last name and email address. You can also set a personal fundraising goal if you'd like one shown on your page.
4. For a team, give the team a name and add your team members with their names and email addresses. Campaigns may limit how many people a team can have.

{{screenshot: The fundraiser registration steps}}

## What happens next
Once you've registered:

- You (and each team member) get a personal fundraising page with its own unique donation link to share with supporters.
- The campaign's welcome message confirms you're in and explains any next steps the organisation wants you to take.

## Signing in to your dashboard
Fundraisers sign in with a secure email link — there's no password to remember.

- Open the fundraiser sign-in page and enter the email address you registered with.
- You'll receive an email with a sign-in link. Open it and you're taken straight to your fundraiser dashboard.
- If the email doesn't arrive, check your spam folder and make sure you used the same address you registered with.

{{screenshot: The fundraiser sign-in page}}

See "Your fundraiser dashboard" for everything you can do once you're signed in.`,
  },
  {
    slug: 'your-fundraiser-dashboard',
    title: 'Your fundraiser dashboard',
    category: 'Fundraising',
    summary: 'Share your donation link, personalise your page, post updates, and follow the leaderboard.',
    status: 'published',
    sort_order: 52,
    required_feature: null,
    body: `Your fundraiser dashboard is home base for your campaign — it's where you track what you've raised, personalise your page, and keep supporters engaged.

## Tracking your progress
The dashboard shows your total raised, your progress toward your goal, and your recent donations as they come in — including any messages donors have left for you.

{{screenshot: The fundraiser dashboard overview}}

## Sharing your donation link
Every fundraiser has a unique donation link.

- Use "Copy Link" to copy it, then share it by email, message or social media — anyone with the link can donate.
- If you're part of a team, your team also has a shared page supporters can give to.

## Personalising your page
Make your page yours so supporters know why you're fundraising:

- Add a personal message telling your story.
- Upload a profile photo or page image.
- Set or adjust your personal fundraising goal.

{{screenshot: Editing your fundraiser page}}

## Posting updates
Keep supporters in the loop with updates on your page.

- Use "Post an Update" to write a short update, and attach photos if you like.
- You can edit or delete your own updates later.
- Updates appear on your public fundraising page, so supporters who visit see your latest news.

{{screenshot: Posting a campaign update}}

## Leaderboard and achievements
When several fundraisers are taking part, the dashboard shows a bit of friendly competition:

- Your rank in the campaign and the fundraisers nearest to you on the leaderboard.
- Achievement badges you earn as donations arrive and milestones are reached.

## Messages from well-wishers
Supporters can leave messages of encouragement — with or without a donation. You'll see them on your dashboard, so nothing kind goes unnoticed.`,
  },
  {
    slug: 'making-a-donation-and-gift-aid',
    title: 'Making a donation and Gift Aid',
    category: 'Fundraising',
    summary: 'Donate to a fundraiser, leave a message of support, and add Gift Aid if you\'re a UK taxpayer.',
    status: 'published',
    sort_order: 53,
    required_feature: null,
    body: `Anyone with a fundraiser's donation link can give — you don't need an account. This article walks through the donation page.

## Choosing an amount
Open the fundraiser's page from their shared link. You'll see their story, their progress, and the donation form.

- Pick one of the suggested amounts, or enter your own.
- The minimum donation is 1.00 in the campaign's currency.

{{screenshot: Choosing a donation amount}}

## Your details and message
- Enter your name. Adding your email is optional but recommended — it's where your payment receipt goes.
- You can leave a message of support that appears with your donation.
- Prefer to stay private? Tick the anonymous option and your name won't be shown publicly.
- A separate consent box asks whether the organisation may contact you about future campaigns — entirely your choice.

## Adding Gift Aid (UK taxpayers)
If you're a UK taxpayer, Gift Aid lets the organisation claim an extra 25% on top of your donation from HMRC — at no cost to you.

- Tick the Gift Aid box and read the taxpayer declaration.
- Enter your home address (address line, city and postcode). HMRC requires this to process the claim.
- Only add Gift Aid if you pay enough UK Income or Capital Gains Tax to cover the amount reclaimed on your donations.

{{screenshot: The Gift Aid declaration}}

## Paying
Payment is by card, handled securely — card details are never stored by the organisation.

- Enter your card details and confirm. If your bank asks you to verify the payment, follow its prompts and you'll be returned automatically.
- Once the payment succeeds you'll see a confirmation, and your donation appears on the fundraiser's page (as "Anonymous" if you chose that).

## Just want to send encouragement?
You can also leave a message of support without donating — look for the well-wisher option on the fundraiser's page. Your message goes to the fundraiser to cheer them on.`,
  },
  {
    slug: 'managing-fundraising-campaigns',
    title: 'Managing fundraising campaigns',
    category: 'Fundraising',
    summary: 'Create and run campaigns, manage fundraisers and teams, and track donations and Gift Aid.',
    status: 'published',
    sort_order: 54,
    required_feature: 'fundraising.fundraising-management',
    body: `The Fundraising area is where administrators create campaigns, look after fundraisers, and keep track of every donation. This article covers the full admin journey.

## The fundraising overview
Open Fundraising to see all your campaigns at a glance — total raised across everything, total donations, how many campaigns are active, and the average donation. Each campaign card shows its own progress, fundraiser count and donation count.

{{screenshot: The fundraising overview}}

## Creating a campaign
Choose "New Campaign" and fill in the details:

- Name and description, plus a cover image to bring the page to life.
- A goal amount and currency. You can optionally hide the target from the public page if you'd rather not show it.
- Start and end dates, where the campaign has a fixed window.
- The campaign type — individual fundraisers, teams, or both. For team campaigns you can set a maximum team size (or leave it unlimited).
- Whether donors may give anonymously.

A campaign starts as a draft, so you can get everything right before it goes live. Set the status to Active when you're ready to accept donations; Completed and Cancelled close it down.

{{screenshot: Creating a new campaign}}

## Opening self-registration
Turn on registration to let people sign themselves up as fundraisers:

- Copy the campaign's registration link and share it — anyone with the link can register while registration is open.
- Add a welcome message shown to fundraisers after they register.
- Optionally have the platform create a member record (with a role you choose) and organisation record automatically for each new fundraiser, so they're part of your database from day one.
- You can also add terms and conditions and a privacy statement that registrants see.

## Managing fundraisers and teams
From a campaign you can see every fundraiser, grouped into their teams where applicable, each with the amount they've raised, their donation count and any Gift Aid donations.

- Add fundraisers yourself, or remove someone who's no longer taking part.
- Copy any fundraiser's personal donation link, or open their public page to see it as supporters do.

{{screenshot: A campaign's fundraiser list}}

## Tracking donations and Gift Aid
The campaign view brings the money together:

- Totals for the amount raised, donation count, unique donors and average donation.
- A Gift Aid summary showing how many donations carry a declaration and the extra 25% you can claim — donor addresses are captured with each declaration for your HMRC claim.
- The full donation list, including pending payments, donor messages and anonymous gifts.
- Download the donations as a CSV for your records or your Gift Aid claim.

{{screenshot: The campaign donations view}}

## Campaign updates
Fundraisers can post updates to their pages; you can review and manage updates across the whole campaign from the admin view, keeping everything on-message.

## Sharing the campaign
Campaign pages support SEO settings — a title, description and social-sharing image — so the campaign looks its best when links are shared. See "Browsing fundraising campaigns" for what supporters see.`,
  },
];

async function run() {
  console.log(`Help Center seed — ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const slugs = ARTICLES.map((a) => a.slug);
  const { data: existing, error: fetchErr } = await supabase
    .from('help_article')
    .select('id, slug')
    .in('slug', slugs);
  if (fetchErr) throw fetchErr;

  const bySlug = new Map((existing || []).map((r) => [r.slug, r]));

  for (const article of ARTICLES) {
    const found = bySlug.get(article.slug);
    if (found) {
      console.log(`  update: ${article.slug}`);
      if (APPLY) {
        const { error } = await supabase
          .from('help_article')
          .update({ ...article, updated_at: new Date().toISOString() })
          .eq('id', found.id);
        if (error) throw error;
      }
    } else {
      console.log(`  insert: ${article.slug}`);
      if (APPLY) {
        const { error } = await supabase.from('help_article').insert(article);
        if (error) throw error;
      }
    }
  }

  console.log(`\nDone. ${APPLY ? 'Changes written.' : 'Re-run with --apply to write.'}`);
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
