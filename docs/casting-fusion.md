# Casting fusion (Layer 1 to Layer 2)

Stage entry: `src/casting/fusion/main.ts` (standalone job, no HTTP, not wired into `src/main.ts`).

```
node dist/src/casting/fusion/main.js --account-id <uuid>          # dry-run, writes nothing
node dist/src/casting/fusion/main.js --account-id <uuid> --apply  # rebuilds Layer 2 of the account
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
- Presence-only claims (no content row) are counted, not stored (`STORE_PRESENCE_ONLY_CLAIMS`).
- `--apply` rebuilds one account in ONE transaction: delete the account's rows of
  every OTHER `fusion_version` (their links cascade), delete its rows of this
  version, insert the new rows, insert the links. Layer 2 is a rebuildable
  projection; only Layer 1 is append-only.

## Confidence formula (`fusion-v1`)

```
row strength   s_i = clamp01(confidence_i) * pitchFactor       (lost pitch: 0.7, else 1)
tier score     S_t = min(TIER_CEILING[t], max(s_i in t) + 0.05 * min(distinctFiles_t - 1, 3))
combined       c   = 1 - product over present tiers (1 - S_t)
cap            c   = min(c, 0.6)   unless >= 2 tiers AND a T3 (content) row
confidence     round(c, 3)
```

Tier ceilings: T1 0.5, T2 0.4, T3 0.99. Tiers: T1 `drive_metadata`, T2
`drive_activity`, T3 `drive_content`. Gate to be served: confidence >= 0.7,
at least 2 tiers, a T3 row, a project reference, no conflict (accepted
2026-11-19: 0.7 and 2 tiers; the T3 and project requirements are part of this version).

All constants are named in `constants.ts`. NONE IS CALIBRATED: they fix orderings
and ceilings, and there is no ground truth. Changing a constant or the formula
bumps `FUSION_VERSION`; Layer 2 is keyed by `(fusion_version, experience_hash)`, so
the serving layer must read one version only.

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
- Budget band cut points (250k / 1M / 2.5M) are TEMPORARY (`BUDGET_BAND_CUTS`).
- Recency is not in the formula. Older years are labelled `not_validated`
  (undated, or no T2 evidence behind the claim), never hidden below the threshold.

## Incompatible role pairs (proposal)

An explicit short list in `constants.ts`, no role families. Conservative on purpose:
a small agency legitimately combines neighbouring crafts (strategist and copywriter,
art director and designer, copywriter and art director), so only combinations from
opposite ends of the agency are listed. To be edited by the Casting contact.

| Pair                                                | Why one person does not hold both on one project                    |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `finance` + `creative_director`                     | budget control and creative leadership are opposite seats           |
| `finance` + `account_director`                      | finance reviews what the client lead commits; independent by design |
| `executive_creative_director` + `account_executive` | top of the creative ladder and the junior client-service seat       |
| `account_director` + `art_director`                 | client lead and hands-on craft are different jobs on one project    |

## Validation label (one definition, shared with serving)

`activity_checked` means the claim is DATED (a period start or end is known) AND at
least one Layer 1 row behind it has source `drive_activity` (T2). Every other claim,
including every undated claim and every claim with no T2 row, is `not_validated`.
It says whether a claim could be cross-checked, never how accurate it is. It is not
stored: S7 computes it from the claim's period and the sources of its linked
evidence, with the same rule as `validationLabel()` in `fuse.ts`.

## Changing `fusion_version`: operational order

Serving (S7) reads exactly ONE version, named by the pin `CASTING_FUSION_VERSION`.
Applying a new version to an account removes that account's rows of every other
version in the same transaction, so after the apply the pinned (old) version has no
rows for that account and the served answer for it is EMPTY until the pin is
switched. Order:

1. Ship the code with the new `FUSION_VERSION`.
2. Run `--apply` for ALL accounts in as short a window as possible (dry-run first).
3. Switch `CASTING_FUSION_VERSION` to the new version immediately after the last
   account finishes.
4. Between steps 2 and 3 the answer is empty for the rebuilt accounts. If that is
   not acceptable, turn the serving kill switch off for the window.

Rolling back is the same order in reverse: deploy the old code, re-apply, switch the pin.

## Proxy metrics

`fuse()` returns counts per tier and fused: share of rows resolved to staff vs
external vs quarantined, claims withheld by reason, served claims backed by 2+
tiers, cross-document agreement, T2 agreement (a lower-bound proxy, only inside an
account's activity horizon, says nothing about older years), coverage per
account and year, served claims per year split by `activity_checked` /
`not_validated`. No precision or recall is computed: there is no ground truth.

## Deploy order (the P2022 trap)

The UB migration that creates `evidence`, `experience` and
`experience_evidence_links` (gub-schemas 1.23.0) must be applied BEFORE the job
runs, in either mode: a dry-run reads `evidence` too. Before the migration both
modes fail with Postgres 42P01 on purpose.
