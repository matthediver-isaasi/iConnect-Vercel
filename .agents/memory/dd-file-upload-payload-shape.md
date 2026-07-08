---
name: DD file-upload payload shape
description: Form file-upload values store a RELATIVE secure-url and a storage_path WITHOUT a bucket key — consumers must parse bucket/path out of the secure-url query string.
---

# DD file-upload payload shape

Form-submission file-upload values (e.g. DD "Organisation Logo") are stored as:

```json
{
  "file_url": "/api/storage/secure-url?bucket=private-uploads&path=<urlencoded>&redirect=true",
  "file_name": "Logo.png",
  "file_size": 12345,
  "mime_type": "image/png",
  "storage_path": "<tenant>/form-submissions/<form>/<file>"
}
```

**The rule:** any consumer that needs a real URL or bucket/path from these payloads must parse `bucket` + `path` out of the `/api/storage/secure-url` query string. Do NOT assume `bucket` exists as a top-level key (it usually doesn't) or that `file_url` is absolute (it's relative).

**Why:** the DD stage field-mapping `logo_url` resolution silently produced nothing for ~23 GSF orgs because it required `storage_path && bucket` together and only accepted `http…` direct URLs — the payload matched neither shape.

**How to apply:** the fixed `extractLogoFileMetadata`/`parseSecureStorageUrl` in `api/due-diligence/_stageActions.js` is the reference; `scripts/backfill-gsf-org-logos-from-dd.mjs` mirrors it and shows the private→public bucket copy pattern for making such files publicly linkable.
