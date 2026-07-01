# Plan 16 — Supabase migration + auth (Hemma·OS `web/`)

**Status:** architecture plan · **Owner model:** Opus for the schema/RLS/sync
design + the first pilot; Sonnet for the mechanical per-tool store swaps once the
pattern is proven. · **Relationship:** foundational — unlocks idea #8 (cross-tool
insights). Builds on the existing Promise-API stores. Big; **phased**.

## What this is (plain answer to "how would this work + do we need a password?")

Hemma·OS becomes a **login-gated, cloud-backed** app for a household of two. You
each **sign in with a magic link** (type your email, click the link Supabase
emails you) — **no password to create or remember.** Once in, every tool's data
lives in Supabase, scoped to your shared household, synced across all your
devices, and backed up. It still works offline: localStorage stays as a cache.

## Decisions locked (source of truth)

1. **Driver = all three** (sharing **primary**, sync + backup along for free).
   → we build a household/two-user layer + row-level security.
2. **Auth = Supabase Auth magic link** (passwordless). No username/password.
   Google OAuth can be added later if the email step annoys.
3. **Scoping = everything household-shared.** One `household`, both are members,
   **every** row carries `household_id`, **one** RLS policy app-wide. Both see all
   tools' data. (Can carve a tool back to personal later.)
4. **Sync = cloud source-of-truth + local cache**, conflicts **last-write-wins**
   by `updated_at`. Hydrate stores from Supabase on login; writes go to Supabase
   optimistically + update the localStorage cache (offline fallback). Realtime
   ("see partner's edit live") deferred to a later phase.
5. **Login-gated.** Visiting requires sign-in; RLS scopes each signer to their own
   household; you two share one. Finances never shown to an anonymous visitor.
6. **Household join = email pre-authorization.** In settings, enter partner's
   email → pending membership; they auto-join on first magic-link sign-in with
   that email. (Acceptable v1 shortcut: SQL-seed one household + both memberships
   to get the pilot live before building the invite UI.)

## Architecture

### Auth
- Supabase project; enable **Email (magic link)** provider. Default Supabase email
  is fine for two users (configure SMTP later if needed).
- Client: `@supabase/supabase-js`. `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`
  (anon key is **public by design** — safe because RLS guards every table).
  Inject at build via GitHub Actions secrets (or commit — anon key is publishable).
- A top-level `<AuthGate>` in `App.tsx`: no session → magic-link screen; session →
  the router. Session persists (Supabase stores it) → once-per-device friction.

### Household + membership (the whole multi-user model)
```sql
households            (id uuid pk, name text, created_at)
household_members     (household_id uuid fk, user_id uuid fk references auth.users,
                       role text, primary key (household_id, user_id))
household_invites     (household_id uuid fk, email text, created_at)   -- pre-auth
```
- On first sign-in: if the user's email matches a `household_invites` row → insert
  a `household_members` row, delete the invite. Else → create a household + add
  them as owner (their own private space).
- A SQL helper `current_household()` returns the caller's household_id (from
  `household_members` where `user_id = auth.uid()`), used by every RLS policy.

### RLS — one policy shape, every table
Every data table gets a `household_id uuid not null` column and:
```sql
alter table <t> enable row level security;
create policy hh_all on <t> for all
  using   (household_id = current_household())
  with check (household_id = current_household());
```
So a user can only read/write rows of the household they belong to. That single
shape covers all tools (Decision 3).

### Data tables (mirror the existing snake_case store rows)
One table per data type; add `id uuid default gen_random_uuid()`, `household_id`,
`updated_at timestamptz default now()` (for last-write-wins) to each:
- `salary_submissions` (salary-store — already 1:1 shaped, ready)
- `monthend_items`, `monthend_payments`, `monthend_settings` (manadsavslut-store)
- `mortgage_loan_parts` (+ the rest of mortgage-store's shapes)
- `scenarios` (Bostadskalkyl — from `useStore`)
- `budget_state` (Hushållsbudget — needs a shape decision: one JSON blob row vs
  normalized; blob is the cheap port of `loadBudget()`/`saveBudget()`)
- (Konsultkalkyl / Löneväxling persist a single settings blob each → one row.)

### Store-swap pattern (the migration mechanics)
The async Promise-API stores (**salary**, **manadsavslut**, **mortgage**) are
"swap one file": replace `_read`/`_write` localStorage calls with Supabase
queries; keep the exported `list/add/remove/update` signatures so **call sites
don't change**. Add an `updated_at` stamp on writes; keep a localStorage
write-through cache for offline.

The **synchronous** stores need a small refactor first:
- `hushallsbudget-store` (`loadBudget()`/`saveBudget()` sync) → Promise API.
- `useStore` (Zustand, Bostadskalkyl scenarios) → async hydrate + persisted
  middleware pointed at Supabase.

### First-login data migration
On the first authenticated load, read existing `bostadskalkyl_*` localStorage
rows and **upsert** them to Supabase stamped with `household_id` (idempotent by
`id` — the stores already client-generate UUIDs and `importJSON` dedupes). One-
time "import your local data" so nothing is lost in the cutover.

## Phasing (don't migrate all at once)
1. **Phase A — foundation + pilot.** Supabase project, auth gate, household tables
   + RLS, `current_household()`, and migrate **one** tool end-to-end:
   **`salary-store`** (smallest, append-only, already perfectly shaped). Prove
   auth → household → RLS → cloud CRUD → local-cache → first-login import.
2. **Phase B — the couple flagship.** Migrate **Månadsavslut** (most shared value)
   + **Hushållsbudget** (after the sync→async refactor).
3. **Phase C — the rest.** Bolånekoll, Bostadskalkyl scenarios, Konsult,
   Löneväxling.
4. **Phase D — invite UI** (email pre-authorization screen) replacing the seed;
   optional **Realtime** on the couple tools.

## Env / deploy
- `.env.local` (gitignored) for dev; GitHub Actions secret(s) for the build step
  in `deploy.yml` (or commit the anon key — publishable). No server needed; the
  SPA talks to Supabase directly. Pages hosting unchanged.

## Risks / watch-list
- **RLS correctness is the whole security model** — test that user B cannot read
  household A's rows *before* putting real data in. Write a couple of policy tests.
- **Anon key in a public bundle** is expected; never ship the **service-role** key.
- **Last-write-wins** can lose a field if both edit the same row offline — fine for
  two people; documented, not solved.
- **Magic-link email deliverability** on the free tier (rate limits) — fine for
  two; revisit with SMTP if needed.
- Synchronous-store refactor (budget, scenarios) is the riskiest code change —
  keep it behind the existing store API and test.

## Definition of done (per phase)
- **A:** sign in via magic link on two devices; salary log syncs between them;
  user B (different email, own household) cannot see your data (RLS verified);
  existing local salary history imported once; offline still renders from cache.
- **B/C:** each migrated tool reads/writes Supabase, syncs across devices, shares
  across the two of you; `build`/`oxlint`/`vitest` green; offline fallback works.
- **D:** partner self-joins via email pre-auth; (optional) realtime updates.
