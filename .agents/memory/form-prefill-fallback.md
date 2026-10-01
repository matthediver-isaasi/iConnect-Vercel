---
name: Form prefill logged-in fallback
description: Precedence and race rules for member/org form prefill across the parallel form-rendering surfaces.
---

Several form surfaces (standalone page, embed iframe route, page-builder form element) orchestrate member/organisation prefill in parallel; keep their behaviour identical via the shared prefill helpers rather than re-inlining logic.

**Rules:**
- Prefill target precedence: explicit URL param > authenticated member/their org > nothing. The authenticated fallback only applies when the LOADED form's prefill source is member/organisation — so it must be derived after the form definition resolves, not from the raw URL at component top.
- **Why:** deriving it earlier either breaks explicit-param precedence or leaks fallback behaviour onto non-prefill forms and anonymous viewers.
- The one-time prefill effect latches an "applied" flag. Two race traps: (a) it must wait for ALL relevant custom-value queries (member AND org) before applying, or an entity resolving first permanently skips custom-field prefills; (b) it must latch even when the mapping produced NO values, or a later query refetch can overwrite input the user has since edited.
- Embed iframe routes are same-origin but render outside the main layout's auth flow, so shared auth context never resolves there — resolve the session directly against the auth endpoint with credentials included, treating any failure as anonymous (blank fields).

## Initial selections versus restored answers

Treat an explicitly present blank answer as intentional when applying Group initial selections. Wait for defaults, authentication, draft restoration and entity prefill before attempting initialization; absence of a key is different from a stored empty value.

**Why:** Initial choices are a convenience for new answers, not authority to rewrite drafts or repeatably restore a value a respondent cleared. A field lock prevents respondent editing, but does not prevent an author-configured initial choice; a disabled review surface must never initialize answers.

**How to apply:** Preserve that distinction on every form surface and when creating repeatable rows. Validate the candidate against successfully loaded respondent-allowed options, then use the ordinary change path so dependent fields update.
