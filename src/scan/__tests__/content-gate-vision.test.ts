/**
 * The vision marker on the unchanged-content hash (DRIVE_VISION_PDF). With the
 * flag off every hash is byte-identical to the one before vision existed (a
 * golden value, computed from the pre-vision formula); with it on, only a PDF
 * vision will read changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});
vi.mock('../../prisma', () => ({ prisma: { driveSyncRun: { findFirst: vi.fn() } } }));

import { config } from '../../config';
import { binaryContentHash, contentHashFor, contentZone } from '../content-gate';
import type { EntityAttribution } from '../../drive/structure';
import type { TraversedFile } from '../../drive/types';

const ACCOUNT: EntityAttribution = {
  ownerType: 'account',
  campaignFolderId: null,
  campaignName: null,
  matchedCampaignId: null,
  campaignStatus: null,
  pieceId: null,
  pieceName: null,
  pieceFolderId: null,
};
const zone = contentZone(ACCOUNT);

function file(over: Partial<TraversedFile> = {}): TraversedFile {
  return {
    id: 'f1',
    name: 'deck.pdf',
    mimeType: 'application/pdf',
    path: 'Acme / deck.pdf',
    modifiedTime: null,
    modifiedByEmail: null,
    createdTime: null,
    size: 1_000_000,
    isFolder: false,
    md5Checksum: 'abc',
    ...over,
  };
}

const setVision = (v: 'off' | 'on') => {
  (config as { DRIVE_VISION_PDF: string }).DRIVE_VISION_PDF = v;
};
afterEach(() => setVision('off'));

/** sha256 of JSON [1, "md5:abc", 40000, "deck.pdf", "Acme / deck.pdf", <zone>, false]: the formula before vision. */
const GOLDEN_FLAG_OFF = 'bin:6f02c6fd17f2de20931ae9894b7e012646ffffe046b9b69fcda705db538129fd';

describe('flag off: hashes are byte-identical to before', () => {
  it('a PDF bin: hash equals the golden value', () => {
    expect(binaryContentHash(file(), zone, false)).toBe(GOLDEN_FLAG_OFF);
  });

  it('is the default', () => {
    expect(config.DRIVE_VISION_PDF).toBe('off');
  });
});

describe('flag on', () => {
  it('a PDF the caps admit gets a different bin: hash, so a touched PDF is re-read once', () => {
    setVision('on');
    const on = binaryContentHash(file(), zone, false);
    expect(on).toMatch(/^bin:[0-9a-f]{64}$/);
    expect(on).not.toBe(GOLDEN_FLAG_OFF);
    expect(contentHashFor(file(), 'text', zone, false)).toBe(on);
  });

  it('every other hash is unchanged', () => {
    const others: TraversedFile[] = [
      file({ mimeType: 'text/plain', name: 'n.txt', md5Checksum: 'x' }),
      file({
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        md5Checksum: 'x',
      }),
      file({
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        md5Checksum: 'x',
      }),
      // A PDF vision will not read: over the cap, or of unknown size.
      file({ size: config.DRIVE_VISION_MAX_FILE_SIZE_BYTES + 1 }),
      file({ size: null }),
    ];
    const off = others.map((f) => binaryContentHash(f, zone, false));
    setVision('on');
    expect(others.map((f) => binaryContentHash(f, zone, false))).toEqual(off);
    // A Google-native file keeps its text hash.
    const doc = file({ mimeType: 'application/vnd.google-apps.document', md5Checksum: undefined });
    setVision('off');
    const docOff = contentHashFor(doc, 'same text', zone, false);
    setVision('on');
    expect(binaryContentHash(doc, zone, false)).toBeNull();
    expect(contentHashFor(doc, 'same text', zone, false)).toBe(docOff);
  });

  it('a shortcut to a PDF has no bin: hash, flag or not', () => {
    setVision('on');
    expect(
      binaryContentHash(
        file({ shortcutTarget: { id: 't', mimeType: 'application/pdf' } }),
        zone,
        false,
      ),
    ).toBeNull();
  });
});
