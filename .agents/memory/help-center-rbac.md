---
name: Help Center RBAC gating
description: How /Help articles are gated by feature, and how section-level gates work
---

The Help Center (`/Help`, articles at `/help/:slug`) has presentation-only RBAC that mirrors portal nav — it hides guidance, it is NOT access control for real data.

Two gating levels:
- **Article-level**: `help_article.required_feature` (a canonical roleAccessMap key). `Help.jsx` filters the index by it; `HelpArticleView.jsx` shows a "not available to you" state so a direct URL can't bypass. Both use `useMemberAccess().isFeatureExcluded` / `isAccessReady`.
- **Section-level**: `{{feature: KEY}} ... {{/feature}}` markers inside the body, parsed nesting-safe in `HelpArticleContent.jsx` via `canAccessFeature` prop. Defaults always-allow so the platform editor preview shows every section; the portal passes a real check.

**Why:** members should only see help for features they can actually use, without duplicating articles per role.

**How to apply:**
- Use CANONICAL keys from `client/src/lib/roleAccessMap.ts` (e.g. `events.browse-events`, `events.my-tickets`, `commerce.balances[.training-fund-card]`, `user.about-me[.communication-preferences]`, `content.resources`). Legacy `page_*` keys are normalized by `migrateLegacyFeatureId` but don't author new ones.
- Content lives in `scripts/seed-help-articles.mjs` (GLOBAL, idempotent by slug). Screenshots are `{{screenshot: Label | optional-url}}` — placeholder box until a URL is added, no code change to swap in a real image.
- Adding a column to `help_article`: migration in `supabase/migrations/`, register in `scripts/apply-help-articles.mjs` MIGRATIONS, add to `schema/HelpArticle.json`, and whitelist in `api/platform/help-articles.js` sanitizeFields. Generic entity API `.select('*')` returns it automatically.
- Apply migration: `node scripts/apply-help-articles.mjs` (DEST pooler, IPv4). Seed: `node scripts/seed-help-articles.mjs --apply` (DEST_SUPABASE_URL/KEY).

**Page coverage + AI content builder** (platform Help Center tab): coverage lists every ROLE_ACCESS_MAP page; a page counts as "built" when a `help_article` has `required_feature === page.id` (matched by required_feature, NOT slug). Feature-gated seed articles (required_feature = a sub-feature key) therefore don't count toward page-level coverage — by design. Generation endpoint `api/platform/help-articles-generate.js` drafts via OpenAI, upserts idempotently by a DETERMINISTIC slug (page id dashified, e.g. `events-browse-events`), sets required_feature=page.id and `status='published'` (must be published to appear in AI search — reindexArticle drops non-published), then re-indexes just that article. OpenAI (generation + embeddings) is Vercel/CI-only, so verify end-to-end on deploy.
