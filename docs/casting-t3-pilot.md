# T3 pilot driver (P1)

The pilot driver runs the T3 stage (Drive document content mentions) on **one account** and a
**fixed-size, stratified sample** of its kept shortlist. Results go **only to the run ledger**: no
database sink, no `evidence` rows. The resolver re-runs later from the ledger without another model
call. Entry point: `src/casting/t3/pilot-main.ts`; core: `pilot.ts`. A finished ledger is loaded into
Layer 1 later, with no model call, by a separate entry point (see "Loading a ledger into Layer 1").

The whole chain (T1, T2, this driver, the loader, fusion) for one account runs from one command with
extra guards: see [casting-pipeline.md](./casting-pipeline.md). This driver also runs full waves
(`--sample-size` at least the pool); the name is historical.

## Dry-run (default, $0)

```
node dist/src/casting/t3/pilot-main.js \
  --account-id <uuid> --window-start 2021-11-19 \
  --sample-size 120 --sample-seed <string> \
  --variant base --model gemini-3.5-flash --thinking LOW --parallel 2 \
  --read-text --ledger-dir /abs/path/outside/the/repo \
  [--unknown-start-date YYYY-MM-DD ...]
```

`--unknown-start-date` (repeatable, optional, same meaning as in the T2 stage) names a `staff.started_at`
value that is an import placeholder, not a hire date: the employment-window gate is skipped for such
rows when the roster resolves people. It only changes the in-memory resolve step, never a model call, so
it is **not** part of the ledger signature (an existing ledger stays resumable with or without it).
Default: none.

It lists the account's Drive tree (read-only), runs the stage's shortlist step (window, tiers,
version collapse, identical-content copies), draws the sample, prints the `PROPOSAL` block first and
then the details (sample by class, excluded counts, measured text lengths, a reference estimate with
the calibrated presets, see "Cost estimate presets"), and **exits 3** ("printed, nothing started"). It never creates a model client, a
sink or the ledger directory. `--read-text` reads only the sampled documents (read-only Drive calls,
no model call) to size the estimate.

Exit codes: 0 run finished, 1 error or failed run, 2 a guard or an argument refused, 3 dry-run,
4 run stopped at the cost ceiling.

## Cost estimate presets

`estimate.ts` (`ASSUMPTION_PRESETS`) prices a run as
`cells x ((overhead + min(chars, cap) / chars_per_token) x P_in + (out + thoughts) x P_out) x retry`.
Calibrated: pilot P1 (2026-11-20; 118 model calls, gemini-3.5-flash, thinking LOW).

| Parameter        | low   | base (measured)     | high  |
| ---------------- | ----- | ------------------- | ----- |
| overhead tokens  | 850   | 940                 | 1,100 |
| chars per token  | 4.0   | 3.55                | 3.0   |
| output tokens    | 250   | 336                 | 600   |
| thought tokens   | 0     | 12                  | 200   |
| retry factor     | 1.0   | 1.05 (measured 1.0) | 1.2   |
| input cap, chars | 40000 | 40000               | 80000 |

Caveats: the thought figure is measured at thinking LOW only; the proposal warns when the level
is not LOW. Flash Lite token use is not measured: the Flash figures are applied to Flash Lite
prices ([ASSUME]). Cached input is not discounted, so the input side is an upper bound.

## The sample

`sample.ts`: a pure function of the set of kept file ids with their document class, the size and the
seed. Proportional by class (largest remainder), at least one cell per class that has any (while the
sample is large enough), ranked inside a class by `sha256(seed|class|fileId)`. No `Math.random`, no
`Date`, no dependence on input order: the same listing and seed give the same sample, another seed
another one. The sample is drawn from **kept cells only** (one per content hash). Copies are not
cells, are not sampled and are never sent to the model; the sampled cells carry their copies, which
receive rows at the resolve step for $0. A pool smaller than the sample size runs the whole pool.

## Apply (PAID: needs an explicit go)

```
... --apply --max-cells 120 --max-usd 6.00 --ledger-dir /abs/path/outside/the/repo
```

Guards, in the order they act (none is looser than the stage's own):

1. `--apply` needs `--max-cells`, `--max-usd` and an **absolute** `--ledger-dir`; `--max-cells` must be
   at least the sample size; unknown flags are errors; `--parallel` is 1 or 2.
2. The ledger directory must be **outside the repository** (also checked in a dry-run) and in a usable
   state: absent, empty, or holding `header.json` for the **same seed and configuration signature**
   (account, window start, variant, sample size, seed, prompt version, model, thinking level, cap).
   A non-empty directory without a header, or with another signature, is refused.
3. The selection must not exceed `--max-cells`, otherwise nothing starts.
4. The `PROPOSAL` block is printed before anything starts. The model client is created lazily, by the
   stage, only after every guard passed; the stage stops launching cells once the spend reaches
   `--max-usd`.

Without `--apply` nothing of this runs, and the process exits non-zero (3).

## What it writes

`<ledger-dir>/header.json` (seed, signature, extractor version, the sample's file ids and per-class
counts; written once, never overwritten) and `<ledger-dir>/cells.jsonl` (one line per processed
cell: validated, grounded mentions next to the usage that paid for them). The stage's sink is the
in-memory `MemorySink`: rows are resolved in memory for the report and discarded at exit. The ledger
holds names and short quotes from client documents: keep it outside git.

## Resume

Run the same command again with the same seed and ledger directory. The sample is taken from the
header (if a sampled file has left the listing, the run is refused: use a new directory); cells
already in the ledger are skipped (failed ones too, unless `--retry-failed`), so no model call is
repeated.

## Loading a ledger into Layer 1

A finished ledger becomes `evidence` rows (source `drive_content`) with **no model call and no
document read**: `src/casting/t3/load-main.ts` (core: `load.ts`, sink: `pg-sink.ts`). Order:

1. **The UB casting migration (gub-schemas 1.23.0) is applied** to the target database. Before it,
   `--apply` is refused (Postgres 42P01 turned into a plain message, exit 2) and creates nothing,
   not even a `sync_runs` row. The dry-run below reads only tables that exist today (`staff`), so it
   works before and after the migration.
2. **Dry-run** (the default): counts only, nothing written, exit 3.
3. **`--apply`**, after the counts look right.

```
node dist/src/casting/t3/load-main.js --ledger-dir /abs/path/outside/the/repo \
  --account-id <uuid> [--agency-domain agency.example ...] [--unknown-start-date YYYY-MM-DD ...]
node dist/src/casting/t3/load-main.js ... --apply
```

`--ledger-dir` and `--account-id` are required. The account must be the one in the ledger header's
signature (and in every ok and copy cell), otherwise the load is refused before the roster is read.
`--agency-domain` (repeatable) is added to `CASTING_AGENCY_EMAIL_DOMAINS`; `--unknown-start-date` is
the pilot's roster option. Use the same values as the pilot run. Unknown flags are errors.

What it does: every ok cell's validated, grounded mentions are resolved again against the **current**
roster by the stage's own function (`resolveLedgerRecords`, the one `runT3` uses): the same row builder
and the same identical-content copy expansion (the `copy` lines the pilot recorded in the ledger give
the kept to copies mapping; copies get rows for $0 under their own file, account and job number).
Rows carry the ledger's extractor version (`t3-<prompt>:<model>:<thinking>`), the purge key of that
configuration. The period clamp uses the date of the pilot run, `header.createdAt` (printed; a header without a usable `createdAt` is refused, there is no fallback to today). The dry-run prints cells by
status, mentions, copies, rows by `person_kind` and `withheld_reason`, duplicates by `claim_hash`
and the rows to write; no names, quotes or file ids.

Refused (exit 2, nothing written): a ledger inside the repository checkout; a missing directory,
header or cells file; another account; a header whose extractor version is not the one its own
signature gives; a ledger written under another **prompt version** than this code (its mentions were
vetted by other sanitising and grounding rules: check out that version's commit); an ok cell with
another extractor version than the header; a ledger with no ok cell. A torn last line of
`cells.jsonl` is counted and reported (`unreadable lines`).

Apply writes one `sync_runs` row (`source = 'casting_t3'`, status `running`, then `success` or
`failed`, details = counts and ids only) and inserts in batches of 500 with
`ON CONFLICT (extractor_version, claim_hash) DO NOTHING`. A second run over the same ledger inserts
0 and reports every row as already present. A failure after some batches keeps those batches (the
run ends `failed`, details name the error); running the load again completes it. A claim that sits
in two ok cells (same file, same claim) is written once.

Exit codes: 0 loaded, 1 error, 2 refused, 3 dry-run.

## Tests

`src/casting/t3/__tests__/`: `sample.test.ts` (determinism, stratification), `pilot.test.ts` (guards,
dry-run touches nothing, apply and resume with a fake model), `truncate-estimate.test.ts` (estimate formula and the calibrated presets), `listing-candidates.test.ts`, and
`no-real-client.test.ts` (static allow-list including the pilot entry point and the ledger loader,
import closure of the real wiring and of the loader has no model client, dry-run with the client module
poisoned), `load.test.ts` and `pg-sink.test.ts` (the ledger loader: ledgers are produced by the pilot
driver itself into a temp directory, rows are compared with what the stage's sink received, guards,
idempotent apply, 42P01 before the migration). All use a mocked model and synthetic data.
