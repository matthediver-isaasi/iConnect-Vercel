---
name: Better Stack subhourly heartbeat timezone
description: Optional server-timezone adjustment blocks subhourly heartbeat intervals.
---

Better Stack rejects a heartbeat interval below one hour when its optional
server timezone is set. Clearing that adjustment is a distinct configuration
change requiring approval; it does not change Vercel's UTC cron schedule.

**Why:** An interval/grace-only update was rejected with HTTP 422 despite valid
interval and grace values because an existing Europe/London adjustment remained.

**How to apply:** Inspect the monitor's server timezone before proposing a
subhourly interval, include any necessary clearing in the approval, and verify
the settings with a readback. Never test by requesting the reporting URL.