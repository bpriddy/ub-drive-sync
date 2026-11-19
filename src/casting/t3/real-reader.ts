/**
 * The real document reader for T3: the repo's own extractor, behind the
 * DocumentReader interface. Lazy for the same reason as real-llm.ts: the
 * extractor module reads config and builds Workspace clients.
 */
import type { TraversedFile } from '../../drive/types';
import type { DocumentReader, ReadOutcome, T3Candidate } from './types';

export function toTraversedFile(c: T3Candidate): TraversedFile {
  return {
    id: c.fileId,
    name: c.name,
    mimeType: c.mimeType,
    path: c.ancestors.join(' / '),
    modifiedTime: c.modifiedTime,
    modifiedByEmail: null,
    createdTime: c.createdTime,
    size: null,
    isFolder: false,
    ...(c.md5Checksum ? { md5Checksum: c.md5Checksum } : {}),
  };
}

export function createRealReader(): DocumentReader {
  return {
    async read(c: T3Candidate): Promise<ReadOutcome> {
      const { extractText } = await import('../../drive/extract');
      const out = await extractText(toTraversedFile(c));
      return out.kind === 'ok'
        ? { kind: 'ok', text: out.text }
        : { kind: 'skip', reason: out.reason };
    },
  };
}
