---
name: Vercel runtime log access
description: Distinguish live streaming from historical request logs when diagnosing deployed failures.
---

The Vercel deployment runtime-log endpoint streams new events; it is not evidence about an earlier incident. An empty stream does not establish that no earlier request occurred.

**Why:** An incident investigation received only new traffic and the stream's five-minute duration-limit message. The current Vercel CLI's historical request-log implementation uses vercel.com, whereas this workspace's connector proxy is scoped to api.vercel.com.

**How to apply:** Check current provider documentation and connector capabilities before requesting logs. Use a bounded historical query when supported; otherwise request the relevant dashboard log entry rather than waiting on live streams or treating empty build-event results as historical runtime evidence.