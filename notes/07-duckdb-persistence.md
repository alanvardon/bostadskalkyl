# DuckDB for persisting scenarios

**Verdict:** Skip for now. Solves a problem the app doesn't have yet.

## What we have

Five localStorage keys hold all state:
- `bostadskalkyl_scenarios` — saved scenarios
- `bostadskalkyl_session` — current session
- `bostadskalkyl_drift_items` — drift line items
- `bostadskalkyl_drift_yearly` — toggle
- `bostadskalkyl_savings_items` — savings entries

Total payload is tiny (a few KB per user) and the access pattern is
"load all on boot, write on change." No query workload exists.

## What DuckDB would buy

DuckDB (via duckdb-wasm in the browser) is a columnar analytical engine.
It shines when you want to:
- run SQL over thousands of rows
- aggregate / pivot historical scenario data
- import CSVs (e.g. SCB property statistics)

None of those use cases exist today. The current state is a handful of
JSON blobs; SQL would be overkill.

## When this *would* become worth it

- **Scenario history over time** — every save creates a new row, you
  want to see "how did my LTV projection drift across 18 months."
  Trends + aggregates → DuckDB starts to make sense.
- **External datasets** — load Boverket / SCB / bolåneräntor history,
  join against your scenarios to compare against market benchmarks.
- **Multi-property tracking** — the app evolves from "one purchase
  decision" into a small portfolio tracker.

Until one of those is a real ask, JSON-in-localStorage is the right
shape.

## Tradeoffs / risks if we did it

- **+1MB+ wasm bundle** — kills the "open the file, no internet
  required" property unless cached.
- **localStorage is synchronous; duckdb-wasm is async** — every site
  that reads state has to become `await`-y. Non-trivial refactor.
- **Migration story** — existing scenarios need a one-time port from
  localStorage → DuckDB tables.

## Rough plan (if revisited)

1. Define the *specific* query that JSON can't serve cleanly
2. Decide persistence target: duckdb-wasm in IndexedDB (browser-local)
   vs. a server-hosted DuckDB (requires hosting — see [[09-remote-sharing]])
3. Add a thin DAL so the rest of the app doesn't care which backend it's
   talking to
4. Backfill from localStorage on first load

## Related

- [[09-remote-sharing]] — if data ever needs to be remote, the backend
  question and this question converge
