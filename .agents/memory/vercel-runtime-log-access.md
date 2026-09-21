---
name: Vercel runtime log access
description: Distinguish historical logs from streams and diagnose Vercel API access according to token scope.
---

The Vercel deployment runtime-log endpoint streams new events; it is not evidence about an earlier incident. An empty stream does not establish that no earlier request occurred.

**Why:** An incident investigation received only new traffic and the stream's five-minute duration-limit message. The current Vercel CLI's historical request-log implementation uses vercel.com, whereas this workspace's connector proxy is scoped to api.vercel.com.

**How to apply:** Check current provider documentation and connector capabilities before requesting logs. Use a bounded historical query when supported; otherwise request the relevant dashboard log entry rather than waiting on live streams or treating empty build-event results as historical runtime evidence.

**Scoped-token authentication:** Project-scoped Vercel tokens legitimately deny user/team endpoints. Their HTTP 403 responses are not evidence that a token is invalid or lacks project access. The wrong inference comes from treating identity discovery as a universal authentication test despite Vercel's scoped-token contract. Before asking for a replacement, test the exact project with the correct scope: full-account tokens require the owning `teamId` for team resources; team/project-scoped tokens infer scope. Consult current official access-token documentation and distinguish request/runtime failures from credential validity.