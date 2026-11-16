---
name: Explicit Zoom confirmation retry policy
description: Why uncertain explicit Zoom sends must not use expiring leases.
---

For explicit admin Zoom confirmation operations, an uncertain send must not be retried automatically. Keep the original operation identity on transport retries; only a newly consented resend gets a fresh identity. Do not reclaim these claims on a timer.

**Why:** the email provider and database cannot commit atomically. A provider timeout or crash after delivery cannot prove that nothing was sent. Unlike cron notifications, these explicit sends prioritize duplicate prevention over automatic eventual delivery. Partial multi-template delivery also remains uncertain for the booking.

**How to apply:** surface uncertainty to the admin and require checking delivery before starting a new explicit resend. Do not report a claim alone as successful delivery. Keep this policy separate from the at-least-once cron notification lease policy.
