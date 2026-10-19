# iEdit authored-content extraction coverage and dynamic selection audit

## Scope and contract

Audit source: `client/src/components/iedit/IEditElementRenderer.jsx` and its 28 registered element renderers under `client/src/components/iedit/elements/`. `IEditTextHeroElement.jsx` is **not registered** and must not silently become a supported type.

Implementation: `api/_lib/memberContentIEditExtraction.js` (authored fields), `api/_lib/memberContentIEditDynamic.js` (entity selection/authorization), and `api/_lib/memberContentIEditGeneration.js` (canonical generation adapter). Corresponding test files are `memberContentIEditExtraction.test.mjs`, `memberContentIEditDynamic.test.mjs`, and `memberContentIEditGeneration.test.mjs` in the same directory.

`extractIEditElement(element)` accepts the renderer's persisted shape (`element_type`, `content`), returns `{ sections: [{ text }], dynamic }`, and throws on an unknown/missing type. The exported, frozen `IEDIT_COMPONENT_POLICIES` is a closed field inventory and dynamic-dispatch registry. Policy paths are descriptive; the implementation also enforces the branch rules below. The generation adapter is integrated with the indexer/knowledge generation publisher and live access revalidation; static extraction remains independently usable and does not itself perform queries.

Sections contain nonempty authored strings, not serialized objects. Rich text is parsed using the existing `parse5` dependency: preserve readable text, paragraph boundaries, link text, figure captions and non-presentational inline image alt; decode named/numeric entities; discard script/style/template/iframe/embed content, hidden content and form-control values. URL, title, data and event-handler attributes are not collected. Finite numeric timeline years are the one explicitly supported non-string value. Repeated authored labels are preserved, not globally deduplicated.

The static extractor covers all authored panels/slides/quotes and collapsed accordion/timeline copy, not just the initial viewport or current carousel item. It does not insert renderer default labels, empty-state/loading/error text, or perform member merge/prefill substitution. A selected dynamic entity might not exist or pass authorization; authored header copy is nevertheless returned independently of that entity load. Conditional renderer labels on dynamic cards may be returned before entity resolution; `dynamic: true` dispatches to the implemented entity resolver when used through the generation adapter.

The adapter requires a valid generation, rereads the canonical tenant-scoped page and elements, and rejects partial element reads (exact count, 100-row pages, 500-element maximum, stable display-order/ID ordering). It creates separate sections/chunks with page and authored element context, a maximum of 1500 characters per chunk, per-section public/authenticated scope, and hashed display proofs identifying element/order/text/dependencies. Sections are never concatenated across different element selections. The writer's separate knowledge RPC performs generation/lease CAS publication; live retrieval rebuilds a viewer-specific snapshot and rejects stale or no-longer-visible section proofs.

## Complete renderer coverage matrix

Paths below are relative to `element.content`. Every unlisted property is excluded. Renderer filenames below are relative to `client/src/components/iedit/elements/`.

| Registered type | Renderer file | Authored fields selected | Branch rules / exclusions | Dynamic |
| --- | --- | --- | --- | --- |
| `hero` | `IEditHeroElement.jsx` | `heading`, `subheading`, `content_text`, `button.text` | No image URLs, background/focal/mobile/style settings or button destinations. | No |
| `text_block` | `IEditTextBlockElement.jsx` | `heading`, `text` | Includes rich text and its nested visible captions/alt/link labels only. | No |
| `image` | `IEditImageElement.jsx` | `altText`, `caption` | Requires `imageUrl`; `decorative` suppresses alt, not caption. No fabricated fallback alt. | No |
| `two_column` | `IEditTwoColumnElement.jsx` | `leftHeading`, `leftContent`, `rightHeading`, `rightContent` | Column images have fixed empty alt; image URLs/config excluded. | No |
| `cta_button` | `IEditCtaButtonElement.jsx` | `button.text` | No button URL, tracking, style ID or runtime state. | No |
| `image_hero` | `IEditImageHeroElement.jsx` | None | Renderer has URLs and a fixed foreground-image alt, but no authored textual field. Explicit empty policy, not an omission. | No |
| `wall_of_fame` | `IEditWallOfFameElement.jsx` | `heading_text`, `subheading_text`, `body_content`, `custom_title` | `custom_title` omitted when `show_category_name === false`. No embedded people/category snapshots. | **Yes** |
| `form` | `IEditFormElement.jsx` | `heading`, `subheading`, `text_content` | No embedded form fields/values, schema snapshots, consent runtime, member/org info, prefills, drafts or submission state. | **Yes** |
| `text_overlay_image` | `IEditTextOverlayImageElement.jsx` | `header`, `text` | No background image/configuration or editor file descriptions. | No |
| `table` | `IEditTableElement.jsx` | `header`, `description`, `cells["row-col"]` | Only canonical nonnegative coordinates inside `rows`/`cols` (renderer fallback: 2 each), in row-major order. `cellTypes[key] === "image"` excludes the URL cell; text/header cells remain. No stale cells, column widths or config. | No |
| `banner_carousel` | `IEditBannerCarouselElement.jsx` | `banners[].headerText`, `.paragraphText`, `.ctaText` | CTA label only when `ctaLink` exists. Every banner, no image/URL/autoplay config. | No |
| `showcase` | `IEditShowcaseElement.jsx` | `headerText`, `descriptionText`, `body_content` | `cards[]` are selection/configuration, **not** embedded authored title/body fields. No fetched item/co-author snapshots. | **Yes** |
| `resources_showcase` | `IEditResourcesShowcaseElement.jsx` | `headerText`, `subheaderText`, `descriptionText`, `button_text` | No resource snapshots/IDs/URLs or fabricated default button label. | **Yes** |
| `button_block` | `IEditButtonBlockElement.jsx` | `heading_text`, `subheading_text`, `body_content`, `buttons[].text` | All configured button labels; exclude destinations/styles. | No |
| `page_header_hero` | `IEditPageHeaderHeroElement.jsx` | `header_text`, `subheading_text`, `content_text` | Header-derived image alt would repeat existing copy, so is not emitted again. | No |
| `organisation_directory` | `IEditOrganisationDirectoryElement.jsx` | `header_title`, `header_subtitle`, `header_content` | No organizations/members/contact snapshots, member counts, system settings or current search/filter state. | **Yes** |
| `featured_job` | `IEditFeaturedJobElement.jsx` | `header_label`, `main_heading`, `subheading`, `button_text`, `right_header_text` | Static left content and authored right header only; no selected job snapshot or renderer defaults. | **Yes** |
| `image_panel` | `IEditImagePanelElement.jsx` | `panels[].header_text`, `.bottom_text`, `.button.text` | Exactly first **five** configured panels, matching `displayPanels`; not three, and not all stale panels. | No |
| `accordion` | `IEditAccordionElement.jsx` | `header_title`, `header_subtitle`, `header_content`, `items[].title`, `.content`, `.links[].label` | Include collapsed item copy and authored link labels. `items[].files` and file descriptions are editor picker data, not rendered content. | No |
| `quote` | `IEditQuoteElement.jsx` | `header_title`, `header_subtitle`, `header_content`, `quotes[].quote_text`, `.author_name`; legacy root `quote_text`, `author_name` | Nonempty `quotes` supersedes legacy root fields. Legacy attribution only if root `quote_text` exists. Authored attribution is intended copy; arbitrary member/profile/email data is not. | No |
| `fifty_fifty` | `IEditFiftyFiftyElement.jsx` | `header_title`, `header_subtitle`, `header_content`, `left_heading`, `left_subheading`, `left_content`, corresponding `right_*`, `button.text` | A side with `*_content_type === "image"` suppresses its stale text fields; images have empty alt. | No |
| `card_deck` | `IEditCardDeckElement.jsx` | `heading`, `subheading`, `body_content`, `cardButtonText` | Button text omitted if `showCardButton === false`; no card row snapshots. | **Yes** |
| `logo_grid` | `IEditLogoGridElement.jsx` | `heading`, `subheading`, `body_content`, `logos[].name` | Name is rendered as alt even if rollover display is disabled. No invented `caption`/`altText` fields or logo URLs. | No |
| `event_spotlight` | `IEditEventSpotlightElement.jsx` | `heading`, `subheading`, `additional_content`, `button.text` | Button label omitted if `show_cta_button === false`; no event/speaker/ticket/runtime data. | **Yes** |
| `video` | `IEditVideoElement.jsx` | `title`, `caption`, `transcript` | Transcript is authored accessible copy. `embed_code`, `captions_url`, provider URLs and media config excluded; no network transcript fetch. | No |
| `timeline` | `IEditTimelineElement.jsx` | `title`; item `year`, `heading`, `body`; visible column `heading`, `body`; item/column sub-item `year`, `heading`, `body`; each rendered entry's `media_items[].alt` or legacy `media.alt` | `columns > 1` with nonempty `column_content` selects its first `columns` columns instead of stale parent heading/body/media/sub-items. Column `year` is not rendered. Sub-items are one level only, not an arbitrary recursive content tree. Nonempty `media_items` supersedes legacy `media`; entries require `src`. Legacy video alt is not rendered. No media URLs, embed code, configuration or arbitrary `caption` properties. | No |
| `hero_carousel` | `IEditHeroCarouselElement.jsx` | `slides[].headerText`, `.subheadingText`, `.contentText`, `.ctaText` | Every slide; CTA requires `ctaLink`. Slide image alt is fixed empty in renderer: invented slide `altText` is excluded. | No |
| `gallery` | `IEditGalleryElement.jsx` | `heading` | Gallery titles/descriptions and photo captions/alt are fetched data, never trusted from `content.galleries`/`photos` snapshots. | **Yes** |

## Dynamic selection audit and implemented resolver

The following renderer observations explain selection contracts; they are not authorization grants. `resolveIEditDynamic` now implements bounded, exact-count, tenant-scoped entity reads (200-row pages, 10,000-row maximum, stable ID tie-breaker) with current publication/access filtering and per-section display dependencies. Index-time audience-gated evidence remains authenticated-scoped; viewer-time resolution rechecks current roles/groups, resource category/booking gates, gallery/form access policies and selected entities before a section proof can be reused. Failed/incomplete reads throw rather than silently publishing a partial source. Selection IDs, a public client call or the renderer's authenticated-member branch do not independently authorize indexing.

### `showcase`

- Sources are `publicClient.listNews()`, `listResources()`, `listArticles()` (array or `{ articles }`) and `listJobPostings()`.
- `content.cards` is an ordered list of slots. Each slot uses `contentType` (`news`, `resources`, `articles`, `jobs`), `itemId`, and `autoLatest`.
- Build newest-first lists **per type**, sorting descending by `published_date || created_at || created_date || 0`.
- Before resolving any slot, reserve **all explicit slots'** `${contentType}:${itemId}` keys, including explicit slots appearing later.
- Resolve slots in configured order. Auto-latest picks the first unclaimed row of that slot's type, then claims its key. Explicit slots perform ID lookup; explicit duplicates are not deduplicated by the renderer. Empty/unresolved slots disappear.
- `cardCount` controls grid layout; the renderer does **not** slice the configured slot array to this count.
- Visible item copy includes title/name, summary/description, image alt derived from title/name, publication metadata and article co-author display. Co-authors are fetched for resolved articles via `/api/articles/co-authors?ids=...`, not from arbitrary page content.

### `resources_showcase`

- `resourceSourceMode === "latest"` selects latest mode; every other value means specific mode.
- Specific mode filters blank/whitespace-only entries from `resourceIds`, fetches each remaining exact ID via `getResource(id)` and preserves order (including duplicates). The renderer does not trim nonblank IDs before lookup and does not slice configured IDs to four.
- Latest mode uses `listResources()`, sorts descending by `release_date` (missing date sorts as zero), then takes **four**.
- Visible fetched fields are resource `title` and, unless `showResourceDescription === false`, `description`. Destination/public/member/form icon decisions are not prose.

### `card_deck`

- Loads `publicClient.listCardDecks()` (`/api/public/card-decks`, active current-tenant cards).
- Resolve truthy `cardIds` in configured order to exact IDs, drop missing cards, then `slice(0, cardCount)` with renderer default `cardCount = 3`. Do not slice IDs before removing unresolved rows. Repeated configured IDs are retained.
- Card title, optional description (`showCardDescription`), optional title-derived image alt (`showCardImage`) and configured button label (`showCardButton`) are renderer-visible. Description may be rich text; styling/clamping does not change authored source copy.
- Link text is included only for entries with both `url` and `text`. Button text requires `target_url`, preferring the card's `button_text` over the element's `cardButtonText` (default `Learn More`). The authored-only pass does not emit a button label without an eligible card. No link is crawled and no destination URL is embedded.
- Selected IDs are fetched in bounded batches with tenant/active predicates and count-checked pagination. Section dependencies identify the actual selected card. Real generation/publication and live revalidation tests cover edits, deactivation, deletion, tenant changes, selection/toggle changes and failed loads, without a stubbed dynamic resolver.

### `featured_job`

- Loads `listJobPostings()`. A truthy `specific_job_id` uses exact ID lookup and bypasses the renderer's active/deadline filtering.
- Without a specific ID, filter `status === "active"` and either no `closing_date` or a valid `parseJobClosingDate(closing_date) >= startOfLocalToday()`. Sort featured first, then descending `created_date`, select **one**.
- `show_latest_job` is destructured/editor-configured but **not used** by this renderer's query selection. A loader that branches on it would diverge.
- Visible job data is the selected job's display details, not contact/configuration columns. A pinned expired/inactive job remains subject to independent server visibility rules.

### `event_spotlight`

- Exact `event_id` via `publicClient.getEvent(event_id)`; no event ID means no query.
- Event heading/static headers are authored separately. Selected event title/date/time/location/description depend on `show_date`, `show_time`, `show_location`, `show_description`.
- Fetch roles only with an event and `show_ticket_prices`; fetch speakers only with an event, `show_speakers`, and nonempty `event.speaker_ids`. Speaker selection must be restricted to those event IDs, not all tenant speakers.
- `show_cta_button` controls CTA visibility; event slug/ID determines its destination. Never index member ticket bookings, attendee records or registration state.

### `wall_of_fame`

- `section_id` scopes `WallOfFameDisplay`. Sections come from `listWallOfFameSections()`; categories from `listWallOfFameCategories(sectionId)`, ascending `display_order || 0`.
- iEdit does **not** pass the reusable display component's optional pinned `categoryId`. Exactly one category auto-selects; otherwise a category navigation grid is shown until user selection.
- People are loaded only for the selected category via `listWallOfFamePeople(categoryId)`, ascending `display_order || 0`. Do not load every tenant person or treat people under another section as selected.
- The implemented resolver includes selected section/category navigation and interactive editorial biography/card-reverse copy across the selected section, including selected-category dependencies. Each category's compact roster is emitted before long biographies so a source-wide context cap does not select only early biographies and omit later board membership. It reads explicit editorial first/last names, job titles, secondary organization/job title and biography. It excludes CRM-derived title prefixes, emails and LinkedIn/profile destinations. This is not a general Member/contact-table crawler.

### `organisation_directory`

- Reads system settings `org_directory_excluded_orgs`, `org_directory_allowed_application_statuses`, `org_directory_show_name_tooltip`, `org_directory_show_title`.
- Calls `listOrganizations({ directoryPolicy: true, allowedStatuses? })` once policy settings have loaded; excludes configured IDs and sorts by name. Interactive search matches name/domain; sorting and pagination are visitor UI state, not selection IDs authored into the page.
- Initial UI uses ascending names and page 1, with page size `columns * rowsPerPage`. The implemented resolver includes authorized paginated navigation when pagination is enabled; when `showPagination === false`, it retains only that first page.
- `showTitle`, global title policy and tooltip policy determine visible names. Although `showDomains` is configured/destructured, domains are not actually rendered by this element and are not extracted. The resolver emits only names permitted by the exclusion/status/type policies; organization preference values are authorization inputs, not indexed copy.
- The renderer's **separate** `Member.listAll()` call is only for authenticated member counts (`showMemberCount`); exclude Member rows, emails and derived personal data from page extraction regardless of that frontend call.

### `gallery`

- `gallery_ids` restricts to selected IDs **when nonempty**; empty means every gallery in the authorized source feed, not no galleries.
- Filtering preserves source feed order, **not configured ID order**.
- Guest source is `publicClient.listGalleries()`; member UI uses `Gallery.list("display_order")`. A server loader must not emulate the latter using unrestricted service-role data.
- Member grid initially obtains one `GalleryPhoto` per gallery (sort `display_order`, `created_at`, exact count), honoring `cover_photo_id`. Public grid uses endpoint `cover_photo`, then resolved member `coverPhoto`, then matching cover ID/first photo.
- Lightbox separately loads **all photos of the opened gallery**, paginated using `listAll`, with gallery ID filter and the same order. Grid cover metadata is not equivalent to full authored lightbox captions.
- The implemented resolver evaluates current gallery access policy, loads complete selected-gallery photos with count-checked pagination, and emits title/description, the visible derived photo-count label and each photo's caption-or-alt fallback. Storage paths, signed URLs and uploader/member metadata are excluded. The derived count is dynamic display copy, not a static authored field.

### `form`

- `form_slug` selects `publicClient.getForm(formSlug, { authenticated: !!memberInfo })`; do not guess a form from embedded content or index every tenant form.
- `show_form_title` and `show_form_description` govern fetched form title/description. Field labels/help/choices and page instructions are schema data with conditional visibility, not page-authored static content.
- The implemented resolver selects the current active/not-deactivated form, evaluates current form access policy, and emits allowed title/description/submit labels plus authored page/field/help/placeholder/instruction/image-alt/choice labels. Hidden fields/pages, rule targets and answer-conditional branches are omitted rather than evaluated offline. Published direct surveys use their published version; assignment-linked/personalized surveys are excluded.
- URL member/org/department parameters, member/org context, drafts/resume tokens, relationship options, saved/default values, payments, submissions and conditional answers are **personal/runtime** and forbidden as indexed page copy. Relationship/CRM option records are not harvested.

## Test evidence and maintenance

The node test suite asserts exact registry parity against all 28 renderer registrations, one independent positive/negative fixture per type, dynamic dispatch for all nine dynamic types, no input mutation, no stringification of runtime objects, HTML/entity/alt handling, and selection branches (tables, five panels, quotes, hidden controls, column/sub-item/media fallbacks). A new renderer type fails parity until explicitly audited and classified.

The generation adapter acceptance suite additionally exercises canonical claim reads, count/limit/error failures, all renderer dispatches, real selected board/team separation, injected role-protected dynamic sections, continuation context/chunk boundaries, current snapshot proofs, active microsite restrictions, and stale concurrent-edit publication using fake generation/knowledge RPCs. Real `revalidateMemberContentCandidates` integration tests additionally rebuild editorial rosters, re-evaluate current resource roles and microsite activity, reject failed source reads, and verify the second generation read catches a concurrent mutation during dynamic resolution.

Actual ask-handler request-path fixtures cover the direct question “Who is on Graduate Futures Institute’s board?” and the reported two-turn sequence “Who is the CEO of Graduate Futures” followed by exactly “Who else is on the board?”. They assert that literal embedding/search inputs remain unchanged (no context rewrite), current eligible compact roster/citation evidence is accepted, old assistant facts are not replayed as authority, and roster revocation during synthesis suppresses the final answer and citations. The fixture uses synthetic editorial board identities, a fake embedding/search/provider response and the real source Access/adapter/dynamic/citation code. It is **not** a test of real-model semantic retrieval, the actual current board identities, or a deployed conversation. It performs no production writes or network calls.

Run all focused suites behind the network/process isolation boundary:

`node scripts/run-isolated-tests.mjs node --test api/_lib/memberContentIEditExtraction.test.mjs api/_lib/memberContentIEditDynamic.test.mjs api/_lib/memberContentIEditGeneration.test.mjs`

These are isolated unit/adapter acceptance checks, not a browser assertion or a live production database/migration check. No workflow or running app is started by these tests.
