---
name: Router consistency in client/
description: The client app uses react-router-dom; pages built with wouter look like they navigate but silently break SPA routing.
---

# Router consistency in client/

The app's real router is **react-router-dom** — routes are declared in `client/src/pages/index.jsx` with `<BrowserRouter>` + `<Routes>` + `<Route element=…>`. New pages MUST use `react-router-dom` hooks (`useNavigate`, `useSearchParams`, `useParams`, `useLocation`, `<Link to=…>`).

**Why:** wouter and react-router-dom both rely on `window.history`, but they don't share state. wouter's `navigate()` patches `history.pushState` and notifies its own hooks — react-router-dom doesn't see it. Result: the URL bar changes, wouter-side hooks update, but react-router-dom keeps the previous route mounted (or doesn't mount the new one). Symptoms reported by the user: "URL changes but page doesn't update", "back button doesn't work", "only a hard refresh shows the right page". This has now bitten us at least twice on different pages — recognise it immediately.

**How to apply:**
- When creating or reviewing any new page under `client/src/pages/`, grep for `from "wouter"` and replace with `react-router-dom` equivalents.
- `<Link href=…>` (wouter) → `<Link to=…>` (react-router-dom).
- `const [, navigate] = useLocation()` (wouter) → `const navigate = useNavigate()`.
- Query params: use `const [searchParams] = useSearchParams()` and `searchParams.get("id")` — do NOT read `window.location.search` inside a `useMemo([], …)`; that captures once at mount and never updates on navigation.
- A handful of legacy pages still import wouter (`MyOrganisation.jsx`, `Login.jsx` as of writing) — they work today because they don't navigate between same-component-mount routes, but they're landmines. Migrate opportunistically when touching them.
