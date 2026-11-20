# T3 pilot driver (P1)

The pilot driver runs the T3 stage (Drive document content mentions) on **one account** and a
**fixed-size, stratified sample** of its kept shortlist. Results go **only to the run ledger**: no
database sink, no `evidence` rows. The resolver re-runs later from the ledger without another model
call. Entry point: `src/casting/t3/pilot-main.ts`; core: `pilot.ts`.

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

## Tests

`src/casting/t3/__tests__/`: `sample.test.ts` (determinism, stratification), `pilot.test.ts` (guards,
dry-run touches nothing, apply and resume with a fake model), `truncate-estimate.test.ts` (estimate formula and the calibrated presets), `listing-candidates.test.ts`, and
`no-real-client.test.ts` (static allow-list including the pilot entry point, import closure of the
real wiring has no model client, dry-run with the client module poisoned). All use a mocked model and
synthetic data.
