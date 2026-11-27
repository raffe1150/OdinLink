import { knowledgeDatabaseRead, knowledgeOperation } from './knowledge-operation';
import { knowledgeSourceRevision, SupabaseKnowledgeStorage, type KnowledgeService } from '../../knowledge';
import { CORPUS_PIN_ID, SNAPSHOT_PIN_ID, isReservedPin, snapshotRevision } from './reference-snapshot';
import { captureVerified, resultDigest, safeUnavailableKnowledge, type KnowledgeAuthority, type KnowledgeTask } from './knowledge-lifecycle';
import type { KnowledgeDatabase } from './supabase-knowledge-lifecycle-repository';

/** Trusted backend dependency, never passed in a webhook or stored task input.
 * The implementation must use current authenticated provider ownership and real
 * channel eligibility, not a boolean copied out of a task/artifact. */
export interface KnowledgeProviderAuthority {
  canonicalConversationKey(task: KnowledgeTask): Promise<string | null>;
  eligible(task: KnowledgeTask): Promise<boolean>;
}
export async function knowledgeTurnCurrent(db: KnowledgeDatabase, task: KnowledgeTask,
  provider: KnowledgeProviderAuthority): Promise<boolean> {
  const scope = task.scope;
  const { data, error } = await knowledgeDatabaseRead(db.from('odin_conversations')
    .select('conversation_key,knowledge_channel,knowledge_account,knowledge_sequence')
    .eq('business_id', scope.businessId).eq('id', scope.conversationId).maybeSingle());
  if (error) throw new Error('knowledge_authority_read_failed');
  const key = await provider.canonicalConversationKey(task);
  return Boolean(data && key && key === data.conversation_key && data.knowledge_channel === scope.channel &&
    data.knowledge_account === scope.providerAccount && Number(data.knowledge_sequence) === task.sequence);
}

export function createKnowledgeAuthority(db: KnowledgeDatabase, sources: Pick<KnowledgeService, 'list'>,
  provider: KnowledgeProviderAuthority): KnowledgeAuthority {
  return async (task, phase) => {
    if (!task.result || task.resultDigest !== resultDigest(captureVerified(task.result))) return false;
    // Stored verification flags alone grant nothing: live scope, watermark,
    // source-wide revisions/readiness and provider ownership must all match.
    const scope = task.scope;
    const read = () => knowledgeTurnCurrent(db, task, provider);
    if (!await read()) return false;
    if (!await provider.eligible(task)) return false;
    if (task.result.protocol === 'safe-unavailable-v1' && task.result.text !== safeUnavailableKnowledge(task.input.language).text) return false;
    const live = task.result.sources.length ? await knowledgeOperation(()=>sources.list(scope.businessId)) : [];
    // Complete-snapshot results (Reference Knowledge verified absence / partial) carry the reserved pin SNAPSHOT_PIN_ID whose revision
    // is the digest of the exact source membership. Exact comparison, no timestamps: the tenant's live membership must be exactly the
    // pinned ready set (nothing added, removed, modified, newly ready, or still being extracted). Results without the pin: unchanged.
    const snapshotPin = task.result.sources.find(s => s.id === SNAPSHOT_PIN_ID);
    const corpusPin = task.result.sources.find(s => s.id === CORPUS_PIN_ID);
    const cited = task.result.sources.filter(s => !isReservedPin(s.id));
    if (snapshotPin && corpusPin) return false;
    if (corpusPin) {
      // Complete answers: cited sources stay exact (loop below) AND the whole ready corpus must be the one the answer was derived from.
      const tenant = live.filter(s => s.businessId === scope.businessId);
      if (tenant.some(s => ['pending', 'processing', 'failed', 'error'].includes(s.status))) return false;
      const ready = tenant.filter(s => s.status === 'ready');
      if (snapshotRevision(ready.map(s => ({ id: s.id, revision: knowledgeSourceRevision(s) }))) !== corpusPin.revision) return false;
    }
    if (snapshotPin) {
      if (snapshotPin.revision !== snapshotRevision(cited)) return false;
      const tenant = live.filter(s => s.businessId === scope.businessId);
      if (tenant.some(s => ['pending', 'processing', 'failed', 'error'].includes(s.status))) return false;
      const ready = tenant.filter(s => s.status === 'ready');
      if (ready.length !== cited.length || snapshotRevision(ready.map(s => ({ id: s.id, revision: knowledgeSourceRevision(s) }))) !== snapshotPin.revision) return false;
    }
    for (const source of cited) {
      const matches = live.filter(s => s.id === source.id && s.businessId === scope.businessId && s.status === 'ready');
      if (matches.length !== 1 || knowledgeSourceRevision(matches[0]) !== source.revision) return false;
    }
    // Source checks follow provider I/O; do not reuse a preflight source snapshot.
    // Recheck after async evidence/provider reads. SQL then atomically rechecks
    // current watermark, lease, expiry and digest-bound receipt freshness.
    return await read();
  };
}

/** Production composition: source reads go directly to the tenant-scoped
 * Supabase repository, with no in-memory fallback on database errors. */
export function createDatabaseKnowledgeAuthority(db: KnowledgeDatabase, provider: KnowledgeProviderAuthority): KnowledgeAuthority {
  return createKnowledgeAuthority(db, new SupabaseKnowledgeStorage(db), provider);
}
