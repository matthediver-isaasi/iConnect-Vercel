/**
 * Seed the Help Center pilot articles (Task #2199).
 *
 * GLOBAL content — shared across every tenant. Idempotent: matches existing
 * rows by slug and updates them, otherwise inserts. Safe to re-run.
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
  {
    slug: 'getting-started',
    title: 'Getting started',
    category: 'Basics',
    summary: 'A quick tour of your member portal and where to find things.',
    status: 'published',
    sort_order: 0,
    body: `Welcome to your member portal. This short guide points you to the areas you'll use most often.

## Finding your way around
The main navigation on the left links to everything available to you. What you see depends on your membership and role.

{{screenshot: The main portal navigation}}

## Your profile
Keep your details up to date so your organisation can reach you.

- Open the profile area from the navigation
- Update your contact details and preferences
- Save your changes

If something looks missing, contact your organisation's administrator.`,
  },
  {
    slug: 'updating-your-profile',
    title: 'Updating your profile and preferences',
    category: 'Your account',
    summary: 'Change your contact details, communication preferences, and password.',
    status: 'published',
    sort_order: 1,
    body: `You can manage your own details at any time from the portal.

## Contact details
Open the profile area and edit your name, email, and other contact fields, then save.

{{screenshot: The profile edit form}}

## Communication preferences
Choose which emails you'd like to receive. Turning a category off stops those messages without affecting essential account emails.

## Changing your password
Use the account security section to set a new password. If you've forgotten it, use the "Forgot password" link on the sign-in page instead.`,
  },
  {
    slug: 'booking-an-event',
    title: 'Booking an event',
    category: 'Events',
    summary: 'Browse upcoming events and reserve your place.',
    status: 'published',
    sort_order: 2,
    body: `Events your organisation runs appear in the Events area.

## Browse and book
- Open Events from the navigation
- Select an event to see the details
- Choose your ticket or place and confirm

{{screenshot: An event details page with the booking button}}

## Managing your bookings
Your confirmed bookings appear under your tickets. Open one to view the details or, where allowed, request a change or cancellation.

If an event is full or bookings have closed, the booking button won't be available.`,
  },
  {
    slug: 'finding-resources',
    title: 'Finding resources and documents',
    category: 'Resources',
    summary: 'Search and download the files your organisation shares with members.',
    status: 'published',
    sort_order: 3,
    body: `Your organisation may share documents, guides, and other files in the Resources area.

## Browsing resources
Resources are grouped by category. Open a category to see what's inside.

{{screenshot: The resources listing grouped by category}}

## Searching
Use the search box to find a resource by name. Select any item to view or download it.

Access to some resources depends on your membership, so you may not see every category.`,
  },
  {
    slug: 'getting-help',
    title: 'Getting help and support',
    category: 'Basics',
    summary: 'How to reach your organisation when you need a hand.',
    status: 'published',
    sort_order: 4,
    body: `If you can't find what you need in these articles, your organisation is here to help.

## Contact support
Use the Support area to send a message. Choose the type of request so it reaches the right person.

{{screenshot: The support request form}}

## What to include
- A clear description of what you were trying to do
- What happened instead
- Any error message you saw

The more detail you give, the faster your organisation can help.`,
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
