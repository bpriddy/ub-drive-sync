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

## Ops step, separate from this stage: widening the Activity seed

NOT part of this change and not run by it. Today `seed-edit-stats` covers about
one year back in 30-day windows, writes each window under a random run id (a
second seed over overlapping windows double-counts) and dates rows by the
window end. To reach the real horizon (drive age) an ops step needs a new,
reviewed mode of its own. Outline:

1. `seed-edit-stats --account-id X --from YYYY-MM-DD --to YYYY-MM-DD
[--window-days N] [--confirm]`; without `--confirm` it only lists the windows
   and the number of Activity API calls it would make (dry-run is the default).
2. Idempotent: the synthetic run id of a window is deterministic (a hash of
   account, from, to), so a re-run replaces exactly its own rows
   (`writeRunEditStats` already replaces by run id).
3. Resumable: windows run oldest to newest and commit one at a time; a re-run
   skips nothing and repeats nothing wrongly, since each window replaces itself.
4. `--to` is the start of the earliest existing seed window, so no event is
   counted twice at the boundary.
5. Smaller windows (for example 7 days [ASSUME]) give a tighter date bound for
   the same evidence, at proportionally more calls.
6. Estimate: Activity calls = windows x (1 + extra result pages); for an
   account whose seed starts about 14 months ago and whose drive is 2.4 years
   old, about 15 windows of 30 days or about 64 of 7 days (derived from those
   two ages), pages per window [MEASURE: dry-run]. People API calls = new
   distinct unresolved actors the cache lacks [MEASURE: dry-run], by the
   directory bot, paced.
