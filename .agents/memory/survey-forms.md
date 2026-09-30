---
name: Survey forms & scoring path
description: Architectural constraints for survey submissions, anonymity and publication integrity.
---

- ALL survey submits (public, embedded, and authenticated members) must flow through the single public submission endpoint — it is the only path that scores against the immutable published version snapshot. **Why:** any other create path (generic entity API, client-side pipelines) silently produces unscored, identified, or duplicate responses.
- Anonymity is a whole-pipeline property, not a column: identity-bearing ANSWERS must be redacted, identity side-effects skipped, and dedupe keys HMAC'd with a server secret. Redaction/identity extraction must read the published SNAPSHOT's field definitions, never the live form config — an admin can edit the live draft after publishing to dodge redaction.
- Server-authoritative records (version snapshots, normalised answers) must be write-blocked in the generic entity API and only created server-side; likewise "published" status may only be set by the publish endpoint, and editing a published survey's config reverts it to draft so live config can never drift from the serving snapshot.
- Anonymity also covers SIDE EFFECTS: newsletter/communication-preference subscription, submission notification emails, and network metadata (IP/user-agent) all leak identity unless skipped or fed only redacted answers.
- Duplicate prevention needs a DB unique partial index (concurrent requests both pass a pre-insert check); map its 23505 to the same 409 the pre-check returns.
- **How to apply:** any new survey surface, write path, or post-submission side effect must branch on form type and anonymity mode before touching respondent data.
