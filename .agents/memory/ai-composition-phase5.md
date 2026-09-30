---
name: AI Composition Phase 5 page workflow
description: Create-page-with-AI wizard, plan review pause, functional-component placeholders, page SEO consent.
---

# AI Composition Phase 5 (enhanced page workflow)

- **Plan review is a pipeline pause, not a second endpoint.** `generate.js` stores state and returns `status:'awaiting_plan'` when `options.reviewPlan`; resume with `{jobId, approvePlan:true, plan?}` — the edited plan MUST go through `sanitizePlan` (element/component allowlists + pinned-record-id filter) before re-entering.
- **Prompts only ever see server-verified records.** Client-picked records (`options.records`) are UUID+kind allowlisted (`normalizeBriefRecords`, kinds are `event_registration`/`form`/`page`/`membership_application`/`document` — NOT `event`), then verified tenant-scoped into `state.records`; `reconcilePlaceholderRecords` strips any recordId the model invented and stamps the verified slug.
- **Functional components are placeholders, never recreated behavior.** `canvas_component_placeholder` maps componentKey→real canvas block via `client/src/lib/aicFunctionalComponents.js`; the block registry is lazy-imported there to break the circular chain registry→dynamicBlocks→AiCompositionBlock→AiCompositionRenderer. Unmapped keys show an editor notice and render nothing publicly — so a componentKey may only enter FUNCTIONAL_COMPONENT_KEYS once a real block mapping exists (membership_application is excluded for this reason).
- **Page SEO needs author consent.** Copy stage emits `copy.seo` only when `generateSeo`; includes `ogImageUrl` (first completed generated image in doc order); stored in `generation_metadata.seo` + returned in the completion response; the wizard applies it to `seo_title`/`seo_description`/`og_image_url` only when the consent checkbox is ticked.
- **IEditPage create field is `canvas_design`** (not canvas_design_json); IEditPageManagement uses react-router-dom + sonner.
