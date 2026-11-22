---
name: frontend-engineer
description: AegisPulse frontend role for apps/console (React 19 + Vite + TypeScript). Use when building console routes/features (auth, live pipeline SSE dashboard, cases, events explorer with severity lineage, file upload with client-side SHA-256, admin screens, intelligence charts), API client code, accessibility (WCAG 2.2 AA), responsive layout, or Playwright tests.
---

# Frontend Engineer — AegisPulse Console

Source of truth: `PROJECT.md` §2.20 (FR-FE-01..08), §8 (public API and errors), §6.3 (stack), NFR-16, Phase 19.

## Stack & structure
React 19 · Vite · TypeScript strict · TanStack Router (typed routes, URL-synced filters) · TanStack Query (server state) · Zustand (session only) · Tailwind + Radix primitives · Recharts · `@microsoft/fetch-event-source` (SSE with an Authorization header).
```
apps/console/src/
  routes/            # route tree, guards per role
  features/{auth,dashboard,cases,events,files,admin,intel}/  # components + hooks + api per feature
  api/               # generated types from gateway.public.yaml + thin fetch client (error envelope mapping)
  stream/            # SSE client, reconnect + REST resync
  components/        # shared accessible primitives
```

## Rules
- The console calls **only** the gateway (`PUBLIC_API_URL`). Types are generated from `packages/contracts/openapi/gateway.public.yaml`, never hand-written.
- The UI holds no business rules. Show server decisions (policy factors, lineage) and don't recompute them. Client-side checks are UX hints, and the server enforces.
- Role-gated navigation is cosmetic. Every protected screen must handle 403 and 404 gracefully.
- The access token lives in memory, and the refresh flow is per FR-AUTH-02. Never put tokens in localStorage or in URLs.
- Uploads: stream the SHA-256 via Web Crypto (chunked), then init → PUT to the presigned URL with the exact `Content-Type` → complete. Show the dedup result.
- SSE: on reconnect, refetch the visible queries (best-effort gap fill per FR-SSE-02).
- Errors: map `error.code` (§8.4) to human messages, and always show `requestId` for support.
- No `dangerouslySetInnerHTML`. Event payload previews render as escaped text or JSON viewers.
- The CSP-compatible build has no inline scripts. Assets are served by `nginx-unprivileged` with security headers.

## Severity lineage view (FR-FE-04)
Show `publisher_stated_severity` → `algorithm_severity` (source and version, confidence) → `final_severity`, then a `classificationHistory` table (stage, version, confidence, actor, justification). Overrides require a justification of at least 20 characters, and the form displays the elevate-only rule.

## Accessibility & responsive (NFR-16)
WCAG 2.2 AA: keyboard reachable, visible focus, labelled controls, 4.5:1 contrast, `aria-live` for streaming feeds (polite, throttled), and charts with table alternatives. Layouts work down to 360 px. Light and dark themes.

## Tests
Vitest for hooks and components. Playwright E2E per FR-FE item against compose (dev full, prod smoke), with axe-core checks that allow zero serious or critical violations. Name tests with FR ids.
