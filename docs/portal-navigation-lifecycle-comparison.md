# Task 4666: matched portal lifecycle comparison

## Method and boundary

This benchmark ran both variants against the same already-running development
preview, Chromium executable, viewport, real router/UI code, and controlled API
fixture. Critical authentication, role, page, branding, and visibility
responses used the same 200 ms delay. Vite transforms were warmed before
measurement, and each variant ran three times in a fresh browser context.

The **original lifecycle** was restored only in the browser's transformed
modules. The fixture asserted that each source replacement matched exactly
once, then restored:

- pathname in `getViewerSessionScope`;
- `location.pathname` in Layout's session-scope call; and
- `location.pathname` in Layout's authentication-effect dependencies.

No application source was changed for the original run, and both variants used
the current checkout for everything outside that lifecycle. This isolates the
navigation reset mechanism; it is not a full historical-revision or production
benchmark. API calls were intercepted, no tenant data was read or mutated, and
the local preview's unresolved tenant does not affect these fixture results.

Command:

```sh
npx playwright test --config=tests/portal-lifecycle-comparison.config.mjs
```

Raw results, including all three runs, are stored at
`tests/task-4666-portal-lifecycle-comparison.json`.

## Median results

| Step | Original visible | Current visible | Original auth / role | Current auth / role | Original loading appearances | Current loading appearances |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold document | 4,171 ms | 4,671 ms | 1 / 1 | 1 / 1 | 0 | 0 |
| Same-context reload | 4,872 ms | 4,663 ms | 1 / 1 | 1 / 1 | 0 | 0 |
| Navigate forward | 1,504 ms | 971 ms | 1 / 1 | 0 / 0 | 0 | 0 |
| Browser back | 1,485 ms | 978 ms | 1 / 1 | 0 / 0 | 0 | 0 |
| Browser forward | 1,508 ms | 969 ms | 1 / 1 | 0 / 0 | 0 | 0 |

Cold-document and reload request counts are intentionally unchanged: a new
document must validate the session. Their development timings varied between
runs, so no cold-start speed claim is made.

For every measured internal, back, and forward transition, the current
lifecycle removed one authentication request and one role request. The portal
shell remained mounted and produced **zero full-screen `Loading portal…`
appearances** on every current internal, back, and forward run. The original
lifecycle also kept the shell visible after the final shell/content separation,
but still repeated authentication and role work. Median transition time fell
by 507-539 ms in this controlled fixture.

The benchmark test fails if the original lifecycle is not installed exactly or
if any current navigation transition issues an authentication request or shows
the full-screen portal-loading fallback.