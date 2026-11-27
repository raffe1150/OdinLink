/** EXPERIMENTAL — tenant-scoped, revision-pinned corpus for one reference turn. */
import { reason, type Reason } from './reasons';
import { sha256 } from './text-checks';
import { protectContent } from './secrets';
import { buildEvidenceMap, renderPassage, type EvidenceMap } from './evidence';
import type { PinnedSource, SourceRecord } from './types';

/** Revision = hash of the exact content bytes plus the row's update time. Any edit changes it. */
export const sourceRevision = (source: Pick<SourceRecord, 'content' | 'updatedAt'>): string =>
  'r_' + sha256(`${source.updatedAt}\u0000${source.content}`).slice(0, 24);

export type PinnedCorpus = Readonly<{ businessId: number; sources: readonly PinnedSource[]; byId: ReadonlyMap<string, PinnedSource>;
  /** Folded fingerprints of protected internal information (never shown to a model, never published). */
  protectedTokens: readonly string[];
  /** Software-owned sentence passages with short references (evidence.ts), built from exactly these pinned sources. */
  evidence: EvidenceMap }>;

/** Refuses the whole turn if any source belongs to another tenant, is not READY or is duplicated. Never filters silently. */
export function pinCorpus(businessId: number, records: readonly SourceRecord[], protectedTerms: readonly string[] = []): { corpus?: PinnedCorpus; reasons: Reason[] } {
  if (!Number.isSafeInteger(businessId) || businessId <= 0) return { reasons: [reason('INPUT_INVALID', 'input', true)] };
  if (!records.length) return { reasons: [reason('NO_SOURCES', 'input', true)] };
  const reasons: Reason[] = [];
  const byId = new Map<string, PinnedSource>();
  const tokens = new Set<string>();
  for (const record of records) {
    if (record.businessId !== businessId) { reasons.push(reason('TENANT_SOURCE_MISMATCH', 'input', true, { sourceId: record.id })); continue; }
    if (record.status !== 'ready') { reasons.push(reason('SOURCE_NOT_READY', 'input', true, { sourceId: record.id })); continue; }
    if (byId.has(record.id)) { reasons.push(reason('SOURCE_DUPLICATE_ID', 'input', true, { sourceId: record.id })); continue; }
    const guarded = protectContent(record.content, protectedTerms);
    guarded.tokens.forEach(t => tokens.add(t));
    byId.set(record.id, Object.freeze({ id: record.id, businessId, title: record.title, revision: record.revision ?? sourceRevision(record), content: record.content,
      modelContent: guarded.modelContent }));
  }
  if (reasons.length) return { reasons };
  const sources = Object.freeze([...byId.values()]);
  protectContent('', protectedTerms).tokens.forEach(t => tokens.add(t));
  return { corpus: Object.freeze({ businessId, sources, byId, protectedTokens: Object.freeze([...tokens]), evidence: buildEvidenceMap(businessId, sources) }), reasons: [] };
}

/** Model-facing rendering: each source's passages with their software-owned references. Source ids and revisions are not shown; software
 * resolves references to them. Source text is marked as untrusted data by the instructions. Redacted passages carry no reference. */
export function renderCorpus(corpus: PinnedCorpus): string {
  return corpus.sources.map(source => [
    `<source title=${JSON.stringify(source.title)}>`,
    ...corpus.evidence.passages.filter(p => p.sourceId === source.id).map(renderPassage),
    '</source>',
  ].join('\n')).join('\n\n');
}

/** Host-supplied check before publication: current revisions for the cited source ids (same tenant). */
export type RevalidateSources = (businessId: number, sourceIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
