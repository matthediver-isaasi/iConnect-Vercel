/**
 * Persona-specific sample content packs for the self-serve onboarding wizard.
 *
 * Each pack returns plain-data records that the seeder will insert with
 * is_sample=true so they can be wiped via the "Remove sample content" action.
 *
 * Keep packs small and obviously demo-flavoured — these exist to give a new
 * admin something concrete to look at on day one, not to build out a full site.
 */

export const PERSONAS = [
  { code: 'gym',                label: 'Gym / fitness club' },
  { code: 'professional_body',  label: 'Professional body / institute' },
  { code: 'charity',            label: 'Charity / nonprofit' },
  { code: 'trade_association',  label: 'Trade association' },
  { code: 'club_society',       label: 'Club or society' },
  { code: 'faith_community',    label: 'Faith community' },
  { code: 'education',          label: 'Education / alumni' },
  { code: 'other',              label: 'Something else' },
];

export function isValidPersona(code) {
  return PERSONAS.some(p => p.code === code);
}

function plusDays(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(18, 0, 0, 0);
  return d.toISOString();
}

const BASE = {
  members: [
    { first_name: 'Alex',   last_name: 'Sample',  email_suffix: 'alex.sample'   },
    { first_name: 'Jordan', last_name: 'Example', email_suffix: 'jordan.example' },
  ],
};

const PACKS = {
  gym: {
    organization: { name: 'Sample Fitness Studio (demo)' },
    events: [
      { title: 'Morning HIIT (sample)',  summary: 'A demo class to show how event registration works.', starts_at: plusDays(3) },
      { title: 'Saturday Yoga (sample)', summary: 'Demo yoga class — feel free to edit or delete.',     starts_at: plusDays(7) },
    ],
    resources: [{ title: 'Gym induction handbook (sample)', description: 'Demo resource — replace with your own induction PDF.' }],
    blog_posts: [{ title: 'Welcome to the studio (sample)', summary: 'A demo post to show how your blog will look.' }],
  },
  professional_body: {
    organization: { name: 'Sample Member Firm Ltd (demo)' },
    events: [
      { title: 'CPD Webinar: Industry Update (sample)', summary: 'Demo CPD session — edit details to match your programme.', starts_at: plusDays(10) },
    ],
    resources: [{ title: 'Code of conduct (sample)', description: 'Demo resource — upload your real code of conduct here.' }],
    blog_posts: [{ title: 'Welcome to your member portal (sample)', summary: 'Demo announcement — replace with your launch message.' }],
  },
  charity: {
    organization: { name: 'Sample Supporter Group (demo)' },
    events: [
      { title: 'Volunteer Onboarding (sample)', summary: 'Demo session for new volunteers.', starts_at: plusDays(5) },
    ],
    resources: [{ title: 'Volunteer handbook (sample)', description: 'Demo resource — replace with your real handbook.' }],
    blog_posts: [{ title: 'Thank you for joining (sample)', summary: 'Demo welcome post for new supporters.' }],
  },
  trade_association: {
    organization: { name: 'Sample Member Company (demo)' },
    events: [{ title: 'Industry Roundtable (sample)', summary: 'Demo networking event.', starts_at: plusDays(14) }],
    resources: [{ title: 'Member benefits overview (sample)', description: 'Demo resource — edit to list your real benefits.' }],
    blog_posts: [{ title: 'Sector news roundup (sample)', summary: 'Demo article — replace with your first real post.' }],
  },
  club_society: {
    organization: { name: 'Sample Club Branch (demo)' },
    events: [{ title: 'Members Social (sample)', summary: 'Demo social event.', starts_at: plusDays(4) }],
    resources: [{ title: 'Club constitution (sample)', description: 'Demo resource — upload your real constitution.' }],
    blog_posts: [{ title: 'Hello from the committee (sample)', summary: 'Demo update — replace with your real announcement.' }],
  },
  faith_community: {
    organization: { name: 'Sample Congregation (demo)' },
    events: [{ title: 'Sunday Service (sample)', summary: 'Demo service listing.', starts_at: plusDays(2) }],
    resources: [{ title: 'Weekly bulletin (sample)', description: 'Demo bulletin — replace with this week\'s real version.' }],
    blog_posts: [{ title: 'A note from the team (sample)', summary: 'Demo post — replace with your real message.' }],
  },
  education: {
    organization: { name: 'Sample Alumni Chapter (demo)' },
    events: [{ title: 'Alumni Reunion (sample)', summary: 'Demo reunion event.', starts_at: plusDays(30) }],
    resources: [{ title: 'Alumni benefits guide (sample)', description: 'Demo resource — replace with your real guide.' }],
    blog_posts: [{ title: 'Class notes (sample)', summary: 'Demo class-notes post — replace with real alumni stories.' }],
  },
  other: {
    organization: { name: 'Sample Organisation (demo)' },
    events: [{ title: 'Kick-off Meeting (sample)', summary: 'Demo event — edit to match your first real event.', starts_at: plusDays(7) }],
    resources: [{ title: 'Getting started guide (sample)', description: 'Demo resource — replace with your real document.' }],
    blog_posts: [{ title: 'Welcome (sample)', summary: 'Demo post — replace with your launch announcement.' }],
  },
};

export function getPersonaPack(code) {
  const pack = PACKS[code] || PACKS.other;
  return { ...pack, members: BASE.members };
}
