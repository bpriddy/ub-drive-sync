# Casting T2: Drive Activity evidence

Stage entry: `src/casting/t2/main.ts` (standalone, not wired into `src/main.ts`).

```
node dist/src/casting/t2/main.js --account-id <uuid>          # dry-run, writes nothing
node dist/src/casting/t2/main.js --account-id <uuid> --apply  # writes evidence + a sync_runs row
```

Flags: `--account-id` (repeatable, required), `--apply`, `--resume-run-id` (needs
`--apply`), `--chunk-size`, `--window-start <date|none>`, `--budget-seconds`,
`--agency-domain` (or `CASTING_AGENCY_EMAIL_DOMAINS`), `--unknown-start-date`
(repeatable; a `staff.started_at` value that is an import placeholder).

## What it does

Reads `drive_edit_stats` month by month and emits Layer 1 `evidence` rows with
`source = 'drive_activity'`, `extractor_version = 't2-activity-v1'`,
`sync_runs.source = 'casting_t2'`.

- **One row per (file, actor email, calendar month)**, closed months only (the
  month of the run date is open and picked up by a later run).
- **Idempotency key:** `(extractor_version, claim_hash)`; the hash covers source,
  file, `activity:YYYY-MM`, the actor email and the project reference. Edit and
  day counts are audit text in `location` and are not in the hash: a re-run
  inserts nothing, and more edits in an emitted month change nothing.
- **File to project** is resolved at query time from the Drive index and the
  accounts database (strict or variant bracket job code, then the index's
  campaign attribution). Nothing is stored in the edit stats. No project, no row.
- **Actor to email:** an email is used as is; `people/<id>` goes through the
  `people_resource_map` cache only. This stage never calls the People API.
  Unresolved actors are counted per account and year (rows, edits, unique
  actors) and are not emitted; a later run emits them once the cache knows them.
- **Person:** the S3 resolver (`src/casting/identity`, public index only), with
  the employment-window gate evaluated on the group's last stats day.
- Role, seniority and quote are NULL. Confidence is an `[ASSUME]` placeholder
  (0.10 to 0.18); a single T2 row never nears the 0.7 serving threshold. T2
  corroborates T3, it proves nothing alone.

## Limits to keep in mind

- `drive_edit_stats.day` is the day of the RUN that counted the edits, not the
  edit day: a daily forward run dates its window with its own day, a seed window
  (30 days) is dated by its end. Months are therefore bounds, off by up to the
  run's window.
- Events exist only from where the Activity seed starts. Migrated or imported
  content has no events (the import is not the original work).
- Only accounts with a configured Drive root have an index and edit stats.
- Unresolved `people/<id>` actors are a large class (deleted or external people
  and a cold cache). Read the per-year counters before reading absence as a
  finding.

## Deploy order (the P2022 trap)

Dry-run reads only tables that exist today. `--apply` needs the UB migration that
creates `evidence` (gub-schemas 1.23.0): before it, apply fails with Postgres
42P01 on purpose. Apply the migration to the environment, then run.

## Ops step, separate from this stage: Activity edit-stats backfill

Code: `src/casting/t2/backfill/` (own entrypoint `main.js`; not wired into
`src/main.ts`; nothing in `src/forward/` was changed). Implemented, NOT run. It
writes `drive_edit_stats` from Drive Activity, so it needs the user's separate go.

```
node dist/src/casting/t2/backfill/main.js --account-id <uuid> --from YYYY-MM-DD --to YYYY-MM-DD \
  [--window-days N] [--confirm] [--resume-run-id <uuid> --confirm]
  [--budget-seconds N] [--max-calls N] [--existing-window-days N]
```

- **Dry-run by default.** It reads the existing edit-stats run ids and the
  account's Drive root, then prints the windows (index, start, end, day, run id),
  the overlap verdict and the call estimate. No Drive, People or model call, no
  write, no `sync_runs` row. `--confirm` is required to fetch and write.
- **Windows** are contiguous, oldest to newest, half-open (start, end] at
  00:00:00Z; the last one may be shorter. `--window-days` is 1 to 30, default 30.
- **Run id per window** is a deterministic name-based UUID over account and window
  bounds. The writer is the existing `writeRunEditStats`, which deletes every row
  of a run id and re-creates it in one transaction, so a retry replaces only its
  own rows and cannot double anything.
- **One commit per window**, progress in a `sync_runs` row (source
  `drive_edit_stats_backfill`, checkpoint = next window; resume with
  `--resume-run-id`). `--budget-seconds` and `--max-calls` stop after the window
  that crosses the budget (never after the last one) and exit with code 75; exit 1
  is a failure or an overlap refusal. `--max-calls` counts the calls the Activity
  adapter reports; the client pages internally, so the adapter reports
  `max(1, ceil(events / 500))` per window, a proxy rather than an exact count.
- **Dates.** `drive_edit_stats.day` is run-date framing: the rows of a backfilled
  window are dated by the window END, as the seed does. T2 reads months, so an
  edit can land in the month of the window end instead of its own: the error is
  up to the window length. The default 30 is the cheapest; 7 tightens the bound
  to a week at about 4x the windows (15 vs 64 for a 450-day range, derived from
  the ages above) and so about 4x the calls. Recommended: 7 when the evidence
  month matters, 30 for a first coverage pass.
- **Calls.** `windows x (1 + extraPagesPerWindow)`, one Activity page holds up to
  500 activities. Extra pages per window are unknown until windows are fetched
  `[MEASURE: first confirmed windows]`; the dry-run prints the floor (one call per
  window) and `[ASSUME]` scenarios only. People API calls: 0, always.

### Overlap protection (a hard error)

`drive_edit_stats` is keyed by (sync_run_id, file_id, actor_email) and readers sum
rows across run ids. The existing `seed-edit-stats` gives each of its windows a
RANDOM run id, so a second seed over windows that overlap an earlier one (or a
forward run) replaces nothing: it adds a second copy of the same events and every
counter doubles. The table does not record which time range a run covered.

The backfill reads every run id of the account through an injected reader and
refuses, before anything else (in dry-run too), any planned window that
intersects an existing run. An existing run covers (minDay - span, maxDay], where
`span` is the longest window it can have: 30 days by default (the existing seed's
window and this command's cap), `--existing-window-days` lowers it for earlier
backfills run with shorter windows. The only exemptions are the plan's own run
ids (retry and resume). Consequently `--to` must not be later than the start of
the earliest existing seed window: the earliest existing day minus the span; the
refusal message prints that date. A gap of under one day can stay uncovered at
that edge (old windows start at a time of day, new ones at 00:00:00Z): that
undercounts, it never double-counts. A second backfill over the same range with a
different `--window-days` is refused for the same reason.

### Actors

The backfill never calls the People API. It maps `people/<id>` through the
`people_resource_map` cache and otherwise stores the raw resource, exactly as
`writeRunEditStats` does. Resolution happens later in existing code:
`src/forward/people.ts` (`resolveActors`, directory bot, People API), called by
the forward driver and by `seed-edit-stats` for the actors of the window they
process; the T2 stage then reads the cache at emission time, so an actor resolved
later is emitted by the next T2 run. Actors that appear only in backfilled
history stay `people/<id>` until something resolves them: a cache-filling pass
over the unresolved resources is a further ops step that is not built.

### Estimate for planning

For an account whose seed starts about 14 months ago and whose drive is 2.4 years
old: about 450 uncovered days, so about 15 windows of 30 days or 64 of 7
(floor: one call per window), extra pages `[MEASURE: first confirmed windows]`.
