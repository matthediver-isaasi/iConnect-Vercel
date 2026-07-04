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
