# Sharing access with partner remotely

**Goal:** Shared live state — both of us see and edit the same
scenarios from our own devices, with changes syncing between browsers.

## What this means

- Single source of truth for scenarios, drift items, savings entries,
  and current session state
- Either partner opens the app on their own device and sees the *same*
  numbers as the other
- Edits propagate without a manual refresh
- Data scoped to our household — no one else can read or write it

## Stack: Supabase

- Postgres for storage
- Supabase Auth for sign-in (magic links, no password to manage)
- Realtime subscriptions for live sync
- Row-level security to scope data to the household

Existing localStorage shape (a handful of JSON blobs) maps cleanly to a
single `scenarios` table keyed by household. Free tier (500MB DB, 2GB
egress) is far more than this app will ever need.

Converges with [[07-duckdb-persistence]] — persistence backend and
sharing backend are the same question; Postgres answers both.

## Data model

```
households (id, created_at)
household_members (household_id, user_id, role)
scenarios (id, household_id, name, payload_json, updated_at, updated_by)
drift_items (id, household_id, label, amount, period)
savings_items (id, household_id, label, amount, date)
session_state (household_id, payload_json, updated_at)
```

`payload_json` mirrors the current localStorage blobs so the migration
is "lift the JSON, attach a household_id." Schema can normalise later
if querying inside the payload becomes a need.

## Auth flow

1. Magic-link email sign-in
2. First sign-in creates a household and adds the user as owner
3. Owner invites partner by email → row in `household_members`
4. RLS policy: `auth.uid() IN (SELECT user_id FROM household_members
   WHERE household_id = row.household_id)`

## Sync + conflict resolution

- Subscribe to `scenarios` and `session_state` changes for the active
  household
- Last-write-wins on `updated_at` — fine for a two-person household;
  real conflict resolution is overkill
- Optimistic local writes + reconcile on subscription event keeps the
  UI snappy

## Tradeoffs / risks

- **Async everywhere.** localStorage is synchronous; Supabase is not.
  `calc()` stays sync (it's pure), but every save/restore path becomes
  `await`-y. A thin DAL absorbs this — the rest of the app shouldn't
  care.
- **Network dependency.** No more "open the file offline." Mitigation:
  cache last-known state in localStorage and treat Supabase as the
  source of truth when online.
- **RLS must be airtight.** The anon key ships to the client (fine, by
  design), so RLS policies are the only thing between household A and
  household B. Test them deliberately.
- **Vendor lock-in is bounded.** Postgres under the hood; worst case
  is a `pg_dump` and a move.

## Rough plan

1. Sketch the schema + RLS policies in a scratch Supabase project
2. Add a thin async DAL (`db.loadScenarios()`, `db.saveScenario()`,
   etc.) that the rest of the app talks to
3. Wire magic-link auth + household creation/invite flow
4. Migrate save/restore call sites to the DAL
5. Add realtime subscriptions for `scenarios` + `session_state`
6. One-time migration: on first sign-in, upload existing localStorage
   blobs to the new household
7. Keep localStorage as an offline cache, not the source of truth

## Related

- [[07-duckdb-persistence]] — same backend question from the
  persistence angle; Postgres answers both
- [[10-refactor-out-of-single-html]] — async DAL lands cleaner if the
  app is already modular
