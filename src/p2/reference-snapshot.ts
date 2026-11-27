/** Complete-snapshot source pin (Reference Knowledge, Production Integration Phase 3). Shared by the adapter and KnowledgeAuthority.
 * A result whose pins include SNAPSHOT_PIN_ID claims to depend on the tenant's ENTIRE authorized source set (a verified absence or a
 * partial answer); its revision is the digest of that exact membership, compared exactly (no timestamps) at finalization and delivery. */
import { createHash } from 'node:crypto';
export const SNAPSHOT_PIN_ID = 'snapshot:v1';
/** Phase 5: complete answers carry CORPUS_PIN_ID = digest of the whole authorized corpus they were derived from, while their other
 * pins remain exactly the cited sources. A source added, removed, modified, newly ready, disabled or failing invalidates the answer. */
export const CORPUS_PIN_ID = 'corpus:v1';
export const isReservedPin = (id: string) => id === SNAPSHOT_PIN_ID || id === CORPUS_PIN_ID;
export function snapshotRevision(pins: readonly Readonly<{ id: string; revision: string }>[]): string {
  const sorted = [...pins].map(p => [p.id, p.revision]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
