# GSF form deployment compatibility: read-only evidence

Observed **2026-09-29 10:13–10:14 UTC**. This is a public, unauthenticated GET-only check; no form was submitted, saved, or changed.

| GET URL | Result | Relevant observation |
|---|---|---|
| `https://gsf.iconn.app/api/public/tenant-branding` | HTTP 200, JSON | `success: true`, `branding.slug: "gsf"` and `branding.name: "gsf"`. This independently confirms that the candidate host (also used as an example in `client/src/api/publicClient.js`) resolves to the GSF tenant, rather than relying on the subdomain's spelling alone. |
| `https://gsf.iconn.app/` | HTTP 200, HTML | Module script references `/assets/index-CHekZ7EG.js`. |
| `https://gsf.iconn.app/assets/index-CHekZ7EG.js` | HTTP 200, JavaScript | Contains `public_member_signup`, `FORM_MEMBER_OWNER_REQUIRED`, `public-member-signup-notice`, “New members can complete and submit this form without signing in”, and “Sign in as an existing member”; references `/assets/FormBuilder-1Cg2p6GE.js`. |
| `https://gsf.iconn.app/assets/FormBuilder-1Cg2p6GE.js` | HTTP 200, JavaScript | Contains “Public new-member signup; verified existing owners”, the builder's eligibility error (“Public member signup is only available for a public member-only update contract…”), and guidance that existing member records require a verified logged-in owner. The mode constant is imported from the index chunk, so the literal `public_member_signup` need not appear in this chunk. |

The served **frontend** therefore has observable public-member-signup form-view and builder markers at this timestamp. This does **not** establish the deployed **backend revision** or that its save, admission, submission, and processing boundaries implement the same policy. It also does not establish that any GSF form currently uses that policy or that production configuration may be changed. Backend compatibility and current tenant-scoped form configurations must be separately confirmed before any approved rollout; do not infer them from JavaScript assets. No authenticated requests, answers, draft links, tokens, or secrets were obtained.