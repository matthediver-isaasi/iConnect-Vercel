# BNMS direct workforce import — final review package

This is the only current generated review package:
`reports/bnms-workforce-direct-import-preparation-v3/`.

Its SQL remains review-only. No destination database importer was installed and
no destination bulk import was run. The associated opt-in PostgreSQL runtime
test used only a disposable synthetic `/tmp` cluster; it is not destination
execution or production trigger/permission/lock parity evidence.

Earlier `bnms-workforce-direct-import-preparation` and `...-v2` directories are
preserved historical artifacts and explicitly superseded. Review hashes from
this directory's `review.json` only.