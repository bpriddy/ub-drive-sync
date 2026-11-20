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
   `--allow-repeat-paid`. The directory itself (a resume) is not a twin.
7. Halt on exit 4.

All stages: dry-run default, explicit `--apply`, one account, unknown flag = error, argv validated up front.
Fusion pin: `fusion --apply` replaces the account's Layer 2 rows, so serving is empty until
`CASTING_FUSION_VERSION` is switched (`docs/casting-fusion.md`); the plan line warns when the env pin differs
from the code's version.

Deferred, NOT built (user ruling): the `CASTING_ENABLED_ACCOUNTS` per-account switch (D14: `log` then
`strict`, named owner, written cutover plan). It is deferred until the Cloud Run Job form exists; on a
local run the person holding the credentials is the switch.

## 5. Where it runs

v1 is local, with cloud-sql-proxy and ADC, for every run including the paid one. Nothing in Cloud Run calls
the casting mains (`ENTRYPOINT` is `dist/src/main.js`, whose modes have no casting entry).

Future work, not started (user ruling: not now):

- Cloud Run Job form, free stages first. D12 pattern A (Cloud Run Job, no HTTP), same image; a separate job
  (for example `gub-drive-sync-casting-<env>`) with its own runtime SA, no Scheduler trigger and a narrow
  `run.developer` binding, because the existing job can be fired with arbitrary args by the admin app's SA.
- Observed in `.github/workflows/deploy.yml` (the live job was not read): the dev FLAGS set `GCP_PROJECT_ID`
  but no `GEMINI_*` variable and no Gemini secret, so as written a deployed client would be the mock. That
  is why the model preflight exists.
- The paid stage in Cloud Run needs a Vertex role on that SA, `GEMINI_USE_ENTERPRISE=true` and a persistent
  ledger (GCS volume or GCS-backed). The ledger holds names and short quotes from client documents: where it
  lives is a data-handling decision.
- Records: D3 needs none (writes go only through the existing `casting_t1/t2/t3/fusion` sync_runs). D12
  needs none (same pattern). D14 needs an entry with the account switch above.
- Unattended T3 is NOT approved and not built. If ever: a dedicated job, caps from reviewed `deploy.yml`
  config (budget per run plus an approval expiry date), delta files only, a hard stop at `--max-usd`, ships
  in `log` then `strict` with an owner and a cutover plan (D14).
- S9 gap: the T3 ledger is per directory and its header fixes the sample, so a new ledger over a quiet
  account pays again for unchanged files. A cross-ledger done-set (`--skip-ledger-dir`, read-only prior
  ledgers) is planned AFTER the first full wave, not in this branch. Until then the paid-twice guard stops an
  accidental repeat.

## 6. Tests (unit only: fake stages, temp dirs; no DB, no model, no Drive, no network)

`src/casting/run-all/__tests__/`: `args.test.ts` (modes, required flags, unknown flags, resume),
`plan.test.ts` (one flag set gives consistent argv that the real parsers accept; bad flags fail at build),
`run.test.ts` (order, fail-fast, exit mapping, 0/3 rules, halt on 4 and 75, `--apply` never applies t3,
every refusal leaves no stage called, lock and audit log placement, counts-only logging),
`guards.test.ts` (model preflight, `beforeApply` checks, lock, paid-twice, pin reminder),
`hermetic.test.ts` (the core imports no config, Prisma, logger, model or Drive code; only `real-stages.ts`
and `main.ts` have dynamic imports). Also `t3/__tests__/real-llm.test.ts` (mock driver throws) and three
cases in `t3/__tests__/pilot.test.ts` (the `beforeApply` hook).
