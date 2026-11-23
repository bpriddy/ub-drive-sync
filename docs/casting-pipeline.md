# Casting pipeline: `casting-run`, one command for a full run of one account

Entry: `src/casting/run-all/main.ts` (`npm run casting-run -- ...`, or `node dist/src/casting/run-all/main.js ...`).
Local only in v1 (see "Where it runs"). It is an orchestrator over the existing stages: it adds no stage
logic and writes nothing to the database itself.

## 1. What it replaces

```
T1 metadata evidence -> T2 activity evidence -> T3 model run (paid, ledger only)
  -> T3 ledger loader (Layer 1 rows) -> fusion rebuild (Layer 2) -> UB endpoint reads Layer 2
```

By hand, each stage is a separate CLI with its own copy of the flags. Hazards removed: a flag typed
differently per stage (the pilot reads agency domains only from the env, the loader takes
`--agency-domain`); a window start that differs between stages; T3 started although T1/T2 failed; two paid
runs over the same account and configuration into two ledger dirs (the model is paid twice, the loader
dedupes only afterwards); a silent mock model client.

## 2. Usage

```
casting-run --account-id UUID --window-start YYYY-MM-DD --sample-size N --sample-seed S   # PLAN
            [--stages t1,t2,t3,load,fusion]            default all five; the order is fixed
            [--apply]                                  free writes: t1, t2, load, fusion
            [--apply-t3 --max-cells N --max-usd X --ledger-dir /abs --expect-cells N]   # PAID
            [--allow-repeat-paid]                      only with --apply-t3
            [--model M --thinking L --variant V --parallel 1|2 --read-text --retry-failed]
            [--agency-domain D ...] [--unknown-start-date YYYY-MM-DD ...] [--known-prefix P ...]
            [--budget-seconds N] [--chunk-size N] [--resume t1=<run-id>,t2=<run-id>]
            [--incremental] [--window-years N]         S9, see section 7
```

| Flags                 | What happens                                                                                                                                                                          | Exit |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| none                  | PLAN: every stage in its own dry-run; T3 prints the PROPOSAL (cells, arm, low/base/high). `load` dry-runs only if `--ledger-dir` holds a ledger header, else is skipped with a reason | 3    |
| `--apply`             | t1, t2, load, fusion write. T3 stays a plan (PROPOSAL printed, no model). `load` then needs `--ledger-dir` with a ledger (refused before anything starts if there is none)            | 0    |
| `--apply-t3` (+ caps) | T3 may call the model. With `--apply` the chain continues t3 -> load -> fusion; without it only the paid stage applies and the other stages stay dry-runs                             | 0    |

Rules:

- Fixed order t1, t2, t3, load, fusion. `--stages` selects a subset, never reorders. The free stages come
  first, so the paid stage never starts after a failed free stage.
- Fail-fast: the first stage that is not ok ends the chain. A stage's 0 and 3 are both ok when that stage
  ran as a dry-run; 3 from an applied stage is an error.
- One account per invocation. No "all accounts": one approval is one account.
- `--window-start` is required and goes unchanged to t1, t2 and t3 (it is in the T3 ledger signature, so a
  daily default would break resume). `--sample-size` and `--sample-seed` are required whenever t3 is in
  `--stages` (the PROPOSAL is for a named sample; no silent default hides the pool).
- One roster option set: `--agency-domain` is merged with `CASTING_AGENCY_EMAIL_DOMAINS` and set in the
  process env before any stage runs (the pilot reads only the env), and passed as a flag to t1, t2 and load.
  `--unknown-start-date` goes to t2, t3, load and fusion.
- All argv is built and validated with the stages' own parsers (`parseT1Args`, `parseT2Args`,
  `parsePilotArgs`, `parseLoadArgs`, `parseFusionArgs`) before any stage starts. Unknown flags are errors.
- A "full" T3 run is the pilot driver with `--sample-size` at least the pool (a smaller pool runs whole). The
  pilot driver keeps its name; it also runs full waves. Read the cell count in the PLAN, then pass it as
  `--sample-size`, `--max-cells` and `--expect-cells`.
- Resume has no state store of its own. Stages are idempotent (T1, T2 and load insert-or-ignore on
  `(extractor_version, claim_hash)`; fusion rebuilds the account in one transaction). T3 resumes from its
  ledger with the same seed, signature and `--ledger-dir`. A paused T1/T2 (exit 75 from `--budget-seconds`)
  prints its run id; give it back with `--resume`. Re-running the same command is the resume.
- Exit codes (the stages' table): 0 ok, 1 error, 2 refused (nothing of that stage started), 3 plan printed,
  4 T3 stopped at the cost ceiling, 75 paused. Code 4 halts the chain: no load and no fusion on a partial
  ledger (re-run with a higher cap, or `--stages load,fusion` on purpose).
- Logging: stdout JSON lines, counts only: `casting-run plan` (mode, window start, stages and modes, T3
  extractor version, fusion version, warnings), `stage start` / `stage end` (exit code, duration),
  `stage skipped`, `refused`, and a final `casting-run summary` naming the stage that decided the exit code.
  The stages print their own reports as before. In a paid run the same lines are appended to
  `<ledger-dir>.run-log.jsonl`. No account id, seed, path, domain, name or quote is in these lines.

## 3. Code map

New, in `src/casting/run-all/` (about 960 lines of source, 900 of tests):

| File             | Role                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `args.ts`        | strict flag parsing and cross-flag rules                                                      |
| `plan.ts`        | one flag set to per-stage argv, validated by the stage parsers; domain merge                  |
| `run.ts`         | hermetic core: preflight, lock, order, fail-fast, exit codes, summary; `StageFns` is injected |
| `guards.ts`      | model preflight, ledger location, paid-twice, lock, `beforeApply` check, fusion pin reminder  |
| `runlog.ts`      | counts-only emitter (stdout plus the audit file)                                              |
| `real-stages.ts` | the only wiring: dynamic imports of the real stages                                           |
| `main.ts`        | entry, argument errors to exit 2, closes the connection                                       |

Changed in existing files: `t1/main.ts`, `t2/main.ts`, `fusion/main.ts` (`main` exported, nothing else);
`t3/pilot.ts` (optional `PilotIo.beforeApply` hook, called in apply only, after the PROPOSAL and all of the
driver's guards, before the header, the model client and the sink; absent = unchanged); `t3/real-llm.ts`
(throws if the client module selected the mock driver); `package.json` (`casting-run` script).

S9 additions (section 7): `src/casting/maintain/` (incremental selection, prior ledgers, re-scan plan, drift, purge,
change probe, job); in existing files `t3/pilot.ts` and `t3/pilot-args.ts` (`--incremental`, `onProposal` hook,
`cellKeys` in `BeforeApplyInfo`), `t3/ledger.ts` and `t3/run.ts` (optional `md5Checksum` on a ledger record),
`t3/load.ts` (`window_start` on the run), `t1/run.ts` (`account_ids` on the run), `run-all/*` (flags, probe gate,
by-cell paid-twice), `package.json` (four scripts).

Out of the chain on purpose: the T2 edit-stats backfill (it writes `drive_edit_stats`, separate go) and the
UB serving endpoint.

## 4. Guards

Paid stage:

1. Cannot start without `--apply-t3` AND `--sample-size`, `--sample-seed`, `--max-cells`, `--max-usd`, an
   absolute `--ledger-dir` and `--expect-cells`. `--apply` alone never reaches the model. The pilot
   driver's own guards (ledger outside the repo, same-signature resume, selection within `--max-cells`,
   lazy client) are untouched and run after these.
2. `--expect-cells` must equal the cell count of the apply-time PROPOSAL (checked in `beforeApply`): the
   proposal you saw is the run that starts. A changed listing refuses with exit 2 before the ledger header
   is written.
3. The base estimate for the arm must not exceed `--max-usd` (the run would stop at the ceiling for sure).
   The cap itself stays an envelope.
4. Model preflight, fail closed: `GEMINI_USE_ENTERPRISE=true` (explicit, stricter than the config default)
   and a non-empty `GCP_PROJECT_ID`; a `GEMINI_API_KEY`-only environment is refused. Second line:
   `real-llm.ts` throws when the driver is the mock. The model must have a price in `MODEL_PRICES`.
5. Lock `<ledger-dir>.lock` (`wx`; a lock whose pid is dead is replaced). The lock and the run log sit NEXT
   to the ledger directory, never inside: the pilot refuses a non-empty directory without a header.
   Keep the manual check `ps -eo pid,args | grep "[c]asting-run"` in the runbook.
6. Paid-twice: a sibling directory of `--ledger-dir` whose header has the same account, window start,
   prompt version, model, thinking level and cap, and at least one ok cell, refuses the run unless
   `--allow-repeat-paid`. The directory itself (a resume) is not a twin. With `--incremental` the same
   detector runs by cell (section 7).
7. Halt on exit 4.

All stages: dry-run default, explicit `--apply`, one account, unknown flag = error, argv validated up front.
Fusion pin: `fusion --apply` replaces the account's Layer 2 rows, so serving is empty until
`CASTING_FUSION_VERSION` is switched (`docs/casting-fusion.md`); the plan line warns when the env pin differs
from the code's version.

The per-account switch (D14: `log` then `strict`, named owner, written cutover plan) is, for the job,
`CASTING_JOB_ACCOUNT_IDS` (empty = nothing runs) plus the write flag `CASTING_JOB_APPLY` (default off = plan
only). On a local run the person holding the credentials is the switch.

## 5. Where it runs

Local (cloud-sql-proxy and ADC) for every run including the paid one. The Cloud Run Job form is BUILT
(`src/casting/maintain/job-main.ts`, section 7) but NOT deployed, scheduled or enabled: nothing in
`.github/workflows/deploy.yml`, terraform or Cloud Scheduler references it.

- Observed in `.github/workflows/deploy.yml` (the live job was not read): the dev FLAGS set `GCP_PROJECT_ID`
  but no `GEMINI_*` variable and no Gemini secret, so as written a deployed client would be the mock. That
  is why the model preflight exists.
- The paid stage in Cloud Run needs a Vertex role on that SA, `GEMINI_USE_ENTERPRISE=true` and a persistent
  ledger (GCS volume or GCS-backed). The ledger holds names and short quotes from client documents: where it
  lives is a data-handling decision.
- Records: D3 needs none for the stages (writes go through `casting_t1/t2/t3/fusion` sync_runs); the purge
  adds the source `casting_purge` and needs a D3 line. D12: pattern A, same image, no record. D14 needs the
  flag entry (owner, cutover plan) before the job is enabled.

## 6. Tests (unit only: fake stages, temp dirs; no DB, no model, no Drive, no network)

`src/casting/run-all/__tests__/`: `args.test.ts` (modes, required flags, unknown flags, resume),
`plan.test.ts` (one flag set gives consistent argv that the real parsers accept; bad flags fail at build),
`run.test.ts` (order, fail-fast, exit mapping, 0/3 rules, halt on 4 and 75, `--apply` never applies t3,
every refusal leaves no stage called, lock and audit log placement, counts-only logging),
`guards.test.ts` (model preflight, `beforeApply` checks, lock, paid-twice, pin reminder),
`hermetic.test.ts` (the core imports no config, Prisma, logger, model or Drive code; only `real-stages.ts`
and `main.ts` have dynamic imports). Also `t3/__tests__/real-llm.test.ts` (mock driver throws) and three
cases in `t3/__tests__/pilot.test.ts` (the `beforeApply` hook).

`src/casting/maintain/__tests__/`: `incremental.test.ts` and `pilot-incremental.test.ts` (selection, quiet day
writes nothing, $0 copies, loader round trip), `rescan-plan.test.ts`, `drift.test.ts`, `purge.test.ts`,
`change-probe.test.ts`, `job.test.ts`, `window.test.ts`, `hermetic.test.ts`; `run-all/__tests__/incremental.test.ts`.
All fakes: no database, Drive, model or network.

## 7. Maintenance (S9): incremental, re-scan, drift, purge, window, job

Code: `src/casting/maintain/`. Nothing here approves or starts a paid run on its own.

### Incremental

`casting-run --incremental --ledger-dir /abs/<base>/<account>/<day> ...` changes only what is selected; every
guard of section 4 stays.

- T3 pays only for cells that no earlier ledger holds. A cell key is file + content version (Drive md5; the
  modified time for Google-native files) + prompt + model + thinking + cap, so an unchanged file is the same
  key (already paid), an edited file is a new key, and a new extractor version re-keys everything. The earlier
  ledgers are the SIBLING directories of `--ledger-dir` (same account, read-only, never created). One directory
  per day; a second run the same day resumes it.
- A new file whose md5 matches a paid cell, and a new listing copy of a paid cell, are `$0` copy lines: no model
  call; the loader writes rows for the copy's own file, account and project. The paid cell is carried into the
  new ledger without usage so the loader finds it next to its copies. Files with no md5 that duplicate a paid
  text are still caught at read time (the stage's content-hash copy), at the cost of one Drive read.
- `--sample-size` and `--sample-seed` become optional (the sample is the whole delta, capped by `--max-cells`);
  `--expect-cells` may be 0. Plan first: it prints the delta. Apply with `--expect-cells N --max-cells N`.
- Paid-twice by cell: a daily ledger has yesterday's configuration by design, so the detector runs with the
  cell keys of the PROPOSAL and refuses only when a sibling already paid one of THESE cells.
- A no-change day selects 0 cells, creates no directory, header, model client or sink: cost `$0`, writes nothing.
- Free stages with `--apply`: a read-only probe asks whether any file of the account got a snapshot row (other
  than `delta_unchanged`, `content_unchanged`, `trashed`) after the last successful `casting_t1` run that
  named the account (T1 now stamps `account_ids` on its run). Quiet: t1, t2 and fusion are skipped (no run
  rows, no Layer 2 rebuild), exit 0. No baseline (first run) or a probe error counts as changed. T3 is never
  gated by the probe: its own delta decides. Known gap: a day with edits that are not in the file index (T2
  activity only) is not picked up until something else changes.

### Re-scan on an `extractor_version` bump

`npm run casting-rescan-plan -- --account-id UUID --window-start D --model M --thinking L --ledger-dir /abs/<new-day>`:
lists the account, reads the earlier ledgers, prints the cells the target version needs (re-extractions of an
earlier version vs never extracted, by class), low/base/high cost (cells priced at `[ASSUME 10000]` chars: no
document is read), exit 3. It has no apply flag (any `--apply*` is refused). The paid run is the ordinary
`casting-run --incremental --apply-t3` with its own approval. Then load, rebuild Layer 2, switch the
fusion pin (`docs/casting-fusion.md`), and purge the old version only after the new one is served.

### Drift monitor

`npm run casting-drift -- --account-id UUID [--fusion-version V] [--window-start D] [--compare prev.json] [--fail-on-breach]`:
SELECT-only aggregates, one JSON line of counts and rates: unresolved-name rate (T3 rows not resolved to one
staff row, client-side people included), tier agreement (served claims backed by 2+ sources), withheld share,
served count, confidence spread (p10/p50/p90). The unresolved-name rate and the withheld share depend on the
account (client-side names, how much is confirmed), so they are judged **only as a change against a baseline
report** (`--compare`), never against a fixed limit; only tier agreement and confidence spread have absolute
floors. Save the report's `report` object as the baseline after each full rebuild and pass it back with
`--compare`. Thresholds are named constants in `maintain/constants.ts`, all `[ASSUME]` placeholders:
**TODO(S8) S8 must ratify them** before any alert reads them. Exit 0 even on a breach unless `--fail-on-breach`
(exit 6).

### Purge of a bad extractor version

`npm run casting-purge -- --account-id UUID --extractor-version t3-v1:gemini-3.5-flash:low` is a dry-run:
counts the rows, tagged by the `sync_runs` rows that wrote them. `--apply --expect-rows N` (N from the dry-run)
deletes ONE account's rows of ONE version in batches and records a `casting_purge` sync run. Then:

1. rebuild Layer 2 for the account (`casting-run --stages fusion --apply` or `fusion --apply`): links to the
   deleted rows cascade, so Layer 2 rows show fewer sources until the rebuild;
2. keep the bad ledger out of any load (the loader would re-insert the rows); a bumped version re-keys the cells
   so the incremental run does not treat them as done.

### Sliding window

`--window-years N` (needs `--incremental`; the job defaults to 5) resolves the cutoff from today; the run plan
and summary lines record `windowCutoff`, T1/T2 run details and the ledger header record `window_start`, and the
loader stamps it on its run. The rule: **a slide moves only what is selected from now on; it never deletes
evidence and never touches Layer 2.** The cutoff is not part of a cell key, so a slide re-pays nothing. Evidence
older than the cutoff stays in Layer 1 and keeps backing claims that Layer 2 serves; only the explicit purge
deletes. `casting-drift --window-start` counts the served claims that ended before a cutoff, so a person can
see what a future retention rule would touch. No retention deletion is implemented; it needs a defined rule
and a decision first.

### Cloud Run Job form (deploy step built, no trigger)

`node dist/src/casting/maintain/job-main.js` (`npm run casting-job` locally), same image, command overridden by
the job definition (the image ENTRYPOINT stays `dist/src/main.js`). For each account it runs
`casting-run --incremental --window-years N --stages t1,t2,load,fusion [--apply]`: free stages only.

| Variable                   | Default | Meaning                                                                        |
| -------------------------- | ------- | ------------------------------------------------------------------------------ |
| `CASTING_JOB_ACCOUNT_IDS`  | empty   | uuid list; empty refuses (nothing enabled)                                     |
| `CASTING_JOB_APPLY`        | off     | `true` = the free stages write; otherwise every stage is a dry-run             |
| `CASTING_WINDOW_YEARS`     | 5       | sliding window length                                                          |
| `CASTING_T3_ENABLED`       | off     | paid-stage enable flag                                                         |
| `CASTING_T3_DAILY_MAX_USD` | unset   | written budget for one execution, split evenly across the accounts             |
| `CASTING_T3_LEDGER_DIR`    | unset   | absolute persistent base: `<base>/<account>/<day>` (needed when T3 is enabled) |

Owner of `CASTING_JOB_APPLY` and `CASTING_T3_ENABLED`: the casting staffing track. `CASTING_JOB_APPLY` flips once the
job is deployed and one dry-run execution matches a manual `casting-run --incremental` plan; `CASTING_T3_ENABLED`
flips only after the user approves a written daily budget. Both flags are deleted once the job has run unattended
for a month and the budget is a fixed part of the job definition.

The paid stage runs only when `CASTING_T3_ENABLED=true` AND `CASTING_T3_DAILY_MAX_USD` are both set (and writes
are on and the ledger dir exists); the flag alone refuses the job, the budget alone leaves T3 off. **Setting
them is the user's approval decision**: a scheduled paid run is not covered by any single-use approval, and the
budget must be written down and approved before it is set. When on, per account: a read-only PLAN, then one paid
pass only if the plan has cells and its base estimate fits the account's share; that pass carries the plan's
cell count as `--expect-cells`/`--max-cells` and the share as `--max-usd`, with every guard of section 4
(model preflight, lock, paid-twice by cell, ledger outside the repo). The share is a ceiling, not the
estimate; actual spend per execution is bounded by the budget, not predicted.

In the cloud: the job `gub-drive-sync-casting-<env>` is created as an inert shell by `scripts/setup-gcp.sh` (run once by the owner) and updated by the
last step of `.github/workflows/deploy.yml` with the same image, `--command node --args dist/src/casting/maintain/job-main.js`,
`DATABASE_URL` and the Cloud SQL attachment of the existing job, the existing runtime SA, `NODE_ENV=production`,
`CASTING_JOB_ACCOUNT_IDS` from the GitHub Environment variable of the same name, and `CASTING_JOB_APPLY=false` as a literal.
The step skips (it never fails) when the job is not provisioned or the variable is unset. The job reads and writes the
database only (no Drive and no model call in the free stages), so it needs no Drive or Gemini secret. Flag values are
strict: `CASTING_JOB_APPLY` is exactly `true` or `false` (the "off" in the table means `false` or unset; any other value
refuses the job). No `CASTING_T3_*` variable is set, no Scheduler trigger exists, and no Vertex role or ledger volume is
granted: each of those is part of a later decision (a Vertex role and a persistent ledger volume only if T3 will ever be
enabled; a narrow `run.developer` binding and a Cloud Scheduler trigger last). The D14 flags (`CASTING_JOB_APPLY`,
`CASTING_T3_ENABLED`) are recorded in the UB decisions file.
