# Spec — FR-ENT-01..05 — Entities, resolution and watchlists (Phase 3)

| | |
|---|---|
| Phase | 03 — Entities & Watchlists (`PROJECT.md` §11) |
| Owner runtime(s) | `services/registry`, gateway routes `/v1/entities*`, `/v1/watchlists*` |
| Status | INTEGRATION-VERIFIED + E2E through the gateway (2026-11-24); seed runtime-verified |
| Related | ADR-0016 (RLS), ADR-0010; NFR-06 |

## 1. Requirement
`PROJECT.md` §2.3 FR-ENT-01..05 (verbatim there). Migrations are **V7/V8**: V6 became `auth` in the approved Phase 2 renumbering, so Phase 3 moves up by one (clarification).

## 2. Behavior
### Normalization (FR-ENT-01; `domain/EntityNames`, fixture table test)
1. Unicode NFKC, then lower-case (ROOT locale).
2. Dots and apostrophes are deleted (`S.A.` → `sa`). Every other run of characters that is not a letter or digit becomes one space; trim.
3. Strip trailing legal-suffix tokens repeatedly: `inc corp llc ltd plc holdings group sa ag nv`. At least one token is always kept, so `Group` alone stays `group`.

Examples: `ACME Holdings, Inc.` → `acme`; `Globex Clearing S.A.` → `globex clearing`; `Umbrella Pharma AG` → `umbrella pharma`.

Aliases use the same function.

### Entities (FR-ENT-01/02)
- **create** (ANALYST, TENANT_ADMIN, or PLATFORM_ADMIN via `X-Aegis-Tenant`):
  - A duplicate normalized name among non-archived entities → `409 ENTITY_DUPLICATE`.
  - A duplicate normalized alias → `409 ENTITY_DUPLICATE`.
  - Emits `registry.entity.changed{entityId, changedFields:["created"]}`.
- **get** (VIEWER+): `EntityDetail` = entity + aliases + the non-deleted watchlists that contain it. Archived entities are still readable, because historical cases reference them.
- **list** (VIEWER+): filters `entityType`, `watchlistId`, `q`. Archived entities are excluded.
  - Without `q`: keyset pagination on `(created_at, id)`.
  - With `q`: the top `limit` entities by trigram similarity of `q`'s normalized form against the name or an alias, ties by id. It is a single ranked page with no `nextCursor`.
- **update** (ANALYST+): name (re-normalized; duplicate → 409), entityType, ticker/lei/country (null clears), `addAliases`, `removeAliases`. `changedFields` lists the real changes; a no-op emits nothing.
- **archive** (TENANT_ADMIN): sets `archived_at`, emits `["archivedAt"]`, and is idempotent. Archived entities stop matching (resolution, watchlist checks).

### Resolution (FR-ENT-03, SERVICE callers with `registry.resolveEntities`)
- One result per mention (in input order), then one per entry of `tickers[]`. Every query is scoped to the tenant and excludes archived entities.
- **Stages,** applied to mentions still unresolved, one batched SQL per stage over `unnest(text[])`:
  1. `TICKER_EXACT`: the mention or ticker equals `entities.ticker`. Similarity 1.
  2. `ALIAS_EXACT`: normalized mention = `normalized_alias`. Similarity 1.
  3. `NAME_NORMALIZED`: normalized mention = `normalized_name`. Similarity 1.
  4. `TRIGRAM`: best of `similarity(normalized_name, m)` and `similarity(normalized_alias, m)` ≥ 0.85, using `pg_trgm.similarity_threshold = 0.85` (GIN trigram indexes); ties by entity id.
- Unmatched → `entityId = null`, `matchType = null`, `similarity = null`.
- Deterministic for identical inputs.

### Watchlists (FR-ENT-04/05)
- **create** (ANALYST+):
  - The name is unique per tenant, case-insensitive, among non-deleted lists → `409 WATCHLIST_NAME_TAKEN`.
  - Defaults: `severityFloor HIGH`, status `ACTIVE`.
  - Emits `registry.watchlist.changed{watchlistId, changedFields:["created"]}`.
- **list** (VIEWER+): keyset pagination with `entryCount`.
- **update** (ANALYST+): name, reason, severityFloor, status (`PAUSED` pauses it).
- **delete** (TENANT_ADMIN): soft delete (`deleted_at`). Returns `{}`.
- **add entry** (ANALYST+):
  - The watchlist must exist and not be deleted, and the entity must exist and not be archived; otherwise 404.
  - Adding an entry that already exists updates its note.
  - Emits `["entries"]`.
- **remove entry**: 404 if absent; emits `["entries"]`.
- **checkWatchlists** (SERVICE callers with `registry.checkWatchlists`):
  - It returns hits from **ACTIVE**, non-deleted watchlists for non-archived entities, in a deterministic order (watchlist name, entity id).
  - For `entityIds`, each id is checked directly.
  - For `counterpartyRefs`, each ref is resolved (FR-ENT-03) from `counterpartyName`, or from `counterpartyId` when there is no name. A hit carries the ref's `counterpartyId`.

### Authorization
`AccessPolicy` gains the Phase 3 rows. They are exactly the contract's `x-aegis-roles`, and `AccessPolicyTest` keeps them equal.
- `resolveEntities` and `checkWatchlists` are SERVICE-only (act[]); user tokens get 403.
- `archiveEntity` and `deleteWatchlist` are TENANT_ADMIN-only, as in the contract.

## 3. Data
- **`V7__entities.sql`:** `entities` and `entity_aliases` as §7.1, with RLS, `set_updated_at`, and `public.gin_trgm_ops` indexes.
- **`V8__watchlists.sql`:** `watchlists` and `watchlist_entries` as §7.1, with RLS.

## 4. Tests
| Level | Test | Proves |
|---|---|---|
| Unit | `EntityNamesTest` (fixtures) | normalization table incl. suffix stripping |
| Unit | `AccessPolicyTest` | Phase 3 rows = contract |
| Integration | `EntityIT` | create/dup 409/alias dup/get detail/list q + filters/update/archive excluded from matching; events |
| Integration | `ResolutionIT` | golden mention → entity fixtures across all 4 stages; determinism; p95 ≤ 50 ms for 50 mentions |
| Integration | `WatchlistIT` | CRUD, name 409, entries, paused yields no hits, deleted entry stops matching, counterparty refs, cross-tenant 404 |
| E2E | role matrix + cross-tenant suite extended to Phase 3 routes |
| Runtime | `make seed` (demo entities/watchlists via the API, §1.4.7) |
