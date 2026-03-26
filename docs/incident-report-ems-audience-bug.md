# Incident Report: Email Campaign Audience Targeting Issue

**Date:** March 2026  
**Severity:** High  
**Status:** Resolved  

---

## Executive Summary

A test email campaign intended for 3 specific recipients was sent to approximately 4,700 members. The issue was caused by a gap in how the system handled audience selection — when a campaign was created without explicitly saving an audience list, the system defaulted to targeting all members instead of blocking the send. The issue has been fully resolved with multiple layers of protection added to prevent any recurrence.

---

## What Happened

A staff member created a test email campaign ("Heads of Service TEST Sharon") and intended to send it to a small group of 3 recipients. During setup, the audience list selection was not saved to the campaign. When the campaign was sent, the system fell back to a default behaviour that targeted all members in the tenant, resulting in the email being delivered to approximately 4,700 members.

The email content was a test/draft and was not intended for wide distribution.

---

## Timeline

1. **Campaign created** — Staff member created the test campaign and selected recipients in the interface.
2. **Audience not saved** — Due to a gap in the save process, the selected audience list was not persisted to the campaign record.
3. **Campaign sent** — When the send was triggered, the system found no audience list attached. Instead of blocking the send, it fell back to a default "all members" targeting mode.
4. **Emails delivered** — Approximately 4,700 emails were sent and delivered before the issue was identified.
5. **Issue identified and investigated** — The root cause was traced to the fallback targeting behaviour and the missing audience validation.

---

## Root Cause

The issue involved two contributing factors:

1. **Audience list not saved:** When the campaign was created or edited, the selected audience list was not saved to the campaign record. The campaign was stored with an empty audience list.

2. **Unsafe fallback behaviour:** When the system attempted to send the campaign and found no audience list, rather than stopping and alerting the user, it defaulted to a mode that targeted all members in the organisation. This fallback was originally designed as a convenience feature but proved dangerous when combined with missing audience data.

The communication category filter (which members can opt out of) did remove some recipients, but it does not act as a targeting mechanism — it only excludes opted-out members from whatever audience is selected.

---

## Fix Applied

### Immediate Fix — 4-Layer Safety System

The following safeguards have been implemented to ensure this cannot happen again:

#### Layer 1: Frontend Validation
- The "Save" and "Send" buttons are now disabled unless at least one audience list is explicitly selected.
- The dangerous "all members" fallback option has been completely removed from the interface.
- A recipient count verification step is shown before any campaign is sent, giving staff a clear view of exactly how many people will receive the email.

#### Layer 2: Backend Targeting Validation
- Before any campaign is sent or scheduled, the server now validates that the campaign has a valid audience configuration.
- Only approved audience types are accepted (specific lists, groups, roles, etc.). The "all members" targeting type is explicitly rejected.
- If validation fails, the send is blocked and a clear error message is returned.

#### Layer 3: API-Level Rejection
- At the lowest level of the system, the API endpoints that handle campaign creation and updates now reject any request that attempts to set "all members" as the targeting type.
- This ensures that even if a request bypasses the interface, it cannot create a campaign with unsafe targeting.

#### Layer 4: Emergency Campaign Stop
- A new "Stop Campaign" feature has been added, allowing staff to immediately halt any campaign that is currently sending or scheduled.
- When stopped, all unsent emails are cancelled and a clear summary is provided showing how many emails were already sent and how many were cancelled.
- The sending engine also checks for cancellation between each batch of emails, ensuring a stopped campaign halts as quickly as possible.

---

## Preventive Measures

| Safeguard | Description |
|-----------|-------------|
| Mandatory audience selection | Campaigns cannot be saved or sent without an explicit audience list |
| "All members" targeting removed | The option to target all members has been completely removed |
| Pre-send recipient count | Staff see the exact recipient count before confirming send |
| Server-side validation | Backend independently validates targeting before processing |
| API-level blocking | API rejects unsafe targeting configurations at the request level |
| Emergency stop capability | Active campaigns can be immediately stopped with remaining emails cancelled |
| Batch cancellation check | Sending engine verifies campaign hasn't been cancelled before each batch |

---

## Impact Assessment

- **Emails sent:** ~4,700 (intended: 3)
- **Content type:** Internal test email — no sensitive or harmful content
- **Member impact:** Members received an unexpected test email; no data exposure or security concern
- **Operational impact:** Staff time spent investigating and communicating about the incident

---

## Conclusion

This incident highlighted a gap in the campaign sending workflow where missing audience data combined with an unsafe fallback resulted in unintended mass distribution. The fix addresses every layer of the system — from the user interface through to the email sending engine — ensuring that campaigns can only be sent to explicitly selected audiences, and providing an emergency stop mechanism for additional safety.
