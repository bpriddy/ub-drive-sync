# Casting fusion (Layer 1 to the staff work tables)

Stage entry: `src/casting/fusion/main.ts` (standalone job, no HTTP, not wired into `src/main.ts`).

```
node dist/src/casting/fusion/main.js --account-id <uuid>          # dry-run, writes nothing
node dist/src/casting/fusion/main.js --account-id <uuid> --apply  # rebuilds the account's staff work rows
```

Flags: `--account-id` (repeatable, required), `--apply`, `--chunk-size`,
`--unknown-start-date` (repeatable; a `staff.started_at` that is an import placeholder).

## What it does

`fuse()` (`fuse.ts`) is a pure function of Layer 1 `evidence`, the accounts and
campaigns of the accounts database, and the staff roster. It reads no clock, no
database and no environment, and calls no model. The same input in any order
gives identical rows, hashes, ids and metrics (property tests in
`__tests__/determinism.test.ts`).

- Only resolved, non-withheld rows of CURRENT staff become claims. External,
  quarantined and former-staff rows stay in Layer 1.
- One claim per (person, project, role). T1 / T2 rows state no role: they are
  presence evidence and corroborate every role claim of that person on that project.
- A claim is SERVED when `withheld_reason` is NULL. Everything else is stored with
  a reason (`conflicting`, `unconfirmed`) and never served. There is no review queue.
- Newer `extractor_version` supersedes older, per (source, file).
- A T3 file read again after an edit counts with its newest load only (below).
- Presence-only claims (no content row) are counted, not stored (`STORE_PRESENCE_ONLY_CLAIMS`).
- The claims are rolled up into the staff work join tables (`rollup.ts`, below)
  and only those rows are stored. Claims are no longer stored.
- `--apply` rebuilds one account in ONE transaction. It deletes the account's
  `drive_casting` rows of every build version: its `staff_accounts` rows, and the
  `staff_campaigns` rows of its campaigns and of every campaign it writes. Their
  links cascade. Then it inserts the new rows and their links. It never touches a
  `manual` row (added in gub-admin). The tables are a rebuildable projection;
  only Layer 1 is append-only.

## Output: the staff work join tables (`fusion-v4`)

Since `fusion-v4` (gcp-universal-schemas#39, UB ARCHITECTURE-DECISIONS D41), the
formula of `fusion-v3` is unchanged. The output is rolled up from claims (staff,
project, role) into two join tables, and `experience` is no longer written:

| Table | One row per | From which claims |
|---|---|---|
| `staff_campaigns` | staff, campaign, piece, role | the claims whose project resolves to a campaign; a piece-level claim does not also produce a piece-less row |
| `staff_accounts` | staff, account, role | every claim on the account: its campaigns' claims and the account-level ones (job-only and folder-name projects, projectless claims) |

A row built from several claims takes its values as follows:

- **Served or withheld.** The row is served (`withheld_reason` NULL) when at
  least one of its claims is served, and then every other column comes from the
  served claims only. Otherwise the reason is `conflicting` if any claim
  conflicts, else `unconfirmed`, and the columns come from all of the claims.
- **Period.** The envelope: the earliest known start and the latest known end.
  An end that falls before the start is dropped to NULL, so the period CHECK
  holds.
- **`confidence`:** the strongest claim.
- **`tiers`:** the distinct tiers across the claims.
- **`seniority`:** the highest.
- **`activity_checked`:** the rolled-up period is dated and a T2 row stands
  behind it (the rule of `validationLabel()`).
- **`staff_campaigns.job_number`:** the claims' job number, or the first in
  text order when they disagree.
- **Evidence links** (`staff_account_evidence_links`,
  `staff_campaign_evidence_links`): the union of the claims' Layer 1 rows.
- **`row_hash`** = sha256 over (staff, account, role) or (staff, campaign,
  piece, role), so it leaves the period and the build out. `build_version` is
  `FUSION_VERSION`, and the row id is derived from both.

`run.ts` reports, per account, the rows the rollup built (`rows.accounts`,
`rows.accountsServed`, `rows.campaigns`, `rows.campaignsServed`), in dry-run
too. `drift-pg.ts` reads `staff_accounts`, whose `tiers` column is the tier
agreement. A drift baseline taken on `fusion-v3` is not comparable.

## Confidence formula (`fusion-v3`, formula unchanged since `fusion-v2`)

```
row strength   s_i = clamp01(confidence_i) * pitchFactor       (lost pitch: 0.7, else 1)
               T3:  confidence_i first capped at 0.6 + 0.1 [grounded quote] + 0.1 [stated role]
tier score     S_t = min(TIER_CEILING[t], max(s_i in t) + 0.05 * min(distinctFiles_t - 1, 3))
combined       c   = 1 - product over present tiers (1 - S_t)
cap            c   = min(c, 0.6)   unless >= 2 tiers AND a T3 (content) row
confidence     round(c, 3)
```

Tier ceilings: T1 0.5, T2 0.4, T3 0.85. Tiers: T1 `drive_metadata`, T2
`drive_activity`, T3 `drive_content`. Gate to be served: confidence >= 0.7,
at least 2 tiers, a T3 row, a project reference, no conflict (accepted
2026-11-19: 0.7 and 2 tiers; the T3 and project requirements are part of this version).

`fusion-v2` (2026-11-23) changed the T3 row strength and ceiling. In `fusion-v1` a content row
was worth its name-match strength (0.95 for an exact name) up to 0.99, so on the first full
account every served claim scored 0.96 to 1.00 and confidence could not rank them. Now a
content row is worth what the mention shows: on the same data, served claims spread from 0.73
to 0.94 and none dropped below 0.7. A side effect: a lost pitch needs broader evidence (two
tiers on a lost pitch fall below 0.7).

`fusion-v3` (2026-11-23) did not touch the formula: it changed which rows reach it (next section).

All constants are named in `constants.ts`. NONE IS CALIBRATED: they fix orderings
and ceilings, and there is no ground truth. Changing a constant or the formula
bumps `FUSION_VERSION`; Layer 2 is keyed by `(fusion_version, experience_hash)`, so
the serving layer must read one version only.

## Newest content version of a file (`fusion-v3`)

`evidence` is append-only, so when incremental T3 re-reads an edited file the rows of the old
content stay next to the new ones. Counting both keeps a person who was removed from the file
backed, and counts a person who is in both versions twice (more documents, more confidence).

Rule (`newest-load.ts`, applied in `fuse()` right after the extractor supersede): for every T3
(`drive_content`) file, only the rows written by the file's NEWEST LOAD are counted. Older rows
stay in Layer 1 (nothing is deleted) and are reported as `metrics.olderContentVersion`. T1 and
T2 rows are never filtered by this rule. The extractor supersede runs first, so the rule is
"newest load of the newest extractor version of the file".

What "newest" is read from: a row carries no content hash or modified time, only the load run
that wrote it (`sync_run_id`) and the run's start (`sync_runs.started_at`; the reader joins it,
a RESTRICT foreign key). Loads are ordered by start time, ties by run id, so the order is total
and independent of row order. `evidence.created_at` was not used: it is stamped per batch, not
per run, so one run would have several values.

PRECONDITION (met by the T3 loader): a load of a changed file must write EVERY claim of the
new version as rows of that load. The T3 sink is insert-or-ignore on
`(extractor_version, claim_hash)`, so the loader puts the content version into `claim_hash`
(`t3/row.ts` `claimHash(row, contentVersion)`, `t3/resolve-mentions.ts`). The token is the
ledger CELL KEY (file id + Drive md5, or the modified time of a Google-native file, + prompt,
model, thinking, cap), the narrowest value the ledger record carries that changes when the
content that was read changes (the record keeps the md5 but not the modified time, so the cell
key is the only token that also covers Google-native files). A cap or other configuration
change gives a new cell key as well: that is a new extraction of the file, so it is a new load,
which is the right outcome. Consequences:

- loading the SAME ledger again hashes the same and inserts nothing (idempotent as before);
- an edited file hashes every claim anew: a person in both versions is a fresh row of the new
  load (counted once), a person only in the old version has no row in it (not counted);
- copies (identical-content files) carry the kept cell's key; their own file id keeps them
  apart from the kept file;
- T1 and T2 hashes are untouched; so are T3 rows written before the token (no token = the
  previous hash).
- a ledger that holds several ok cells of one file loads only the newest (`at`, then cell key):
  one load = one content version (`olderCellsSkipped` in the load report).

Existing rows (hashed the old way, e.g. the first full-account load). They carry no token and
stay as they are: for fusion they are that file's load of their own run, like any other. No
one-time step is needed:

- until the file changes, they are its only load and count as before (no drop, no double count);
- loading the same ledger again with the new code inserts a second, equal set under new hashes
  (the old hashes do not match). Fusion counts only the newer load of the file, so nothing is
  counted twice; the cost is duplicate rows in Layer 1 (storage only). Not needed, so do not;
- a later incremental load of an edited file supersedes them like any older load.

Remaining limits, by design of "newest = latest load":

- an edit that leaves the file with no mention at all writes no row, so the old rows stay
  (the cell is ok with zero mentions; a content column on `evidence` would be needed);
- a file edited back to content a ledger already holds is "done" for the incremental selection
  and is not loaded again, so the newer load (the intermediate content) stays the newest;
- load ledgers in date order: loading an OLDER ledger for the first time after a newer one makes
  its rows the newest load of those files (it is a new run).

## Rules

- Period: the span of the claim's own T3 periods, else the project's T1 period,
  else the catalog campaign dates, else NULL. Never one file's date. T2 days are
  never a period (a stats day is the day of the run, an upper bound).
- Window: a claim whose period ends more than 30 days before the person's
  `startedAt` is `conflicting`. No end gate.
- Seniority: the highest value across the claim's rows wins.
- Conflicts, among claims that would otherwise be served (a weak rival never
  suppresses a strong claim):
  - two different people with a claim to the same single-holder role on the same
    project at overlapping or unknown periods. The set is `executive_producer`
    only (`SINGLE_HOLDER_ROLES`); `producer` is not in it, projects have co-producers;
  - one person with claims to both roles of an incompatible pair on the same
    project (`INCOMPATIBLE_ROLE_PAIRS`, below). Only the members of the pair are
    withheld; the person's other roles stay served.
- The row holds no copied traits of the work (client category, project type,
  outcome, budget band): those stay on accounts, campaigns and pieces, which the
  row is keyed to by `account_id`, `campaign_id` and `piece_id`. A lost pitch still
  lowers a claim's strength (factor 0.7, read from `campaigns.status` at fuse time);
  the status is no longer stored on the row.
- Recency is not in the formula. Older years are labelled `not_validated`
  (undated, or no T2 evidence behind the claim), never hidden below the threshold.

## Incompatible role pairs

An explicit short list in `constants.ts`, no role families. Conservative on purpose:
a small agency legitimately combines neighbouring crafts (strategist and copywriter,
art director and designer, copywriter and art director), so only combinations from
opposite ends of the agency are listed. Two pairs, set by the Casting contact
(2026-11-20).

| Pair                                                | Why one person does not hold both on one project              |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `finance` + `creative_director`                     | budget control and creative leadership are opposite seats     |
| `executive_creative_director` + `account_executive` | top of the creative ladder and the junior client-service seat |

`finance` + `account_director` and `account_director` + `art_director` were
considered and deliberately left out, as were `strategist` + `copywriter`,
`art_director` + `designer` and `copywriter` + `art_director`: a person holding
both of these on one project is legitimate and stays served.

## Validation label (one definition, shared with serving)

`activity_checked` means the claim is DATED (a period start or end is known) AND at
least one Layer 1 row behind it has source `drive_activity` (T2). Every other claim,
including every undated claim and every claim with no T2 row, is `not_validated`.
It says whether a claim could be cross-checked, never how accurate it is. It is not
stored: S7 computes it from the claim's period and the sources of its linked
evidence, with the same rule as `validationLabel()` in `fuse.ts`.

## Changing `fusion_version`: operational order

Serving reads exactly ONE build version, named by UB's pin `STAFF_WORK_BUILD_VERSION`
(D41; the casting pin `CASTING_FUSION_VERSION` retires with `experience`).
Applying a new version to an account removes that account's rows of every other
version in the same transaction, so after the apply the pinned (old) version has no
rows for that account and the served answer for it is EMPTY until the pin is
switched. Order:

1. Ship the code with the new `FUSION_VERSION`.
2. Run `--apply` for ALL accounts in as short a window as possible (dry-run first).
3. Switch `STAFF_WORK_BUILD_VERSION` to the new version immediately after the last
   account finishes.
4. Between steps 2 and 3 the answer is empty for the rebuilt accounts. If that is
   not acceptable, turn the serving kill switch off for the window.

`fusion-v3` changes served results (it can drop claims that rested on an old content
version), so the same order applies: do not switch the pin until the rebuild has finished for
EVERY account. In particular, switch the pin in UB only after that.

Rolling back is the same order in reverse: deploy the old code, re-apply, switch the pin.

## Proxy metrics

`fuse()` returns counts per tier and fused: share of rows resolved to staff vs
external vs quarantined, claims withheld by reason, served claims backed by 2+
tiers, cross-document agreement, T2 agreement (a lower-bound proxy, only inside an
account's activity horizon, says nothing about older years), coverage per
account and year, served claims per year split by `activity_checked` /
`not_validated`. No precision or recall is computed: there is no ground truth.

## Deploy order (the P2022 trap)

The UB migrations that create `evidence` (gub-schemas 1.26.0) and the staff work
tables (`20261124200000_staff_work`, gub-schemas 1.29.0) must be applied BEFORE
the job runs. A dry-run reads `evidence`; `--apply` also writes the staff work
tables. Before the migrations both modes fail with Postgres 42P01 on purpose.
