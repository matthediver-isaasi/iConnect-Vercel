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
import { pathToFileURL } from 'node:url';

const APPLY = process.argv.includes('--apply');

export const ARTICLES = [
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
    slug: 'group-tickets-and-group-bookings',
    title: 'Group tickets: booking for a group and managing your participants',
    category: 'Events',
    summary: 'Buy a block of places with one group ticket, then add or remove your participants using your group management link.',
    status: 'published',
    sort_order: 17,
    required_feature: 'events.browse-events',
    body: `Some events offer group tickets — a single ticket that covers a block of places, for example "Team Ticket (covers 10 participants)". You buy the group ticket once, and add the people attending afterwards using a personal management link. This article covers booking a group ticket, managing your participant list, and (for event organisers) how to set group tickets up.

## Spotting a group ticket
On the event page, a group ticket shows a "Group" badge with the number of places it covers — for example "Group (10)" — along with a note like "Covers 10 participants — manage your group after booking". The price shown is for the whole block of places, not per person.

{{screenshot: An event page showing a group ticket with its Group badge}}

## Booking a group ticket
Book a group ticket the same way as any other ticket: select it, apply any discount code, voucher or training fund, and pay by card or purchase order (see "Paying for your booking"). You don't need to know who's attending yet — you're buying the places now and naming the people later.

Once your booking is confirmed:

- Your confirmation screen shows a "Manage Your Group" link.
- You also receive an email with your booking reference, the number of places in your group, and the same "Manage Your Group" button.

{{screenshot: The group booking confirmation email with the Manage Your Group button}}

Keep that email — the link is your key to managing the group, and you can return to it as often as you need. Anyone with the link can edit the group, so only share it with someone you trust to manage the list for you.

## Managing your group
Opening your management link takes you to your group booking page. You don't need to sign in — the link itself identifies your booking. The page shows:

- The event, date and location, and your booking reference.
- How many places are filled — for example "3 / 10 participants" — with a progress bar and how many spots remain.
- A countdown to the cut-off date, if the organiser set one.

{{screenshot: The group booking management page with the participant list}}

### Adding participants
Use the "Add Participant" form: enter the person's email address (required) and optionally their first and last name, then choose "Add to Group". Each email address can only be added once, and you can't add more people than your group size allows — once every place is filled you'll see "All spots have been filled."

### Removing participants
Made a mistake, or someone can't attend? Remove them from the participant list and their place opens up again for someone else.

## The cut-off date
Organisers can set a cut-off date and time for group changes. Until then, you can add and remove participants freely; the page shows how long you have left, for example "2d 5h remaining".

Once the cut-off passes, the group booking is locked: the page shows "This group booking is now closed" and no further additions or removals are possible. If you need a change after the cut-off, contact the event organiser directly.

{{screenshot: A locked group booking after the cut-off date}}

{{feature: events.browse-events.create}}
## Setting up group tickets (organisers)
When creating or editing an event, any ticket class can be made a group ticket:

1. In the ticket class settings, switch on "Group Ticket".
2. Set the Group Size — the maximum number of participants the ticket covers. It must be at least 2.
3. Optionally set a Cut-off Date/Time. After this moment the booker can no longer add or remove participants.

{{screenshot: The Group Ticket settings on a ticket class}}

Price the ticket for the whole block: a group ticket is one purchase at one price, however many of the places end up filled. When someone buys it, the system creates their group booking automatically and emails them their "Manage Your Group" link — there's nothing for you to send manually.

### Group tickets on multi-session (complex) events
Ticket classes on multi-session events have the same Group Ticket option, and marked tickets show the "Group" badge with their size on the event page. Bookings on multi-session events work differently, though: the booker names each attendee at checkout, adding them to the ticket's cart before paying, rather than filling places afterwards through a management link. Use a group ticket when you want one buyer to pay once and fill in names later; use the normal multi-attendee booking when attendee details should be captured at the point of booking.

### Seeing who's in a group
Group bookings appear in the Event Registration Report alongside other bookings, so you can see the booker and the participants they've added when planning the event.
{{/feature}}`,
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
  {
    slug: 'event-sponsors',
    title: 'Event sponsors: creating sponsors and showing them on events',
    category: 'Events',
    summary: 'Set up sponsors and categories, attach them to your events, add per-agenda-item sponsors on training events, and control where the sponsors card appears.',
    status: 'published',
    sort_order: 18,
    required_feature: 'events.sponsors',
    body: `Sponsors let you recognise the organisations supporting your events. You set sponsors up once in Sponsor Management, attach them to any event, and they appear automatically on the event's public page. This article covers the whole lifecycle: creating sponsors, organising them into categories, assigning them to standard and multi-session events, adding per-agenda-item sponsors on training events, how the public sponsors card renders, and choosing where it sits on the page.

## Creating and editing sponsors
Open Sponsor Management from the navigation. The Sponsors tab lists every sponsor you've set up, each shown with its logo, category, description and website link.

To add a sponsor, choose "Add Sponsor" and fill in the details:

- **Name** (required) — how the sponsor is shown everywhere.
- **Logo** — upload an image file (any common format); it appears on the event page's sponsors card. You can remove or replace it at any time.
- **Website URL** — if set, the sponsor's tile on the event page links to this address, opening in a new tab.
- **Description** — a short line shown under the sponsor's name on the event page.
- **Category** — pick one of your sponsor categories, or leave it as "No Category". The category dropdown only appears once you've created at least one category.

{{screenshot: The Add Sponsor dialog in Sponsor Management}}

Use the pencil icon on a sponsor's card to edit it later — changes appear immediately on every event the sponsor is attached to. Use the bin icon to delete a sponsor; this permanently removes it and detaches it from all events, so double-check before confirming.

## Organising sponsors into categories
Categories group sponsors into tiers — for example Gold, Silver and Bronze. Switch to the Categories tab in Sponsor Management to manage them.

- Choose "Add Category" and give it a name (e.g. Gold) and a Display Order number. Lower numbers come first.
- The display order controls how the tiers appear both in the sponsor picker when editing an event and on the public event page.
- Each category card shows how many sponsors are currently in it.
- Deleting a category doesn't delete its sponsors — they simply become uncategorised.

{{screenshot: The Categories tab with Gold, Silver and Bronze tiers}}

On the public event page, sponsors are shown grouped under their category headings in display order. Sponsors without a category appear at the end under "Other Sponsors" (or with no heading at all if none of the event's sponsors have a category).

{{feature: events.browse-events.create}}
## Adding sponsors to a standard or multi-session event
Both standard (single-session) events and multi-session events have a Sponsors section in their create and edit screens.

1. In the event editor, find the **Sponsors** field and choose "Click to select sponsors...".
2. A picker lists every sponsor grouped by category. Tick the ones you want on this event and confirm.
3. Each selected sponsor appears as a row below the field. Next to each name you'll see an optional **"What are they sponsoring?"** text box — use it to record a per-event detail such as "Lunch", "Keynote", or "Evening reception". You can leave it blank and it won't show publicly.
4. Save the event as normal — the sponsor assignments are saved with it.

{{screenshot: Selecting sponsors in the event editor}}

To remove a sponsor from an event, click the X on its row (or untick it in the picker) and save. This only detaches the sponsor from that event; the sponsor record itself is unchanged and it remains on any other events it's attached to.

If the Sponsors field says no sponsors are available yet, follow its "Add sponsors" link to Sponsor Management and create some first.

## Per-agenda-item sponsors on training events
Training events (events with a multi-day agenda) support an additional level of sponsorship: you can attach sponsors to individual agenda items as well as — or instead of — the event as a whole. This is useful when different organisations are sponsoring different days or sessions.

Each agenda item in the training event editor has its own **Sponsors** field at the bottom, identical to the event-level sponsor picker. Select the relevant sponsors for that item and save. There's no "What are they sponsoring?" field at item level; the item itself (its date, type and description) provides the context.

{{screenshot: The per-agenda-item Sponsors field in the training event editor}}

A sponsor can be attached at the event level, the agenda-item level, or both — the choices are independent. Event-level sponsors appear in the main Sponsors card at the bottom of the page; agenda-item sponsors appear inline next to the agenda item they're linked to (see below).
{{/feature}}

## How sponsors appear on the event page

### The Sponsors card
When an event has event-level sponsors, its public page shows a "Sponsors" card automatically — there's nothing extra to switch on.

- Sponsors are grouped by category heading, in your category display order. Uncategorised sponsors appear last, under "Other Sponsors" (or with no heading if none of the event's sponsors have a category).
- Within each category, sponsors are listed alphabetically.
- Each sponsor tile shows the logo (where one has been uploaded), the sponsor's name, and its short description.
- If the sponsor has a website URL, its tile is a clickable link that opens the site in a new tab.
- Events with no event-level sponsors simply don't show the card.

{{screenshot: The Sponsors card on a public event page}}

### Per-agenda-item sponsors on training event pages
Sponsors attached to individual agenda items appear inline on each agenda item on the training event's detail page — separate from the main Sponsors card.

Each inline sponsor shows a small logo thumbnail (if one is uploaded) and the sponsor's name. If the sponsor has a website URL, the name is a clickable link opening in a new tab. These inline sponsors appear after any speakers listed for the same item.

An agenda item with no item-level sponsors shows nothing in that position — the layout is the same as for items without sponsors.

{{screenshot: An agenda item showing its inline sponsors on the event page}}

{{feature: events.event-settings}}
## Choosing where the sponsors card appears
By default the event-level sponsors card sits after the event's description and documents. If you'd rather give sponsors more prominence, you can move it higher.

- Open **Event Settings** and find **Sponsor Card Placement**.
- Choose between "After description & documents (default)" and "Below date section, above description", then save.
- The setting applies to all event pages — both standard and session-based events.

{{screenshot: The Sponsor Card Placement setting in Event Settings}}
{{/feature}}`,
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
Download your official membership badge (for example "Full Member") as an image to use in your email signature or online. For step-by-step guidance on adding it to an email signature, sharing on LinkedIn, or adding it to your LinkedIn credentials, see [Using and sharing your membership badge](/help/sharing-your-membership-badge).
{{/feature}}

If a section you expect is missing, your role may not include it — your organisation's administrator can help.`,
  },
  {
    slug: 'sharing-your-membership-badge',
    title: 'Using and sharing your membership badge',
    category: 'Your account',
    summary: 'Download your badge and add it to your email signature, share it on LinkedIn, or add it to your LinkedIn credentials.',
    status: 'published',
    sort_order: 22,
    required_feature: 'user.about-me.membership-badges',
    body: `Your membership badge is an official image that shows your membership status. You can download it from your About Me page and use it in several places to make your membership visible to others.

## Downloading your badge
1. Open **About Me** from the navigation and scroll to the **Membership Badges** section.
2. Find the badge you want — for example "Full Member" — and choose **Download Badge**.
3. Your browser saves the badge as an image file, ready to use.

{{screenshot: The Membership Badges section on the About Me page}}

## Adding your badge to an email signature

### Outlook (desktop)
1. Open Outlook and go to **File → Options → Mail → Signatures**.
2. Select the signature you want to edit (or create a new one).
3. Click in the signature editor where you'd like the badge to appear.
4. Choose **Insert → Picture**, browse to your downloaded badge file, and insert it.
5. Right-click the image and choose **Format Picture → Size** to resize it — around 80–100px height works well in most signatures.
6. Save the signature.

### Outlook (web — outlook.com or Microsoft 365)
1. Open the Outlook web app and go to **Settings → View all Outlook settings → Compose and reply → Email signature**.
2. Click in the signature editor where you want the badge.
3. Choose the **Insert pictures inline** icon in the editor toolbar, then upload your badge file.
4. Click the inserted image and use the resize handles to make it an appropriate size.
5. Save.

### Other email clients
Most email clients let you insert an image into your signature. Look for an "Insert image" or "Attach picture" option in your signature editor and follow the same steps — upload your downloaded badge file and resize as needed.

{{screenshot: A badge displayed in an email signature}}

## Sharing your badge on LinkedIn

Sharing your badge as a post is a great way to let your network know about your membership.

1. Go to LinkedIn and choose **Start a post**.
2. Select the **Photo** icon and upload your downloaded badge image.
3. Write a short description — for example: "Proud to be a [member type] of [your organisation]. Looking forward to the year ahead."
4. Tag your organisation by typing **@** followed by their name and selecting them from the suggestions.
5. Optionally add a link to your organisation's website or your profile page.
6. Post when you're happy with it.

{{screenshot: A LinkedIn post with a membership badge image}}

## Adding your badge to your LinkedIn credentials

LinkedIn's Licences & Certifications section lets you permanently display your membership on your professional profile.

1. Go to your LinkedIn profile and choose **Add profile section → Recommended → Add licenses & certifications**.
2. Fill in the fields:
   - **Name** — your membership type, for example "Full Member" or "Associate Member".
   - **Issuing organisation** — type your organisation's name and select them from the suggestions. If they don't appear, enter the name manually.
   - **Issue date** — the month and year your membership began.
   - **Expiration date** — if your membership has an expiry, enter it; otherwise leave this blank or tick "This credential does not expire".
   - **Credential ID** — leave blank unless your organisation gives you one.
   - **Credential URL** — link to the portal or your organisation's membership page (optional but helpful).
3. Save. Your membership now appears in the Licences & Certifications section of your profile.

{{screenshot: The Add License & Certification form on LinkedIn}}

LinkedIn does not currently support uploading a custom badge image directly to a certification entry, but adding the issuing organisation and any credential URL makes the entry clear and verifiable.`,
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

  // --------------------------------------------------------------- Community
  {
    slug: 'member-and-organisation-directories',
    title: 'Finding people: the member and organisation directories',
    category: 'Community',
    summary: 'Search for fellow members and member organisations, view profiles, and get in touch.',
    status: 'published',
    sort_order: 60,
    required_feature: 'membership.member-directory',
    body: `The directories help you find and connect with other members and their organisations. What you can see is controlled by each member's own privacy choice and your organisation's directory settings, so the details on show vary.

## Searching the member directory
Open the Member Directory to browse everyone who has chosen to appear.

- Search by name, email, job title or organisation.
- Filter by organisation, and by any custom filters your organisation has set up (for example region or areas of interest).
- Sort the list by name, organisation, or activity such as events attended or articles published.

{{screenshot: The member directory with search and filters}}

## Viewing a profile and getting in touch
Select a member's card to open their profile. Depending on your organisation's settings you may see their photo, job title, organisation, biography, awards and activity stats.

- Use the email button to start a message in your mail app, or copy their address to the clipboard.
- Where a member has added their LinkedIn profile, you can open it from here too.

{{screenshot: A member profile with contact options}}

## Controlling whether you appear
You decide whether other members can find you. The "Show in Directory" switch in your About Me area controls whether your profile is listed — turn it off at any time to be removed from the directory. See "Your profile and account" for more.

{{feature: membership.organisation-directory}}
## The organisation directory
The Organisation Directory lists the organisations in your community.

- Search by name, and filter by any custom organisation fields your community uses.
- Each card can show the organisation's logo, name and member count.
- Open an organisation to see its details and a Contacts section listing the people to speak to — with buttons to email them or copy their address.

{{screenshot: The organisation directory}}
{{/feature}}

If someone you expect to find isn't listed, they may have chosen not to appear, or the directory settings may exclude their role — your organisation's administrator can advise.`,
  },
  {
    slug: 'member-groups-joining-and-taking-part',
    title: 'Member groups: joining and taking part',
    category: 'Community',
    summary: 'Browse groups, join or express interest, and use group discussions, resources, events and projects.',
    status: 'published',
    sort_order: 61,
    required_feature: 'membership.member-group-access',
    body: `Member groups are communities within your organisation — committees, special interest groups, regional networks and more. This article covers finding a group, joining, and what you can do inside one.

## Browsing groups
Open the Member Groups area to see the groups open to you. Each card shows the group's name and description. If you're not signed in, group content is locked with a prompt to sign in first.

{{screenshot: The member groups listing}}

## Joining a group
How you join depends on the group:

- Instant join — groups that allow self-join have a "Join Group" button. If the group has terms of reference, you'll be asked to agree to them before you're added.
- Vacancies and expressions of interest — some groups advertise specific open positions. You can express interest or complete an application form for the role, and the group's organisers will follow up.
- Closed groups — a group may show that registrations are closed. Contact your organisation if you believe you should have access.

{{screenshot: Joining a group with terms of reference}}

## Inside a group
A group's page brings together everything the group shares:

- Discussions — a message board for the group. Start threads, reply, and react to posts.
- Resources — documents and links owned by the group, alongside any relevant resources from the main library.
- Events — upcoming events run by or for the group.
- Members — a searchable list of who's in the group, with their group role (for example Member or Chair).
- Vacancies — open positions you can apply for.

{{screenshot: A group page with its discussions and members}}

## Group roles and terms
You hold a role within each group you belong to. Some roles run for a fixed term — you can see your role (and any term details) on the group page and in the "Your groups" section of About Me.

{{feature: membership.member-group-projects}}
## Group projects
Groups can run shared project boards — kanban-style boards for tracking the group's work. Open Group Projects to see boards for the groups you belong to.
{{/feature}}

{{feature: membership.member-group-events}}
## Group events
The Group Events area gathers upcoming events across all your groups in one place, so you don't miss anything.
{{/feature}}`,
  },
  {
    slug: 'forum-discussions',
    title: 'Using the forum: threads, replies and reactions',
    category: 'Community',
    summary: 'Browse discussion categories, start threads, reply with images and mentions, and report problems.',
    status: 'published',
    sort_order: 62,
    required_feature: 'forum.browse',
    body: `The forum is where members discuss topics together. This article covers reading, posting and keeping discussions healthy.

## Browsing categories
Open the Forum to see the discussion categories available to you. Each category shows how many threads it holds and when it was last active. Which categories you can see depends on your membership and groups — some categories belong to specific member groups.

{{screenshot: The forum categories}}

## Reading and starting threads
Open a category to see its threads, then open a thread to read the conversation.

{{feature: forum.threads}}
To start a new discussion, choose "New Thread", give it a title, and write your opening post. You can attach images to illustrate your point. Posts may be automatically checked before they appear, to keep discussions constructive.

{{screenshot: Starting a new thread}}

## Replying and reacting
- Reply at the bottom of a thread, or reply directly to a specific post to keep sub-conversations together.
- Mention another member with @ and their name to bring them into the conversation.
- React to posts (for example a thumbs up) to show agreement without adding a reply.

Threads update live — new replies and reactions appear without refreshing the page.
{{/feature}}

## Reporting a post
If you see something that shouldn't be there, use the report option on the post and describe the problem. A moderator will review it.

## Pinned and locked threads
Moderators can pin important threads to the top of a category, and lock threads that have run their course — a locked thread stays readable but no longer accepts replies.`,
  },

  // ----------------------------------------------------------- News and jobs
  {
    slug: 'news-and-articles',
    title: 'Reading and writing articles',
    category: 'News & Articles',
    summary: 'Browse news and articles, react and comment, and publish your own writing.',
    status: 'published',
    sort_order: 65,
    required_feature: 'content.articles',
    body: `The Articles area is where your organisation and its members publish news, insight and stories. This article covers finding things to read — and publishing your own.

## Browsing articles
Open Articles to see everything published.

- Use the search box to find articles by keyword.
- Filter by category to focus on a topic.
- Sort by newest, oldest, or title — and, when signed in, by most viewed or most liked.

{{screenshot: The articles listing with filters}}

## Reading an article
Open any article to read it in full. Alongside the content you'll see the author, their organisation, and any co-authors.

- Where reactions are enabled, use the thumbs to show what you thought.
- Where comments are enabled, join the conversation at the bottom of the article.

{{screenshot: An article page with reactions and comments}}

{{feature: content.my-articles}}
## Writing your own articles
If your access includes writing, you'll see a "New Article" button in the Articles area.

- Write and format your article in the editor, add images, and choose a category.
- Save as a draft and come back to it any time — use the "My Articles" view to see your drafts and published pieces together.
- When it's ready, submit or publish it following your organisation's process.

{{screenshot: The article editor}}
{{/feature}}`,
  },
  {
    slug: 'jobs-and-volunteering',
    title: 'The job board and volunteer board',
    category: 'Jobs',
    summary: 'Browse and apply for jobs, post your own vacancy, and find volunteer roles.',
    status: 'published',
    sort_order: 66,
    required_feature: 'jobs.job-board',
    body: `The Job Board lists opportunities shared across your community, and the Volunteer Board gathers volunteer roles from member groups. This article covers browsing, applying, and posting.

## Browsing the job board
Open the Job Board to see active postings. Featured jobs appear first.

- Search by keyword, and filter by location, job type (for example full-time or part-time) and flexible hours.
- Sort by posted date or closing date so you don't miss a deadline.

{{screenshot: The job board with filters}}

## Viewing and applying
Open a posting to see the full details — the role, the organisation, salary information where given, and the closing date. How you apply depends on the posting: some give an email address, others link to an application page on the employer's website.

{{screenshot: A job posting's details}}

{{feature: jobs.post-job}}
## Posting a job
Use "Post a Job" to advertise a vacancy.

- Fill in the role details, location, how to apply, and a closing date.
- Depending on your membership, posting may be free or may require a fee paid by card before the posting goes live.
- Where your access allows, you can post on behalf of another organisation.

{{screenshot: The post a job form}}
{{/feature}}

{{feature: jobs.my-postings}}
## Managing your postings
My Job Postings lists everything you've posted, so you can check status, edit details, or close a vacancy once it's filled.
{{/feature}}

{{feature: jobs.volunteer-board}}
## The volunteer board
The Volunteer Board shows volunteer positions across your community's member groups.

- Filter by group, and hide closed positions to focus on what's open.
- Use "Express Interest" on a role to put yourself forward — you may be asked to complete a short form.

{{screenshot: The volunteer board}}
{{/feature}}`,
  },

  // ------------------------------------------------------- Forms & your org
  {
    slug: 'filling-in-forms',
    title: 'Filling in forms and saving drafts',
    category: 'Getting started',
    summary: 'Complete forms your organisation shares, save your progress, and know your submission went through.',
    status: 'published',
    sort_order: 3,
    required_feature: null,
    body: `Your organisation uses forms for all sorts of things — applications, surveys, registrations and more. Forms are shared with you as links, and many can be completed without signing in.

## Completing a form
Open the form link you've been given and work through the questions. Longer forms are split into pages — use the navigation to move between them. Required questions are marked, and you'll be prompted if anything needed is missing.

{{screenshot: A form with multiple pages}}

## Saving a draft and returning later
On longer forms you can save your progress part-way through.

- Choose the save option and your answers are stored as a draft.
- You'll get a personal resume link — keep it safe, as it's how you return to your draft. Opening the link restores everything you'd entered.

{{screenshot: Saving a form draft}}

## Submitting
When you submit, you'll see a confirmation on screen (or be taken to a follow-up page if your organisation has set one up). If you don't see a confirmation, your submission hasn't gone through — check for any highlighted questions and try again.

## If something goes wrong
- Don't press submit twice — if the page is taking a moment, give it time to confirm.
- If a form tells you it has closed or you don't have access, contact your organisation.`,
  },
  {
    slug: 'managing-your-organisation-profile',
    title: 'Managing your organisation\'s profile',
    category: 'Your account',
    summary: 'Keep your organisation\'s details, logo and custom information up to date.',
    status: 'published',
    sort_order: 22,
    required_feature: 'organisation.my-organisation',
    body: `If you look after your organisation's record, the My Organisation area is where you keep it current. What's shown here can appear in the organisation directory and on things like invoices, so it's worth keeping accurate.

## Updating your details
Open My Organisation to edit:

- Phone number, website and address.
- The invoicing email — where invoices for your organisation are sent.
- A description of what your organisation does.

Save when you're done; changes take effect straight away.

{{screenshot: The My Organisation details form}}

## Your logo
Upload your organisation's logo so it appears wherever your organisation is shown, including the organisation directory. You can replace it at any time.

## Additional information
Your community may ask organisations for extra details through custom fields — for example sector or size. Fill these in and save; some may be used as directory filters so others can find you.

## Your members
The page lists the members linked to your organisation, so you can check who's connected. If someone is missing or shouldn't be there, contact your organisation's administrator.

## Awards and verified domains
Where used, you'll also see any awards your organisation holds and the email domains verified as belonging to it (used to recognise your colleagues automatically).`,
  },

  {
    slug: 'organisation-onboarding-for-administrators',
    title: 'Organisation onboarding: an administrator\'s guide',
    category: 'CRM',
    summary: 'Review an organisation application, check fees and activation, and verify the configured follow-up actions.',
    status: 'published',
    sort_order: 30,
    required_feature: 'crm.organisations',
    body: `Use this guide to coordinate a typical organisation onboarding journey from first enquiry to an active portal account. Your tenant may use different form names, application statuses, membership periods, directory names and workflow actions. Treat the labels below as neutral descriptions and follow the names configured in your portal.

## Before you start

Confirm that you can access **CRM > Organisations**. Depending on your responsibilities, you may also need access to Form Submissions, membership fee controls and directory settings.

Before processing a live application, check with your portal owner:

- Which enquiry and application forms are used.
- Which application and organisation statuses your team uses, and what each status is intended to trigger.
- The applicable membership period, fee structure, tax treatment and approval rules.
- Whether applicants can pay online, provide a purchase order, or use another configured method.
- Which emails, invoices, account invitations and directory changes are automated.

## 1. Review the initial enquiry

{{feature: forms.submissions}}
Open **Form Submissions**, select the relevant enquiry form and review the submission. Form names and statuses are configurable, so use your team's documented form and handling status.

You can reply to the submitter from the submission, update answers where permitted, and change the submission status to show that it has been handled or is not relevant. See [Forms: finding, filtering and exporting submissions](/help/forms-managing-submissions) for the full submission workflow.

{{screenshot: An organisation enquiry opened in Form Submissions}}
{{/feature}}

If you cannot access Form Submissions, ask a colleague with the appropriate role to review the enquiry and pass on the outcome.

**Decision:** If the enquiry should not proceed, record the outcome using your tenant's process and send any required response. If it should proceed, send the applicant the configured application form or follow the next workflow step.

## 2. Process the full application

{{feature: forms.submissions}}
When the fuller application arrives, review it in **Form Submissions**. Check required evidence and answers before marking it with the appropriate configured status.

Forms can be configured to create or update CRM records and send messages when submitted, but those actions are not automatic for every form. Check the submission's processing notes and the organisation record rather than assuming that an update or email occurred. Use **re-run** only when you intend to repeat the configured processing and resend eligible emails.

{{screenshot: A full organisation application with processing notes and status}}
{{/feature}}

## 3. Verify the organisation record

Open **CRM > Organisations**, find the applicant and check the organisation's details against the accepted application. Verify the main contact, invoicing contact, address, website, organisation type and any tenant-specific fields used for fees or directory filters.

Application statuses are tenant-defined. Changing one may prepare a communication or run a workflow in some tenants, while in others it is only a tracking value. Review any on-screen action before confirming it, then check the activity or workflow result.

{{screenshot: The organisation CRM record with application details}}

**Expected outcome:** The CRM record contains the approved information and the correct contact is linked to the organisation. If the form did not update the record, check its processing notes and update the CRM record using your normal correction process.

## 4. Review the membership fee

{{feature: commerce.membership}}
Open the organisation's **Membership** tab. Select the applicable membership period and:

1. Check the fee structure or tier, the input value used to calculate it, any pro-rata treatment, discounts, tax and final total.
2. Use **Simulate** where available to refresh the calculation before committing it.
3. If your policy allows an exception, use **Override** to select another structure, apply a discount or set a fixed price. Add a clear note explaining the decision.
4. If fee approval is enabled, choose **Approve Fees** only after the amount has been checked.
5. Use **Email Fees** where configured, and confirm the send succeeds.

Membership dates and prices vary by tenant; do not infer the period from an example or a previous organisation.

{{screenshot: The organisation Membership tab showing the calculated fee and approval controls}}

### Payment and purchase-order decision

The available route depends on the organisation and tenant configuration:

- Online payment may process payment and invoicing when the contact pays.
- Invoicing may be automatic, scheduled for a specified date, or manually triggered.
- A purchase-order number may be optional, required by your internal process, or supplied later. Record only a genuine PO reference (or the configured pending value); do not invent one.

**Expected outcome:** The agreed fee and invoicing mode are recorded for the correct membership period. An emailed fee notice is not proof that payment or invoicing completed, so verify those separately.
{{/feature}}

If you cannot see membership controls, ask a colleague with membership-fee access to complete and confirm this step.

## 5. Activate the organisation

Return to the organisation record and apply the status or action your tenant uses for activation. Before confirming, review any prepared communication or listed workflow actions.

Activation can be configured to create an invoice, send emails, record fee history, enable portal access, or update other records. These are optional automations. After activation, verify each expected result individually:

- The organisation has the intended active status.
- The main contact received or can request the correct account activation or password setup route.
- The fee appears in membership history when your process records it.
- An invoice exists and was sent only if your invoicing configuration calls for one.
- Any missing purchase order appears in the relevant report only if that reporting workflow is configured.

{{screenshot: The organisation activation action and its listed outcomes}}

{{feature: membership.organisation-directory}}
## 6. Confirm directory publication

Open the organisation directory and find the organisation. Publication depends on directory settings such as allowed application statuses, visible organisation types and explicit exclusions; changing an organisation to an active status does not guarantee that every tenant will publish it.

Check the name, logo and public-facing fields. If it is missing, compare the organisation record with the directory settings rather than repeatedly changing its status.

{{screenshot: The activated organisation in the organisation directory}}
{{/feature}}

## Final checks

- The application decision and submission status are recorded.
- The approved CRM details and main contact are correct.
- The fee, payment route and invoicing state match the agreed membership period.
- Every expected automation shows a successful outcome.
- The contact can sign in and knows where to maintain their organisation information.
- Directory visibility has been checked where your tenant uses an organisation directory.

For the contact's next steps, share [Getting started as an organisation contact](/help/getting-started-organisation-contact).

## Troubleshooting

**A submission cannot be found:** Include inactive forms in the form filter, clear saved filters and search by the submitter's email. Confirm that the applicant used the expected form.

**The CRM record did not update:** Check the submission's processing notes and whether the form is configured to create or update an organisation. Correct the record through the authorised CRM process.

**The fee looks wrong:** Verify the membership period, calculation field, structure or tier, pro-rata rules, discounts and tax before using an override.

**An email, invoice or directory entry is missing:** Check the relevant configuration and workflow result. A status change alone does not promise these outcomes.

**The contact cannot sign in:** Confirm that the correct email is linked to an enabled member record, then use your tenant's approved invitation or password-reset process.`,
  },

  {
    slug: 'getting-started-organisation-contact',
    title: 'Getting started as an organisation contact',
    category: 'Getting started',
    summary: 'Sign in, maintain your organisation profile, use membership and events, and invite eligible colleagues.',
    status: 'published',
    sort_order: 2,
    required_feature: 'organisation.my-organisation',
    body: `This guide covers the first steps after your organisation has been accepted and you have been given portal access. Menu names, directory terminology, membership options and invitation rights can vary. You will only see areas included in your role.

## Before you start

You need an invitation or account email sent to the address held for you, and your organisation must have enabled your login. Keep the invitation link private.

## 1. Set up your account and sign in

Open the invitation or password setup link and follow the prompts. Then sign in at your organisation's portal using the same email address.

If your link has expired, use **Forgot password** on the sign-in page or contact your portal administrator. See [Getting started with your member portal](/help/getting-started) for a tour of navigation and account basics.

{{screenshot: The portal sign-in or password setup page}}

## 2. Check your personal and organisation details

Open **About Me** to check your name, contact details and communication preferences where those options are available.

Open **My Organisation** to review the organisation profile. Keep its address, website, invoicing email, description, logo and any additional fields accurate. Some of these details may appear in an organisation directory or on invoices, depending on configuration. See [Managing your organisation's profile](/help/managing-your-organisation-profile).

{{screenshot: My Organisation with profile and directory information}}

{{feature: membership.organisation-directory}}
## 3. Check the organisation directory

Open the organisation directory and search for your organisation. The directory may use a tenant-specific name and may show only selected fields or organisations.

If your organisation is missing or information does not update after saving, contact your portal administrator. Directory visibility is controlled by the tenant's publication settings, not only by your profile edits.

{{screenshot: Your organisation's card in the organisation directory}}
{{/feature}}

{{feature: commerce.membership}}
## 4. Review membership

Open **Membership Fees** or the membership area available to your role to view the current period, amount and payment state.

{{feature: commerce.membership.pay-online}}
- If online payment is enabled, follow the on-screen payment option.
{{/feature}}
{{feature: commerce.membership.submit-po}}
- If purchase-order submission is enabled, enter your genuine PO number as requested.
{{/feature}}

Membership dates, prices, approval stages and payment methods are set by your organisation. If the amount or period is not what you expected, contact the administrator before paying or submitting a PO.

{{screenshot: The member-facing membership fee and payment options}}
{{/feature}}

{{feature: events.browse-events}}
## 5. Find and book events

Open **Events** to browse what is available to you. Eligibility, ticket types and payment methods vary by event and role. See [Browsing events and making a booking](/help/browsing-and-booking-events) before making your first booking.

{{screenshot: The Events listing available to an organisation contact}}
{{/feature}}

{{feature: membership.team}}
## 6. Invite eligible colleagues

Open **Team** to see people linked to your organisation.

{{feature: membership.team.invite-member}}
If **Invite Member** is available:

1. Enter the colleague's work email.
2. Review the invitation subject and message.
3. Send the invitation.
4. Ask the colleague to use the email they receive to complete registration.

Only invite people who are eligible under your organisation's rules. The number of colleagues, permitted email domains, available roles and whether an invitation needs approval are configuration-dependent; the portal will enforce the limits that apply to you.

{{screenshot: The Invite Member dialog in Team}}
{{/feature}}

If you can view Team but cannot see **Invite Member**, your role does not include invitation rights. Ask an authorised colleague or portal administrator to send it.
{{/feature}}

## What success looks like

- You can sign in with your registered email.
- Your personal and organisation details are accurate.
- You can see the membership, events, directory and Team areas included in your role.
- Any colleague you invited received an invitation and completed their own registration.

## Troubleshooting

**I did not receive an account email:** Check spam or junk mail and confirm the administrator used the correct email address.

**A menu item is missing:** Navigation follows your role and tenant configuration. Ask your portal administrator whether you should have access.

**My organisation details are read-only:** Your role may allow viewing but not editing. Send corrections to an authorised organisation contact or administrator.

**I cannot invite a colleague:** Check that you have invitation rights and that the colleague meets any domain, role or capacity rules. If a limit has been reached, contact your administrator.

**My membership or directory information looks wrong:** Do not create a second account or organisation. Report the discrepancy so the existing record can be corrected.`,
  },

  // ------------------------------------------------------------- Forms admin
  {
    slug: 'forms-managing-submissions',
    title: 'Forms: finding, filtering and exporting submissions',
    category: 'Forms',
    summary: 'Manage your forms, then find, filter, review and export the submissions that come in.',
    status: 'published',
    sort_order: 40,
    required_feature: 'forms.submissions',
    body: `When people complete your forms, everything they send arrives in one place: the Form Submissions page. This article shows you how to find the submissions you need, filter and save views, review individual entries, and export them. It starts with a quick tour of where forms themselves are managed.

{{feature: forms.form-management}}
## Where forms live: Form Management
Form Management is the home for the forms themselves. From here you can:

- Create a new form, or edit an existing one in the Form Builder.
- Duplicate a form — handy for reusing a structure; the copy starts with no submissions.
- Activate or deactivate a form. Inactive forms stop accepting submissions but keep everything already received.
- Switch between the tabs for standard forms and contract forms, and use the search, status, and other filters to find a form quickly. Pin the forms you use most so they stay at the top.

Each form card shows how many submissions it has received, with a shortcut through to those submissions.

{{screenshot: The Form Management page with the standard forms tab}}
{{/feature}}

## The Form Submissions page
Open Form Submissions from the navigation to see every submission you have access to, newest first.

At the top, summary cards give you the headline counts:

- All Submissions — everything in your current scope.
- New — submissions nobody has dealt with yet.
- Actioned — submissions marked as handled.
- Junk — spam or test entries you've set aside.

Below the cards, Submission Trends compares recent periods (last 7, 30, 90 and 365 days) against the previous period, so you can see at a glance whether activity is rising or falling.

{{screenshot: The Form Submissions page with status cards and trends}}

### All vs My Forms
If you own any forms, two tabs appear at the top: **All** shows every submission you can see, while **My Forms** narrows the list to submissions on forms you own. If you don't own any forms, the tabs are hidden and you simply see everything you have access to.

## Filtering submissions
The filter bar lets you combine several filters:

- **Search** — matches against the submission's content and submitter details.
- **Form** — pick a single form, or leave it on "All Forms". By default only active forms are listed; switch on **Include inactive forms** to filter by a form that's been deactivated (inactive forms are marked "(inactive)" in the list).
- **Status** — All Status, New, Junk or Actioned.
- **Date range** — From and To dates, with a "Clear dates" shortcut.

Your filters are kept in the page's address (URL), so a filtered view survives a refresh — and you can bookmark it or share the link with a colleague, who'll land on exactly the same filtered list.

{{screenshot: The submissions filter bar with a form and status selected}}

## Saved views
If you keep coming back to the same combination of filters, save it as a personal view:

1. Set the filters the way you want them.
2. Choose **Save view** and give it a name — for example "New entries this month".
3. Open **Saved views** any time to apply a view with one click.

From the Saved views list you can also rename a view, update it with your current filters, or delete it. Views are personal to you — they don't change what colleagues see.

{{screenshot: The Saved views list with a view being applied}}

## Reviewing a submission and changing its status
Each submission in the list shows who submitted it, when, which form it came from, and its current status. Choose **View Full** to open the complete submission, laid out section by section as the form was designed.

From the submission view you can:

- Change the status between New, Actioned and Junk using the status dropdown — use this to keep track of what's been dealt with.
- Edit an individual answer using the pencil icon next to it, if something needs correcting.
- Send a reply email to the submitter and see any replies already sent.

You can also update the status of several submissions at once from the list: tick the submissions (or "Select all"), choose a status, and apply it in bulk.

{{screenshot: A submission opened in full view with the status dropdown}}

## Exporting submissions
There are two export formats, and both respect your current filters:

- **Export CSV** — a spreadsheet of the filtered submissions. Select a single form first (the columns come from that form's fields), then tick exactly the fields you want as columns before exporting.
- **Export Word** — a formatted document, available whether or not a single form is selected. Choose which fields to include, then export.

If you've ticked specific submissions in the list, the export covers just your selection; otherwise it covers everything matching the current filters — the export dialog tells you how many submissions will be included before you confirm. You can also download a single submission as a Word document straight from the list.

{{screenshot: The export dialog with field selection}}

## Re-processing a submission and resending its emails
Some forms do work when a submission arrives — creating or updating records, and sending confirmation or notification emails. If something went wrong (or you need the emails to go out again), use the **re-run** button on the submission in the list.

Re-running processes the submission again and deliberately resends its emails, even if they were already sent — so use it when you genuinely want the emails to go out again. You'll see a message confirming whether emails were resent, skipped, or failed. Any issues found during processing are recorded as processing notes on the submission itself.

{{screenshot: The re-run button on a submission row}}

{{feature: forms.due-diligence-dashboard}}
## Due diligence submissions
Submissions on due diligence forms appear in this list too, but they're managed through their own workflow — for example, they can't be deleted from here. For scoring, review stages and everything else specific to due diligence, see [the Due Diligence Dashboard guide](/help/forms-due-diligence-dashboard).
{{/feature}}`,
  },
];

async function run() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) {
    throw new Error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set');
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
