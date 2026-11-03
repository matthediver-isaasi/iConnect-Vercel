---
name: Validation registration and startup
description: Workflow registration can accidentally add checks to the default Run action.
---

After registering a named validation, verify that the default Project workflow
still starts only the application. Register checks through the project's isolated
regression-suite entry point rather than an arbitrary compound shell command.

**Why:** Validation registration on 2026-11-03 automatically added the new check
to Project's parallel startup, failing the project's startup safety contract.

**How to apply:** Register the suite and any disposable-PostgreSQL permission,
then remove accidental startup dependencies through validated workflow
configuration. Do not weaken the startup safety tests.
