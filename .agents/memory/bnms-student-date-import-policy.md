---
name: BNMS student date import policy
description: Narrow approval for course-end preference import metadata effects, not membership or survey operations.
---

The owner approved the existing member modification-timestamp and survey-invitation revision effects for the 30-row student course-end workbook on 2026-11-10, after those effects were explicitly disclosed.

**Why:** The original import boundary excluded unrelated-field changes; an existing preference-write trigger reaches member metadata. That discovery was not implicit authorization to proceed.

**How to apply:** This approval is limited to that workbook's exact member IDs and course-end preference. It does not authorize membership expiry, access, billing, renewal, notifications, trigger bypasses, or metadata effects for other imports. Seek separate approval when another import exceeds its stated boundary.

## Student membership reconstruction authority

The owner subsequently authorised reconstruction for BNMS members with role **Student**, using **Member since** as the term start and the saved **Student course end date** as the inclusive term end, under the **2026-2027 Student** structure.

**Why:** Students must have a recorded term so they can follow the normal renewal journey when their course ends.

**How to apply:** Select by role, not merely membership-class preference. Exclude deleted members; do not invent missing dates or override immutable existing commitments. Preserve the rule that later course-date changes require an audited manual extension rather than silently changing an issued term. This approval does not authorise emails or charges.

The owner approved creating a course-date successor with the original Student structure name, retaining the issued annual structure as legacy and preserving its existing membership. The Student joining and renewal forms may point to that successor without changing their questions or approval requirements.

**Why:** A structure with an issued annual commitment cannot safely have its term policy changed in place.

**How to apply:** Continue using the course-date successor for new Student terms; never migrate an already-issued annual term merely because its structure is now legacy.

## Integration-test boundary

Date-based membership tests must include the pre-existing rolling-term completeness constraints, insertion guards, successor-policy immutability and column-level service grants, not only the date-term migration.

**Why:** An isolated date-term fixture passed while the actual combined database rejected date terms and protected legacy repairs.

**How to apply:** Verify successful inserts and exact authorised repairs as the runtime role, alongside negative tests for price changes, extensions, overlap and existing issued terms.
