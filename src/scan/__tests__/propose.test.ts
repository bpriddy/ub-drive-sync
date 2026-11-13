import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../prisma', () => ({
  prisma: {
    driveChangeProposal: {
      findMany: mocks.findMany,
      create: mocks.create,
    },
  },
}));
vi.mock('../../config', () => ({ config: { DRIVE_PROPOSAL_TTL_DAYS: 7 } }));
vi.mock('../output', () => ({ log: vi.fn() }));

import { loadPendingNoteTexts, proposeTarget } from '../propose';
import { log } from '../output';
import type { ProposeTargetInput } from '../propose';
import type { ValidatedChange } from '../persist';
import type { EntityCtx } from '../batch-types';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeCtx(overrides: Partial<EntityCtx> = {}): EntityCtx {
  return {
    type: 'account',
    id: 'acct-1',
    name: 'Acme',
    folderId: 'folder-1',
    accountId: 'acct-1',
    accountFolderId: 'folder-root-1',
    accountName: 'Acme',
    campaignName: null,
    reviewerEmail: 'reviewer@example.com',
    reviewerStaffId: 'staff-1',
    ...overrides,
  } as EntityCtx;
}

function makeChange(overrides: Partial<ValidatedChange> = {}): ValidatedChange {
  return {
    field: 'budget',
    spec: {} as ValidatedChange['spec'],
    validatedValue: 5000,
    previousValue: 4000,
    proposedValueRaw: '5000',
    confidence: 0.8,
    reasoning: 'Kickoff deck states the new budget',
    sourceFileIds: ['file-1', 'file-2'],
    ...overrides,
  };
}

function makeInput(overrides: Partial<ProposeTargetInput> = {}): ProposeTargetInput {
  return {
    ctx: makeCtx(),
    entityType: 'campaign',
    entityStatus: 'existing',
    entityId: 'camp-1',
    entityName: 'Spring Launch',
    validatedChanges: [],
    notes: [],
    driveSyncRunId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.create.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('proposeTarget: field_change rows', () => {
  it('writes one pending field_change row carrying provenance, reviewer and TTL expiry', async () => {
    const result = await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));

    expect(result).toEqual({
      fieldProposals: 1,
      noteItems: 0,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 0,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      kind: 'field_change',
      entityType: 'campaign',
      accountId: 'acct-1',
      campaignId: 'camp-1',
      property: 'budget',
      currentValue: 4000,
      proposedValue: 5000,
      reasoning: 'Kickoff deck states the new budget',
      sourceFileIds: ['file-1', 'file-2'],
      state: 'pending',
      reviewerEmail: 'reviewer@example.com',
      reviewerStaffId: 'staff-1',
    });
    expect(data.confidence).toBeInstanceOf(Prisma.Decimal);
    expect(data.confidence.toString()).toBe('0.8');
    expect(data.expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY_MS));
    expect(data.reviewToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives every row its own review token', async () => {
    await proposeTarget(
      makeInput({
        validatedChanges: [makeChange({ field: 'budget' }), makeChange({ field: 'status' })],
      }),
    );
    const tokens = mocks.create.mock.calls.map((c) => c[0].data.reviewToken);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('targets the account for an account-level change (campaignId null, accountId = entityId)', async () => {
    await proposeTarget(
      makeInput({
        entityType: 'account',
        entityStatus: 'account',
        entityId: 'acct-9',
        validatedChanges: [makeChange({ field: 'industry', validatedValue: 'Retail' })],
      }),
    );
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      entityType: 'account',
      accountId: 'acct-9',
      campaignId: null,
      property: 'industry',
      proposedValue: 'Retail',
    });
  });

  it('writes JSON null for a null previous/proposed value', async () => {
    await proposeTarget(
      makeInput({
        validatedChanges: [makeChange({ previousValue: null, validatedValue: null })],
      }),
    );
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data.currentValue).toBe(Prisma.JsonNull);
    expect(data.proposedValue).toBe(Prisma.JsonNull);
  });

  it('stamps null reviewer fields when the ctx has no reviewer', async () => {
    await proposeTarget(
      makeInput({
        ctx: makeCtx({ reviewerEmail: null, reviewerStaffId: null }),
        validatedChanges: [makeChange()],
      }),
    );
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      reviewerEmail: null,
      reviewerStaffId: null,
    });
  });

  it('expiry follows DRIVE_PROPOSAL_TTL_DAYS from config', async () => {
    const { config } = await import('../../config');
    (config as { DRIVE_PROPOSAL_TTL_DAYS: number }).DRIVE_PROPOSAL_TTL_DAYS = 30;
    try {
      await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    } finally {
      (config as { DRIVE_PROPOSAL_TTL_DAYS: number }).DRIVE_PROPOSAL_TTL_DAYS = 7;
    }
    expect(mocks.create.mock.calls[0]![0].data.expiresAt).toEqual(
      new Date(NOW.getTime() + 30 * DAY_MS),
    );
  });
});

describe('proposeTarget: re-propose guard', () => {
  it('reads every live pending field_change on the same target and property', async () => {
    await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        kind: 'field_change',
        entityType: 'campaign',
        accountId: 'acct-1',
        campaignId: 'camp-1',
        property: 'budget',
        state: 'pending',
        // Past its expiry but not yet swept: no longer a card the reviewer can act on.
        expiresAt: { gt: NOW },
      },
      select: { id: true, proposedValue: true },
    });
  });

  it('skips a change whose value equals the pending proposal and counts it', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'prop-1', proposedValue: 5000 }]);
    const result = await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    expect(result).toEqual({
      fieldProposals: 0,
      noteItems: 0,
      duplicatesSkipped: 1,
      noteDuplicatesSkipped: 0,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('compares structured values by content', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'prop-1', proposedValue: { a: 1, b: [2] } }]);
    const result = await proposeTarget(
      makeInput({ validatedChanges: [makeChange({ validatedValue: { a: 1, b: [2] } })] }),
    );
    expect(result.duplicatesSkipped).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('treats a pending null and an undefined proposed value as identical', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'prop-1', proposedValue: null }]);
    const result = await proposeTarget(
      makeInput({ validatedChanges: [makeChange({ validatedValue: undefined })] }),
    );
    expect(result.duplicatesSkipped).toBe(1);
  });

  it('still writes a new row when the pending proposal has a different value', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'prop-1', proposedValue: 4500 }]);
    const result = await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    expect(result).toEqual({
      fieldProposals: 1,
      noteItems: 0,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 0,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('skips a value any pending card carries, even when a newer card holds another', async () => {
    // A value was proposed (X), then a different one (Y); X comes back.
    mocks.findMany.mockResolvedValue([
      { id: 'prop-new', proposedValue: 4500 },
      { id: 'prop-old', proposedValue: 5000 },
    ]);
    const result = await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    expect(result).toEqual({
      fieldProposals: 0,
      noteItems: 0,
      duplicatesSkipped: 1,
      noteDuplicatesSkipped: 0,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('writes a new row when no pending card carries the value', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'prop-a', proposedValue: 4500 },
      { id: 'prop-b', proposedValue: 4000 },
    ]);
    const result = await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    expect(result).toEqual({
      fieldProposals: 1,
      noteItems: 0,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 0,
    });
  });

  it('dedupes per change: skips the duplicate, writes the other', async () => {
    mocks.findMany
      .mockResolvedValueOnce([{ id: 'prop-1', proposedValue: 5000 }])
      .mockResolvedValueOnce([]);
    const result = await proposeTarget(
      makeInput({
        validatedChanges: [
          makeChange({ field: 'budget' }),
          makeChange({ field: 'status', validatedValue: 'live' }),
        ],
      }),
    );
    expect(result).toEqual({
      fieldProposals: 1,
      noteItems: 0,
      duplicatesSkipped: 1,
      noteDuplicatesSkipped: 0,
    });
    expect(mocks.create.mock.calls[0]![0].data.property).toBe('status');
  });
});

describe('proposeTarget: note batches', () => {
  it('writes ONE additional_update row per target with the union of source files, confidence intact', async () => {
    const notes = [
      {
        text: 'Client prefers Tuesday syncs',
        source_file_ids: ['file-1', 'file-2'],
        confidence: 0.92,
      },
      { text: 'Legal review pending', source_file_ids: ['file-2', 'file-3'], confidence: 0.4 },
    ];
    const result = await proposeTarget(makeInput({ notes }));

    expect(result).toEqual({
      fieldProposals: 0,
      noteItems: 2,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 0,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      kind: 'additional_update',
      property: '__note__',
      entityType: 'campaign',
      accountId: 'acct-1',
      campaignId: 'camp-1',
      currentValue: Prisma.JsonNull,
      proposedValue: { items: notes },
      reasoning: null,
      sourceFileIds: ['file-1', 'file-2', 'file-3'],
      confidence: null,
      state: 'pending',
      reviewerEmail: 'reviewer@example.com',
      reviewerStaffId: 'staff-1',
    });
    expect(data.expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY_MS));
    expect(data.reviewToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes both field rows and a note batch in one call, field rows first', async () => {
    const result = await proposeTarget(
      makeInput({
        validatedChanges: [makeChange()],
        notes: [{ text: 'Note A', source_file_ids: ['file-9'] }],
      }),
    );
    expect(result).toEqual({
      fieldProposals: 1,
      noteItems: 1,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 0,
    });
    expect(mocks.create.mock.calls.map((c) => c[0].data.kind)).toEqual([
      'field_change',
      'additional_update',
    ]);
  });

  it('writes nothing for an empty change set', async () => {
    const result = await proposeTarget(makeInput());
    expect(result).toEqual({
      fieldProposals: 0,
      noteItems: 0,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 0,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('puts account-level notes on the account card', async () => {
    await proposeTarget(
      makeInput({
        entityType: 'account',
        entityStatus: 'account',
        entityId: 'acct-9',
        notes: [{ text: 'Renewal in Q3', source_file_ids: ['file-1'] }],
      }),
    );
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      entityType: 'account',
      accountId: 'acct-9',
      campaignId: null,
    });
  });
});

describe('proposeTarget: new-candidate fallback', () => {
  it('routes a new candidate to one marked note batch on the ACCOUNT card', async () => {
    const result = await proposeTarget(
      makeInput({
        entityStatus: 'new',
        entityId: null,
        entityName: 'Summer Promo',
        validatedChanges: [
          makeChange({ field: 'budget', proposedValueRaw: '9000', sourceFileIds: ['file-1'] }),
        ],
        notes: [{ text: 'Kickoff next week', source_file_ids: ['file-2'], confidence: 0.6 }],
      }),
    );

    expect(result).toEqual({
      fieldProposals: 0,
      noteItems: 2,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 0,
    });
    // No field_change guard read: the only lookup is the account card's pending notes.
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0]![0].where).toMatchObject({
      kind: 'additional_update',
      entityType: 'account',
      accountId: 'acct-1',
      campaignId: null,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      kind: 'additional_update',
      property: '__note__',
      entityType: 'account',
      accountId: 'acct-1',
      campaignId: null,
      sourceFileIds: ['file-1', 'file-2'],
      reviewerStaffId: 'staff-1',
    });
    expect(data.proposedValue).toEqual({
      items: [
        {
          text: '[new campaign candidate "Summer Promo"] budget: 9000',
          source_file_ids: ['file-1'],
          confidence: 0.8,
        },
        {
          text: '[new campaign candidate "Summer Promo"] Kickoff next week',
          source_file_ids: ['file-2'],
          confidence: 0.6,
        },
      ],
    });
  });

  it('renders a null raw value as "(null)"', async () => {
    await proposeTarget(
      makeInput({
        entityStatus: 'new',
        entityId: null,
        entityName: 'Summer Promo',
        validatedChanges: [makeChange({ field: 'owner', proposedValueRaw: null })],
      }),
    );
    expect(mocks.create.mock.calls[0]![0].data.proposedValue.items[0].text).toBe(
      '[new campaign candidate "Summer Promo"] owner: (null)',
    );
  });

  it('also takes the fallback for a campaign target without an id, whatever its status', async () => {
    await proposeTarget(
      makeInput({
        entityStatus: 'existing',
        entityId: null,
        entityName: 'Ghost Campaign',
        notes: [{ text: 'Seen in a folder name', source_file_ids: [] }],
      }),
    );
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data.entityType).toBe('account');
    expect(data.campaignId).toBeNull();
    expect(data.proposedValue.items[0].text).toBe(
      '[new campaign candidate "Ghost Campaign"] Seen in a folder name',
    );
  });

  it('writes nothing when a new candidate has no changes and no notes', async () => {
    const result = await proposeTarget(
      makeInput({ entityStatus: 'new', entityId: null, entityName: 'Empty' }),
    );
    expect(result).toEqual({
      fieldProposals: 0,
      noteItems: 0,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 0,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('proposeTarget: note exact-text guard', () => {
  const pendingNotes = (...texts: string[]) => [
    { proposedValue: { items: texts.map((text) => ({ text, source_file_ids: ['file-0'] })) } },
  ];

  it('reads the live pending notes of the same target before writing', async () => {
    await proposeTarget(
      makeInput({ notes: [{ text: 'Note A', source_file_ids: ['file-1'], confidence: 0.7 }] }),
    );
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        kind: 'additional_update',
        property: '__note__',
        entityType: 'campaign',
        accountId: 'acct-1',
        campaignId: 'camp-1',
        state: 'pending',
        expiresAt: { gt: NOW },
      },
      select: { proposedValue: true },
    });
  });

  it('drops an item whose exact text is pending and writes the others', async () => {
    mocks.findMany.mockResolvedValue(pendingNotes('Kickoff moved to March'));
    const result = await proposeTarget(
      makeInput({
        notes: [
          { text: 'Kickoff moved to March', source_file_ids: ['file-1'], confidence: 0.7 },
          { text: 'Legal review pending', source_file_ids: ['file-2'], confidence: 0.7 },
        ],
      }),
    );

    expect(result).toEqual({
      fieldProposals: 0,
      noteItems: 1,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 1,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data.proposedValue).toEqual({
      items: [{ text: 'Legal review pending', source_file_ids: ['file-2'], confidence: 0.7 }],
    });
    // The dropped item's files leave the row with it.
    expect(data.sourceFileIds).toEqual(['file-2']);
  });

  it('writes no row when every item is already pending', async () => {
    mocks.findMany.mockResolvedValue([
      ...pendingNotes('Kickoff moved to March'),
      ...pendingNotes('Legal review pending'),
    ]);
    const result = await proposeTarget(
      makeInput({
        notes: [
          { text: 'Kickoff moved to March', source_file_ids: ['file-1'], confidence: 0.7 },
          { text: 'Legal review pending', source_file_ids: ['file-2'], confidence: 0.7 },
        ],
      }),
    );
    expect(result).toEqual({
      fieldProposals: 0,
      noteItems: 0,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 2,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('still writes the field rows when every note is already pending', async () => {
    mocks.findMany
      .mockResolvedValueOnce([]) // field_change guard for 'budget'
      .mockResolvedValueOnce(pendingNotes('Note A'));
    const result = await proposeTarget(
      makeInput({
        validatedChanges: [makeChange()],
        notes: [{ text: 'Note A', source_file_ids: ['file-9'], confidence: 0.7 }],
      }),
    );
    expect(result).toEqual({
      fieldProposals: 1,
      noteItems: 0,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 1,
    });
    expect(mocks.create.mock.calls.map((c) => c[0].data.kind)).toEqual(['field_change']);
  });

  it('matches after trim and whitespace collapse, but never case or punctuation', async () => {
    mocks.findMany.mockResolvedValue(pendingNotes('Kickoff moved to March'));
    const dupes = [
      '  Kickoff moved to March',
      'Kickoff moved to March  ',
      'Kickoff   moved\tto\nMarch',
    ].map((text) => ({ text, source_file_ids: ['file-1'], confidence: 0.7 }));
    const written = [
      'Kickoff moved to March.',
      'kickoff moved to march',
      'The kickoff is now in March',
    ].map((text) => ({ text, source_file_ids: ['file-1'], confidence: 0.7 }));
    const result = await proposeTarget(makeInput({ notes: [...dupes, ...written] }));
    expect(result).toMatchObject({ noteItems: 3, noteDuplicatesSkipped: 3 });
    expect(mocks.create.mock.calls[0]![0].data.proposedValue).toEqual({ items: written });
  });

  it('compares against a pending text that carries stray whitespace, and stores the new text untouched', async () => {
    mocks.findMany.mockResolvedValue(pendingNotes('  Kickoff  moved to March '));
    const result = await proposeTarget(
      makeInput({
        notes: [
          { text: 'Kickoff moved to March', source_file_ids: ['file-1'], confidence: 0.7 },
          { text: ' Legal  review pending ', source_file_ids: ['file-2'], confidence: 0.7 },
        ],
      }),
    );
    expect(result).toMatchObject({ noteItems: 1, noteDuplicatesSkipped: 1 });
    expect(mocks.create.mock.calls[0]![0].data.proposedValue).toEqual({
      items: [{ text: ' Legal  review pending ', source_file_ids: ['file-2'], confidence: 0.7 }],
    });
  });

  it('drops a repeat inside one batch, first occurrence wins, and its files leave with it', async () => {
    const result = await proposeTarget(
      makeInput({
        notes: [
          { text: 'Kickoff moved to March', source_file_ids: ['file-1'], confidence: 0.9 },
          { text: 'Legal review pending', source_file_ids: ['file-2'], confidence: 0.7 },
          { text: 'Kickoff  moved to March ', source_file_ids: ['file-3'], confidence: 0.5 },
        ],
      }),
    );
    expect(result).toMatchObject({ noteItems: 2, noteDuplicatesSkipped: 1 });
    const data = mocks.create.mock.calls[0]![0].data;
    expect(data.proposedValue).toEqual({
      items: [
        { text: 'Kickoff moved to March', source_file_ids: ['file-1'], confidence: 0.9 },
        { text: 'Legal review pending', source_file_ids: ['file-2'], confidence: 0.7 },
      ],
    });
    expect(data.sourceFileIds).toEqual(['file-1', 'file-2']);
  });

  it('writes one row for a batch of identical items and none after it is pending', async () => {
    const table: Array<{ proposedValue: unknown }> = [];
    mocks.findMany.mockImplementation(async () => table);
    mocks.create.mockImplementation(async ({ data }: { data: { proposedValue: unknown } }) => {
      table.push({ proposedValue: data.proposedValue });
      return {};
    });
    const same = { text: 'Kickoff moved to March', source_file_ids: ['file-1'], confidence: 0.7 };
    expect(await proposeTarget(makeInput({ notes: [same, same] }))).toMatchObject({
      noteItems: 1,
      noteDuplicatesSkipped: 1,
    });
    expect(await proposeTarget(makeInput({ notes: [same, same] }))).toMatchObject({
      noteItems: 0,
      noteDuplicatesSkipped: 2,
    });
    expect(table).toHaveLength(1);
  });

  describe('against a table of rows', () => {
    type Row = {
      entityType: string;
      accountId: string | null;
      campaignId: string | null;
      state: string;
      expiresAt: Date;
      proposedValue: unknown;
    };
    let table: Row[];

    beforeEach(() => {
      table = [];
      // Applies the target, state and expiry filters of the real query, so the
      // test fails if the guard stops scoping its read.
      mocks.findMany.mockImplementation(
        async ({ where }: { where: Record<string, unknown> & { expiresAt: { gt: Date } } }) =>
          table.filter(
            (r) =>
              r.entityType === where.entityType &&
              r.accountId === where.accountId &&
              r.campaignId === where.campaignId &&
              r.state === where.state &&
              r.expiresAt > where.expiresAt.gt,
          ),
      );
      mocks.create.mockImplementation(async ({ data }: { data: Row }) => {
        table.push(data);
        return {};
      });
    });

    const note = [{ text: 'Kickoff moved to March', source_file_ids: ['file-1'], confidence: 0.7 }];

    it('writes the same text for another campaign and for the account', async () => {
      await proposeTarget(makeInput({ notes: note }));
      expect(table).toHaveLength(1);

      const otherCampaign = await proposeTarget(makeInput({ entityId: 'camp-2', notes: note }));
      expect(otherCampaign.noteItems).toBe(1);

      const account = await proposeTarget(
        makeInput({
          ctx: makeCtx(),
          entityType: 'account',
          entityStatus: 'account',
          entityId: 'acct-1',
          notes: note,
        }),
      );
      expect(account.noteItems).toBe(1);
      expect(table).toHaveLength(3);

      // ...and each target still blocks its own repeat.
      expect((await proposeTarget(makeInput({ notes: note }))).noteItems).toBe(0);
      expect(table).toHaveLength(3);
    });

    it('does not let an expired or decided card block a write', async () => {
      const row = (over: Partial<Row>): Row => ({
        entityType: 'campaign',
        accountId: 'acct-1',
        campaignId: 'camp-1',
        state: 'pending',
        expiresAt: new Date(NOW.getTime() + DAY_MS),
        proposedValue: { items: [{ text: 'Kickoff moved to March' }] },
        ...over,
      });

      table.push(row({ expiresAt: new Date(NOW.getTime() - 1) }));
      table.push(row({ state: 'expired' }));
      table.push(row({ state: 'rejected' }));
      expect((await proposeTarget(makeInput({ notes: note }))).noteItems).toBe(1);

      // The card just written is live now and blocks the repeat.
      expect((await proposeTarget(makeInput({ notes: note }))).noteItems).toBe(0);
    });

    it('writes the text again once the card it wrote has passed its TTL', async () => {
      expect((await proposeTarget(makeInput({ notes: note }))).noteItems).toBe(1);

      vi.setSystemTime(new Date(NOW.getTime() + 6 * DAY_MS)); // TTL is 7 days
      expect((await proposeTarget(makeInput({ notes: note }))).noteItems).toBe(0);

      vi.setSystemTime(new Date(NOW.getTime() + 8 * DAY_MS));
      expect((await proposeTarget(makeInput({ notes: note }))).noteItems).toBe(1);
      expect(table).toHaveLength(2);
    });
  });

  describe('log line', () => {
    const lastLog = () => String(vi.mocked(log).mock.calls.at(-1)![0]);

    beforeEach(() => {
      vi.mocked(log).mockClear();
    });

    it('is unchanged when no note is skipped', async () => {
      await proposeTarget(
        makeInput({
          notes: [{ text: 'Note A', source_file_ids: ['file-1'], confidence: 0.7 }],
        }),
      );
      expect(lastLog()).toBe('      → proposed for review: 0 field change(s), 1 note item(s)');
    });

    it('adds a note-specific suffix that the field suffix cannot be confused with', async () => {
      mocks.findMany
        .mockResolvedValueOnce(pendingNotes('unrelated')) // field guard sees a pending card
        .mockResolvedValueOnce(pendingNotes('Note A'));
      await proposeTarget(
        makeInput({
          validatedChanges: [makeChange({ validatedValue: 'x' })],
          notes: [
            { text: 'Note A', source_file_ids: ['file-1'], confidence: 0.7 },
            { text: 'Note B', source_file_ids: ['file-1'], confidence: 0.7 },
          ],
        }),
      );
      expect(lastLog()).toBe(
        '      → proposed for review: 1 field change(s), 1 note item(s) (1 note item(s) already pending)',
      );
    });
  });

  it('does not read pending notes when there are none to write', async () => {
    await proposeTarget(makeInput({ validatedChanges: [makeChange()] }));
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0]![0].where.kind).toBe('field_change');
  });

  it("new candidate: drops its own pending item, keeps one pending under another candidate's marker", async () => {
    mocks.findMany.mockResolvedValue(
      pendingNotes(
        '[new campaign candidate "Summer Promo"] Kickoff next week',
        '[new campaign candidate "Fall Promo"] Budget approved',
        'Budget approved',
      ),
    );
    const result = await proposeTarget(
      makeInput({
        entityStatus: 'new',
        entityId: null,
        entityName: 'Summer Promo',
        notes: [
          { text: 'Kickoff next week', source_file_ids: ['file-1'], confidence: 0.7 },
          { text: 'Budget approved', source_file_ids: ['file-2'], confidence: 0.7 },
        ],
      }),
    );

    expect(result).toEqual({
      fieldProposals: 0,
      noteItems: 1,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 1,
    });
    expect(mocks.create.mock.calls[0]![0].data.proposedValue).toEqual({
      items: [
        {
          text: '[new campaign candidate "Summer Promo"] Budget approved',
          source_file_ids: ['file-2'],
          confidence: 0.7,
        },
      ],
    });
  });

  it('new candidate: writes no row when every marked item is already pending', async () => {
    mocks.findMany.mockResolvedValue(
      pendingNotes(
        '[new campaign candidate "Summer Promo"] budget: 9000',
        '[new campaign candidate "Summer Promo"] Kickoff next week',
      ),
    );
    const result = await proposeTarget(
      makeInput({
        entityStatus: 'new',
        entityId: null,
        entityName: 'Summer Promo',
        validatedChanges: [makeChange({ field: 'budget', proposedValueRaw: '9000' })],
        notes: [{ text: 'Kickoff next week', source_file_ids: ['file-2'], confidence: 0.7 }],
      }),
    );
    expect(result).toEqual({
      fieldProposals: 0,
      noteItems: 0,
      duplicatesSkipped: 0,
      noteDuplicatesSkipped: 2,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('a replayed window writes its notes once (E2-F3)', async () => {
    // The prisma mocks behave like a table: what attempt 1 wrote is pending on attempt 2.
    const table: Array<{ proposedValue: unknown }> = [];
    mocks.findMany.mockImplementation(async () => table);
    mocks.create.mockImplementation(async ({ data }: { data: { proposedValue: unknown } }) => {
      table.push({ proposedValue: data.proposedValue });
      return {};
    });
    const input = makeInput({
      notes: [{ text: 'Kickoff moved to March', source_file_ids: ['file-1'], confidence: 0.7 }],
    });

    expect(await proposeTarget(input)).toMatchObject({ noteItems: 1, noteDuplicatesSkipped: 0 });
    expect(await proposeTarget(input)).toMatchObject({ noteItems: 0, noteDuplicatesSkipped: 1 });
    expect(table).toHaveLength(1);
  });
});

describe('loadPendingNoteTexts', () => {
  it('queries pending, unexpired __note__ additional_updates for the exact target', async () => {
    await loadPendingNoteTexts({
      entityType: 'campaign',
      accountId: 'acct-1',
      campaignId: 'camp-1',
    });
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        kind: 'additional_update',
        property: '__note__',
        entityType: 'campaign',
        accountId: 'acct-1',
        campaignId: 'camp-1',
        state: 'pending',
        expiresAt: { gt: NOW },
      },
      select: { proposedValue: true },
    });
  });

  it('flattens item texts across rows in order', async () => {
    mocks.findMany.mockResolvedValue([
      { proposedValue: { items: [{ text: 'first' }, { text: 'second' }] } },
      { proposedValue: { items: [{ text: 'third' }] } },
    ]);
    await expect(
      loadPendingNoteTexts({ entityType: 'account', accountId: 'acct-1', campaignId: null }),
    ).resolves.toEqual(['first', 'second', 'third']);
  });

  it('drops blank, non-string and malformed items and tolerates null / itemless values', async () => {
    mocks.findMany.mockResolvedValue([
      { proposedValue: null },
      { proposedValue: {} },
      {
        proposedValue: {
          items: [{ text: '   ' }, { text: '' }, { text: 42 }, {}, null, { text: 'kept' }],
        },
      },
    ]);
    await expect(
      loadPendingNoteTexts({ entityType: 'account', accountId: 'acct-1', campaignId: null }),
    ).resolves.toEqual(['kept']);
  });

  it('returns an empty list when nothing is pending', async () => {
    await expect(
      loadPendingNoteTexts({ entityType: 'account', accountId: 'acct-1', campaignId: null }),
    ).resolves.toEqual([]);
  });
});

describe('proposeTarget: drive_sync_run_id', () => {
  // The queue row goes in drive_sync_run_id, never in sync_run_id: that column
  // references the v1 sync_runs table, so a queue id there fails the foreign
  // key. The real-schema check is in forward/__tests__/snapshot-index.pg.test.ts.
  const RUN = '8d0c4a52-3f6e-4b7a-9c1d-2e5f60718293';
  const NOTE = { text: 'Launch moved to October', source_file_ids: ['file-1'] };
  const rows = () => mocks.create.mock.calls.map((c) => c[0].data);

  it('stamps the queue run on the field_change row and on the note batch', async () => {
    await proposeTarget(
      makeInput({ validatedChanges: [makeChange()], notes: [NOTE], driveSyncRunId: RUN }),
    );

    expect(rows().map((r) => r.kind)).toEqual(['field_change', 'additional_update']);
    for (const row of rows()) {
      expect(row.driveSyncRunId).toBe(RUN);
      expect(row).not.toHaveProperty('syncRunId');
    }
  });

  it('stamps the account-card fallback written for a new campaign candidate', async () => {
    await proposeTarget(
      makeInput({
        entityStatus: 'new',
        entityId: null,
        entityName: 'Fall Promo',
        notes: [NOTE],
        driveSyncRunId: RUN,
      }),
    );

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      kind: 'additional_update',
      entityType: 'account',
      accountId: 'acct-1',
      driveSyncRunId: RUN,
    });
  });

  it('writes null when the caller has no run row', async () => {
    await proposeTarget(makeInput({ validatedChanges: [makeChange()], notes: [NOTE] }));

    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.driveSyncRunId)).toEqual([null, null]);
  });
});
