import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts validates env at import; the scan core pulls it in transitively.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

const m = vi.hoisted(() => ({
  snapshotCreate: vi.fn(),
  extractText: vi.fn(),
  interpretFile: vi.fn(),
  queryRaw: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  restrictedFindMany: vi.fn(),
  restrictedUpdateMany: vi.fn(),
  extractIdeaCandidates: vi.fn(),
  mergeIdeaCandidates: vi.fn(),
  interpretAssetFolder: vi.fn(),
  captured: [] as string[],
}));
const { snapshotCreate, extractText, interpretFile, queryRaw, info, captured } = m;

vi.mock('../../prisma', () => ({
  prisma: {
    driveFileSnapshot: { create: m.snapshotCreate },
    $queryRaw: m.queryRaw,
    driveRestrictedFile: {
      findMany: m.restrictedFindMany,
      findUnique: vi.fn().mockResolvedValue({ id: 'worklist-row' }),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: m.restrictedUpdateMany,
    },
    campaign: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    campaignPiece: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: m.info, warn: m.warn, error: vi.fn() },
}));
vi.mock('../../drive/extract', async (importActual) => ({
  ...(await importActual<typeof import('../../drive/extract')>()),
  extractText: m.extractText,
}));
vi.mock('../../drive/interpret', async (importActual) => ({
  ...(await importActual<typeof import('../../drive/interpret')>()),
  interpretFile: m.interpretFile,
}));
vi.mock('../../drive/idea-scan', async (importActual) => ({
  ...(await importActual<typeof import('../../drive/idea-scan')>()),
  extractIdeaCandidates: m.extractIdeaCandidates,
  mergeIdeaCandidates: m.mergeIdeaCandidates,
}));
vi.mock('../../drive/asset-folder', () => ({ interpretAssetFolder: m.interpretAssetFolder }));
vi.mock('../output', async (importActual) => ({
  ...(await importActual<typeof import('../output')>()),
  log: (line = '') => void m.captured.push(line),
}));

import { config } from '../../config';
import { processBatch, type ProcessBatchOptions } from '../process-batch';
import type { EntityCtx } from '../batch-types';
import type { EntityAttribution } from '../../drive/structure';
import type { TraversedFile } from '../../drive/types';
import { binaryContentHash, contentZone } from '../content-gate';

const ACCOUNT_ZONE: EntityAttribution = {
  ownerType: 'account',
  campaignFolderId: null,
  campaignName: null,
  matchedCampaignId: null,
  campaignStatus: null,
  pieceId: null,
  pieceName: null,
  pieceFolderId: null,
};

function doc(id: string, over: Partial<TraversedFile> = {}): TraversedFile {
  return {
    id,
    name: `${id} brief`,
    mimeType: 'application/vnd.google-apps.document',
    parents: ['folder-misc'],
    path: `Acme / folder-misc / ${id} brief`,
    modifiedTime: '2026-09-20T10:00:00.000Z',
    modifiedByEmail: 'editor@example.com',
    createdTime: null,
    size: null,
    isFolder: false,
    ...over,
  };
}

function opts(over: Partial<ProcessBatchOptions> = {}): ProcessBatchOptions {
  return {
    ctx: {
      type: 'account',
      id: 'acct-1',
      name: 'Acme',
      folderId: 'folder-root',
      accountId: 'acct-1',
      accountFolderId: null,
      accountState: {},
      accountName: 'Acme',
      campaignName: null,
      campaignState: null,
      statusMarkdown: null,
      statusSensitiveMarkdown: null,
    } as EntityCtx,
    attributor: () => ACCOUNT_ZONE,
    nameDirectory: null,
    folderPathById: null,
    piecesById: null,
    familyByCampaignId: null,
    application: 'propose',
    editedAt: '2026-09-24',
    concurrency: 1,
    ...over,
  };
}

const setGate = (v: 'off' | 'on') => {
  (config as { SKIP_UNCHANGED_CONTENT: 'off' | 'on' }).SKIP_UNCHANGED_CONTENT = v;
};
const setVision = (v: 'off' | 'on') => {
  (config as { DRIVE_VISION_PDF: 'off' | 'on' }).DRIVE_VISION_PDF = v;
};
const rows = () => snapshotCreate.mock.calls.map((c) => c[0].data);

const ZONE = contentZone(ACCOUNT_ZONE);
const GATE = { unchangedGate: { notAfter: new Date('2026-10-20T00:00:00Z') } };
const pdf = (id: string, over: Partial<TraversedFile> = {}) =>
  doc(id, {
    mimeType: 'application/pdf',
    name: `${id}.pdf`,
    path: `Acme / folder-misc / ${id}.pdf`,
    size: 2048,
    md5Checksum: 'abc',
    ...over,
  });
const okPdf = (over: Record<string, unknown> = {}) => ({
  kind: 'ok',
  text: 'pdf text',
  contentHash: 'md5-of-text',
  extractor: 'pdf',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  captured.length = 0;
  snapshotCreate.mockResolvedValue({});
  queryRaw.mockResolvedValue([]);
  m.restrictedFindMany.mockResolvedValue([]);
  m.restrictedUpdateMany.mockResolvedValue({ count: 0 });
  m.extractIdeaCandidates.mockResolvedValue(null);
  m.mergeIdeaCandidates.mockResolvedValue(undefined);
  m.interpretAssetFolder.mockResolvedValue({ observations: [], driver: 'mock' });
  extractText.mockResolvedValue(okPdf());
  interpretFile.mockResolvedValue({
    account: [],
    campaign: [],
    deckType: 'other',
    truncated: false,
    driver: 'mock',
  });
});

afterEach(() => {
  setGate('off');
  setVision('off');
});

describe('processBatch asks for vision only with DRIVE_VISION_PDF on', () => {
  it('off: extractText is called with the file alone, as before', async () => {
    await processBatch([pdf('p')], opts());
    expect(extractText).toHaveBeenCalledTimes(1);
    expect(extractText.mock.calls[0]).toHaveLength(1);
    expect(captured.join('\n')).not.toContain('Vision PDFs');
    expect(info).not.toHaveBeenCalledWith(expect.anything(), '[scan.vision] batch');
  });

  it("on: extractText gets { vision: 'pdf' }", async () => {
    setVision('on');
    await processBatch([pdf('p')], opts());
    expect(extractText).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), {
      vision: 'pdf',
    });
  });
});

describe('a degraded vision outcome leaves no hash, so the file is read again', () => {
  beforeEach(() => {
    setVision('on');
    setGate('on');
  });

  it('transient failure: extracted row, content_hash null', async () => {
    extractText.mockResolvedValue(okPdf({ visionFallback: 'transient_error', degraded: true }));
    await processBatch([pdf('p')], opts(GATE));
    expect(rows()[0]).toMatchObject({ wasExtracted: true, contentHash: null });
    expect(interpretFile).toHaveBeenCalledTimes(1);
  });

  it('permanent fallback: the hash is kept (the text layer is the answer)', async () => {
    extractText.mockResolvedValue(okPdf({ visionFallback: 'over_page_cap' }));
    const file = pdf('p');
    await processBatch([file], opts(GATE));
    expect(rows()[0].contentHash).toBe(binaryContentHash(file, ZONE, false));
  });

  it('vision success: the hash carries the vision marker', async () => {
    extractText.mockResolvedValue(okPdf({ extractor: 'vision' }));
    const file = pdf('p');
    await processBatch([file], opts(GATE));
    const stored = rows()[0].contentHash;
    expect(stored).toMatch(/^bin:/);
    setVision('off');
    expect(stored).not.toBe(binaryContentHash(file, ZONE, false));
  });

  it('gate off: a degraded file keeps the extractor md5, like a failed idea pass', async () => {
    setGate('off');
    extractText.mockResolvedValue(okPdf({ visionFallback: 'transient_error', degraded: true }));
    await processBatch([pdf('p')], opts());
    expect(rows()[0]).toMatchObject({ contentHash: 'md5-of-text' });
  });
});

describe('turning the flag on re-reads a touched PDF once', () => {
  it('a prior hash from before the flag no longer matches; the vision hash does', async () => {
    setGate('on');
    const file = pdf('p');
    const before = binaryContentHash(file, ZONE, false)!;
    setVision('on');
    queryRaw.mockResolvedValue([{ fileId: 'p', contentHash: before }]);
    await processBatch([file], opts(GATE));
    expect(extractText).toHaveBeenCalledTimes(1); // re-read once

    extractText.mockClear();
    queryRaw.mockResolvedValue([
      { fileId: 'p', contentHash: binaryContentHash(file, ZONE, false)! },
    ]);
    await processBatch([file], opts(GATE));
    expect(extractText).not.toHaveBeenCalled(); // and now unchanged: no download
  });
});

describe('the run summary counts vision outcomes', () => {
  it('prints one line and one structured log with the counts and reasons', async () => {
    setVision('on');
    extractText
      .mockResolvedValueOnce(okPdf({ extractor: 'vision' }))
      .mockResolvedValueOnce(okPdf({ visionFallback: 'over_page_cap' }))
      .mockResolvedValueOnce(okPdf({ visionFallback: 'transient_error', degraded: true }));
    await processBatch([pdf('a'), pdf('b'), pdf('c')], opts());
    expect(captured.join('\n')).toContain(
      'Vision PDFs: 1 transcribed, 1 on the text layer, 1 degraded (retried at the next event)',
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        visionOk: 1,
        visionFellBack: 1,
        visionDegraded: 1,
        reasons: { over_page_cap: 1, transient_error: 1 },
      }),
      '[scan.vision] batch',
    );
  });
});
