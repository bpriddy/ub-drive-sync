/**
 * Loader + fusion, end to end on synthetic data: an edited file is loaded as a full new set
 * of rows (the claim hash carries the content version), the sink stays insert-or-ignore, and
 * fusion counts only the newest load of the file. No database, Drive or model.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { fuse } from '../../fusion/fuse';
import type { FusionEvidence, FusionOutput, FusionStaff } from '../../fusion/types';
import {
  ACCOUNT as FUSION_ACCOUNT,
  PIECE,
  baseInput,
  ev,
  resetIds,
} from '../../fusion/__tests__/fixtures';
import { buildRosterIndex, type RosterIndex } from '../../identity';
import { ROSTER } from '../../identity/__tests__/roster.fixture';
import type { CellRecord } from '../ledger';
import { cellKeyOf } from '../ledger';
import { newResolveCounts, resolveLedgerRecords } from '../resolve-mentions';
import { MemorySink } from '../sink';
import type { GroundedMention } from '../ground';

let roster: RosterIndex;
beforeAll(() => {
  roster = buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] });
});

const NOW = new Date('2026-11-20T00:00:00Z');
const SIG = { promptVersion: 'p1', model: 'm', thinkingLevel: 'LOW', capChars: 1000 };
const EXTRACTOR = 't3-p1:m:low';
const JURGEN = 'staff-05';
const ZOFIA = 'staff-01';
const LUKASZ = 'staff-06';

const mention = (rawName: string, rawRole: string): GroundedMention => ({
  rawName,
  rawRole,
  quote: null,
  isClientSide: false,
  periodText: null,
  location: 'slide 2',
});

/** One ok cell of one file at one content version (md5), with its mentions. */
function cell(fileId: string, md5: string, mentions: GroundedMention[]): CellRecord {
  return {
    v: 1,
    cellKey: cellKeyOf({ fileId, md5Checksum: md5, modifiedTime: null }, SIG),
    extractorVersion: EXTRACTOR,
    at: '2026-11-20T00:00:00Z',
    status: 'ok',
    reason: null,
    candidate: {
      fileId,
      accountId: FUSION_ACCOUNT,
      createdTime: '2025-01-01T00:00:00Z',
      md5Checksum: md5,
      projectRef: { jobNumber: null, campaignId: null, pieceId: PIECE },
    },
    docClass: 'pdf',
    contentHash: null,
    docType: 'credits_or_team',
    truncated: false,
    sentChars: 100,
    attempts: 1,
    usage: null,
    mentions,
    sanitizeStats: null,
    groundingStats: null,
  } as CellRecord;
}

const load = (records: CellRecord[]) =>
  resolveLedgerRecords(
    records,
    { roster, now: NOW, selectionEdges: [], selectedKeys: null },
    newResolveCounts(),
  ).map((d) => d.row);

/** What the T3 sink does: one run per load, insert-or-ignore on (extractor_version, claim_hash). */
async function loadInto(sink: MemorySink, records: CellRecord[]) {
  const { syncRunId } = await sink.startRun();
  const w = await sink.writeEvidence(syncRunId, load(records));
  return { syncRunId, ...w };
}

const STAFF: FusionStaff[] = [JURGEN, ZOFIA, LUKASZ].map((staffId) => ({
  staffId,
  startedAt: null,
  isCurrent: true,
}));

/** The sink's rows as the fusion reads them, with the start of each run in load order. */
function asEvidence(sink: MemorySink): FusionEvidence[] {
  resetIds();
  const out: FusionEvidence[] = [];
  for (const r of sink.rows.values()) {
    const n = Number(r.sync_run_id.replace('run-', ''));
    out.push(
      ev({
        source: 'drive_content',
        staffId: r.staff_id,
        personKind: r.person_kind,
        roleNorm: r.role_norm,
        pieceId: r.piece_id,
        fileId: r.file_id,
        confidence: r.confidence,
        withheldReason: r.withheld_reason,
        extractorVersion: r.extractor_version,
        syncRunId: r.sync_run_id,
        loadedAt: `2026-11-${String(10 + n).padStart(2, '0')}T08:00:00.000000Z`,
      }),
    );
  }
  // Presence evidence of every person on the project, so the T3 row can reach the gate.
  for (const staffId of [JURGEN, ZOFIA, LUKASZ]) {
    out.push(
      ev({ source: 'drive_metadata', staffId, pieceId: PIECE, fileId: 'meta', confidence: 0.3 }),
    );
    out.push(
      ev({ source: 'drive_activity', staffId, pieceId: PIECE, fileId: 'act', confidence: 0.12 }),
    );
  }
  return out;
}

const fuseSink = (sink: MemorySink): FusionOutput =>
  fuse({ ...baseInput(asEvidence(sink)), staff: STAFF });
const people = (out: FusionOutput): string[] =>
  out.claims
    .filter((c) => c.row.withheldReason === null)
    .map((c) => c.row.staffId)
    .sort();

const V1 = [
  mention('Jürgen Falkenrath', 'Creative Director'),
  mention('Zofia Marek-Lindqvist', 'Senior Copywriter'),
];
// Version 2: Jürgen unchanged (identical claim), Zofia removed, Łukasz added.
const V2 = [
  mention('Jürgen Falkenrath', 'Creative Director'),
  mention('Łukasz Wieczorkiewicz', 'Art Director'),
];

describe('content version in the T3 claim hash', () => {
  it('loading the SAME ledger again inserts nothing (same content, same hash)', async () => {
    const sink = new MemorySink();
    const records = [cell('f1', 'md5-a', V1)];
    const first = await loadInto(sink, records);
    const again = await loadInto(sink, records);
    expect(first.inserted).toBe(2);
    expect(again).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(sink.rows.size).toBe(2);
  });

  it('a changed file writes every claim of its new version as new rows, the unchanged one too', async () => {
    const sink = new MemorySink();
    await loadInto(sink, [cell('f1', 'md5-a', V1)]);
    const second = await loadInto(sink, [cell('f1', 'md5-b', V2)]);
    expect(second.inserted).toBe(2); // Jürgen (identical claim) and Łukasz
    expect(sink.rows.size).toBe(4);
  });

  it('the same text in another file is not a duplicate of the first file (file id is still in the hash)', async () => {
    const sink = new MemorySink();
    await loadInto(sink, [cell('f1', 'md5-a', V1), cell('f2', 'md5-a', V1)]);
    expect(sink.rows.size).toBe(4);
  });
});

describe('edit case, loader + fusion', () => {
  it('keeps every person still in the new version, drops the removed one, adds the new one', async () => {
    const sink = new MemorySink();
    await loadInto(sink, [cell('f1', 'md5-a', V1)]);
    expect(people(fuseSink(sink))).toEqual([JURGEN, ZOFIA].sort());
    await loadInto(sink, [cell('f1', 'md5-b', V2)]);
    const out = fuseSink(sink);
    // Jürgen is in both versions: kept. Zofia only in the old one: no claim. Łukasz: new.
    expect(people(out)).toEqual([JURGEN, LUKASZ].sort());
    expect(out.metrics.olderContentVersion).toBe(2);
  });

  it('gives the same Layer 2 as a fresh load of only the new version', async () => {
    const edited = new MemorySink();
    await loadInto(edited, [cell('f1', 'md5-a', V1)]);
    await loadInto(edited, [cell('f1', 'md5-b', V2)]);
    const fresh = new MemorySink();
    await loadInto(fresh, [cell('f1', 'md5-b', V2)]);
    const shape = (o: FusionOutput) => o.claims.map((c) => ({ row: c.row, tiers: c.tiers }));
    expect(shape(fuseSink(edited))).toEqual(shape(fuseSink(fresh)));
  });

  it('a person in both versions is counted once, not twice', async () => {
    const sink = new MemorySink();
    await loadInto(sink, [cell('f1', 'md5-a', V1)]);
    await loadInto(sink, [cell('f1', 'md5-b', V1)]); // md5 changed, claims identical
    const claim = fuseSink(sink).claims.find((c) => c.row.staffId === JURGEN)!;
    expect(claim.evidenceIds).toHaveLength(3); // one T3 row + T1 + T2
    expect(sink.rows.size).toBe(4);
  });

  it('rows an older loader wrote (no content version in the hash) count as one load, like any other', async () => {
    const sink = new MemorySink();
    // The S5c load: the legacy hash. Simulated by inserting the rows under their old hash.
    const { syncRunId } = await sink.startRun();
    const legacy = load([cell('f1', 'md5-a', V1)]).map((r, i) => ({
      ...r,
      claim_hash: `legacy-${i}`,
    }));
    await sink.writeEvidence(syncRunId, legacy);
    // Alone, they are the file's only load: both people count.
    expect(people(fuseSink(sink))).toEqual([JURGEN, ZOFIA].sort());
    // Re-loading the same ledger the new way adds a second, equal load: counted once, not twice.
    await loadInto(sink, [cell('f1', 'md5-a', V1)]);
    const out = fuseSink(sink);
    expect(people(out)).toEqual([JURGEN, ZOFIA].sort());
    expect(out.claims.find((c) => c.row.staffId === JURGEN)!.evidenceIds).toHaveLength(3);
    // A later edit supersedes both.
    await loadInto(sink, [cell('f1', 'md5-b', V2)]);
    expect(people(fuseSink(sink))).toEqual([JURGEN, LUKASZ].sort());
  });
});
