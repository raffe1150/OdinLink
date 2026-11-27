/**
 * Reference Knowledge Engine — production adapter (Production Integration Phase 1). DEFAULT OFF.
 *
 * The ONLY production file allowed to import src/experimental/knowledge-reference (isolation test). It runs inside the existing
 * KnowledgeRunner contract (`KnowledgeExecutor`): the runner keeps claim, lease, fence, finalization and delivery; this adapter only
 * produces a `VerifiedKnowledge | null` for one admitted task. It never performs booking actions (no tools), never retries, and never
 * falls back to an unverified answer after a verification failure (null → the runner's fixed safe-unavailable reply).
 *
 * Source authority: sources come from the host's tenant-scoped list; each is pinned with the host's `knowledgeSourceRevision`, the
 * same value KnowledgeAuthority re-checks at finalization and delivery. A verified absence (limitation) is bound to the WHOLE pinned
 * snapshot: such results carry every pinned source, and the adapter re-lists the tenant before returning to prove the snapshot is
 * unchanged (no source changed, removed or added).
 *
 * Money: every provider dispatch is preceded by the runner's `reserveModelAttempt()` and by a reservation with the installed durable
 * money owner (`KnowledgeBudgetOwner`, odin_ai_money_v1); usage is settled from the provider receipt and an unknown outcome is
 * retained, never released. The provider transport is injected; none is installed by this file.
 */
import { createHash } from 'node:crypto';
import { knowledgeSourceRevision, type KnowledgeSource } from '../../knowledge';
import { captureVerified, type KnowledgeTask, type VerifiedKnowledge } from './knowledge-lifecycle';
import { CORPUS_PIN_ID, SNAPSHOT_PIN_ID, snapshotRevision } from './reference-snapshot';
export { CORPUS_PIN_ID, SNAPSHOT_PIN_ID, snapshotRevision } from './reference-snapshot';
import type { KnowledgeExecutor } from './knowledge-runner';
import { knowledgeExecutionDeadline } from './knowledge-operation';
import { canonicalMessageSpendActive, inboundMessageSpendKey, KNOWLEDGE_SOL_RATES, type KnowledgeBudgetOwner, type KnowledgeCostQuote, type KnowledgeUsage } from '../ai/knowledge-model-policy';
import { runReferenceAnswer, responsesBody, REFERENCE_MAX_OUTPUT, type ProviderRequest, type ProviderResult, type ReferenceProvider,
  type ReferenceResult, type SourceRecord } from '../experimental/knowledge-reference/index';

// ---------------------------------------------------------------- configuration (server-side, default OFF)
export type ReferenceEngineMode = 'off' | 'owner' | 'active';
export type ReferenceEngineConfig = Readonly<{ mode: ReferenceEngineMode; tenants: ReadonlySet<number>; ownerConversations: ReadonlySet<string> }>;
const OFF: ReferenceEngineConfig = Object.freeze({ mode: 'off', tenants: new Set<number>(), ownerConversations: new Set<string>() });

/** ODINLINK_KNOWLEDGE_REFERENCE_ENGINE=off|owner|active, ODINLINK_KNOWLEDGE_REFERENCE_TENANTS=<exactly one pilot tenant>,
 * ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS=<businessId>:<channel>:<durableConversationUuid>[,…]. The identity is the AUTHENTICATED
 * DURABLE CONVERSATION UUID (odin_conversations.id, task.scope.conversationId) — NOT the raw provider recipient id used by the routing
 * allowlist. Entries for another tenant are ignored. Anything missing or malformed → OFF. */
export function referenceEngineConfig(env: Readonly<Record<string, string | undefined>> = process.env): ReferenceEngineConfig {
  const mode = env.ODINLINK_KNOWLEDGE_REFERENCE_ENGINE;
  if (mode !== 'owner' && mode !== 'active') return OFF;
  // Pilot scope: exactly one approved tenant.
  const tenantText = (env.ODINLINK_KNOWLEDGE_REFERENCE_TENANTS ?? '').trim();
  if (!/^[1-9]\d{0,9}$/u.test(tenantText)) return OFF;
  const tenant = Number(tenantText);
  const owners = (env.ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS ?? '').split(',').map(t => t.trim()).filter(Boolean);
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const valid = owners.filter(o => { const m = new RegExp(`^([1-9]\\d{0,9}):(whatsapp|telegram|instagram|messenger):(${uuid})$`, 'u').exec(o); return !!m && Number(m[1]) === tenant; });
  if (mode === 'owner' && (!owners.length || valid.length !== owners.length)) return OFF;
  return Object.freeze({ mode, tenants: new Set([tenant]), ownerConversations: new Set(valid) });
}

/** Server-side selection for one task. Owner mode needs the exact conversation on the allowlist, not only the tenant. */
export function referenceEngineSelected(task: KnowledgeTask, config: ReferenceEngineConfig): boolean {
  if (config.mode === 'off' || !config.tenants.has(task.scope.businessId)) return false;
  return config.mode === 'active' || config.ownerConversations.has(`${task.scope.businessId}:${task.scope.channel}:${task.scope.conversationId}`);
}

// ---------------------------------------------------------------- admission (Blockers B and D)
export const REFERENCE_ADMISSION = Object.freeze({
  /** captureVerified accepts at most 10 pins; a verified absence carries the whole snapshot plus the snapshot pin. */
  maxSources: 9,
  /** Model-visible corpus text (UTF-8 bytes). Tenant 3 today ≈ 8 KB; ~12k tokens at 4 bytes/token, far below the model context. */
  maxCorpusBytes: 48_000,
  /** Answer request bytes above the corpus, question and history (measured on Pilot 7: ≈ 6.5 KB; +10%). */
  requestOverheadBytes: 7_168,
  /** Verifier request above the answer request: the reply segments (≤ 2,048 output tokens at ≤ 4 bytes/token) plus framing. A
   * PRE-FILTER only: the exact quote at dispatch (real bytes) is what the database admits or denies. */
  verifierExtraBytes: 12_288,
  /** Stage budgets, derived from the worker's real compute deadline (never task expiry) and the genuine Sol latencies measured on
   * Stages A–D (answer p95 7.6 s / max 7.6 s; verifier p95 10.2 s / max 10.2 s): each stage may use up to its cap; the answer stage never
   * consumes the verifier's reserved floor; a stage is not dispatched with less than its floor left. The runner's own reserve
   * (finalization + delivery, up to 15 s) lies AFTER the compute deadline and is untouched. */
  answerMs: 20_000, verifierMs: 20_000, answerFloorMs: 12_000, verifierFloorMs: 12_000, marginMs: 1_500,
  /** The money authority's Sol contract (odin_ai_money_v1): outputTokenLimit must be 8192 and
   * maximumNanoUsd = inputTokenProxy × 2,500 + 8,192 × 10,000, with inputTokenProxy = request bytes + 2,048 (as production quotes).
   * The engine SENDS max_output_tokens 2,048 per stage, so the reservation always covers the request (and settles at actual usage);
   * an exact reservation = request limit match needs a reviewed migration of that contract. */
  quoteOutputTokens: 8192,
  proxyFramingBytes: 2048,
});
export type AdmissionRefusal = 'CONFIGURED_POLICY_AUTHORITY' | 'LANGUAGE_UNSUPPORTED' | 'TENANT_MISMATCH' | 'CORPUS_INCOMPLETE' | 'NO_SOURCES' | 'TOO_MANY_SOURCES'
  | 'DOCUMENT_INCOMPLETE' | 'CORPUS_TOO_LARGE' | 'COST_ABOVE_OWNER_LIMIT' | 'INSUFFICIENT_TIME' | 'NO_MONEY_OWNER';
const LANGUAGES = ['sv', 'en', 'de', 'es', 'fa', 'ar'] as const;
type Lang = typeof LANGUAGES[number];
const IN_FLIGHT = new Set(['pending', 'processing', 'error', 'failed']);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
/** Worst-case nano-USD of one request: every input token billed at the cache-write rate (1 token ≥ 1 byte) plus the quoted output. */
const worstNano = (requestBytes: number) =>
  Math.ceil((requestBytes + REFERENCE_ADMISSION.proxyFramingBytes) * KNOWLEDGE_SOL_RATES.cacheWrite * 1000 +
    REFERENCE_ADMISSION.quoteOutputTokens * KNOWLEDGE_SOL_RATES.output * 1000);

/** A document is usable only if its extracted text is complete by the host's own rule: ordered, in-bounds segments that cover all
 * non-whitespace content (the same rule as knowledge.ts `requireCompleteDocumentContext`). */
export function documentComplete(source: KnowledgeSource): boolean {
  const segments = (source.metadata as any)?.segments;
  if (!source.content.trim() || !Array.isArray(segments) || !segments.length || segments.length > 200) return false;
  let end = 0;
  for (const s of segments) {
    if (!s || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < end || s.end <= s.start || s.end > source.content.length) return false;
    if (source.content.slice(end, s.start).trim()) return false;
    end = s.end;
  }
  return !source.content.slice(end).trim();
}

export type Admission = Readonly<{ records?: readonly SourceRecord[]; language?: Lang; refusal?: AdmissionRefusal;
  estimate?: Readonly<{ corpusBytes: number; answerNano: number; verifierNano: number }> }>;
export function admit(task: KnowledgeTask, listed: readonly KnowledgeSource[], limits: Readonly<{ remainingMs: number;
  maximumRequestNanoUsd: number; maximumTurnNanoUsd: number }>): Admission {
  const language = task.input.language.toLowerCase().split('-')[0] as Lang;
  if (!LANGUAGES.includes(language)) return { refusal: 'LANGUAGE_UNSUPPORTED' };
  if (listed.some(s => s.businessId !== task.scope.businessId)) return { refusal: 'TENANT_MISMATCH' };
  // A source still being extracted (or failed) may hold the answer: the corpus is not complete, so absence could not be proven.
  if (listed.some(s => IN_FLIGHT.has(s.status))) return { refusal: 'CORPUS_INCOMPLETE' };
  const ready = listed.filter(s => s.status === 'ready');
  if (!ready.length) return { refusal: 'NO_SOURCES' };
  if (ready.length > REFERENCE_ADMISSION.maxSources) return { refusal: 'TOO_MANY_SOURCES' };
  if (ready.some(s => s.type === 'document' && !documentComplete(s))) return { refusal: 'DOCUMENT_INCOMPLETE' };
  const corpusBytes = ready.reduce((n, s) => n + bytes(s.content) + bytes(s.title), 0);
  if (corpusBytes > REFERENCE_ADMISSION.maxCorpusBytes) return { refusal: 'CORPUS_TOO_LARGE' };
  const answerBytes = corpusBytes + REFERENCE_ADMISSION.requestOverheadBytes + bytes(task.input.question) +
    task.input.history.reduce((n, h) => n + bytes(h.content), 0);
  const answerNano = worstNano(answerBytes), verifierNano = worstNano(answerBytes + REFERENCE_ADMISSION.verifierExtraBytes);
  const estimate = { corpusBytes, answerNano, verifierNano };
  if (answerNano > limits.maximumRequestNanoUsd || verifierNano > limits.maximumRequestNanoUsd || answerNano + verifierNano > limits.maximumTurnNanoUsd)
    return { refusal: 'COST_ABOVE_OWNER_LIMIT', estimate };
  if (limits.remainingMs < REFERENCE_ADMISSION.answerFloorMs + REFERENCE_ADMISSION.verifierFloorMs + 2 * REFERENCE_ADMISSION.marginMs)
    return { refusal: 'INSUFFICIENT_TIME', estimate };
  const records = ready.map(s => Object.freeze({ id: s.id, businessId: s.businessId, title: s.title, type: s.type, status: s.status,
    content: s.content, updatedAt: s.updatedAt, revision: knowledgeSourceRevision(s) }));
  return { records, language, estimate };
}

// ---------------------------------------------------------------- money-bound provider (existing durable authority)
/** projectId: the provider project of the SAME money authority that holds the reservation for this dispatch. */
export type ReferenceTransport = (body: unknown, signal: AbortSignal, projectId: string) => Promise<Readonly<{ status: number; json: any }>>;
type MoneyOwner = Pick<KnowledgeBudgetOwner, 'id' | 'approvalReference' | 'providerProjectId' | 'businessIds' | 'maximumRequestNanoUsd' | 'maximumTurnNanoUsd' |
  'reserve' | 'settle' | 'retainUnknown'>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Money identities, in the deployed contract's form (odin_ai_money_v1 requires ^[a-f0-9]{64}$ for requestKey, reservationKey and
 * requestSha256). requestKey is per TASK and namespaced; reservationKey uses production's own formula
 * digest(JSON.stringify([businessId, requestKey, stage])) (knowledge-model-policy.ts). Deterministic across recovery, so the
 * database's unique(request_key, stage) refuses a second reservation of the same stage. */
export function referenceMoneyKeys(task: Pick<KnowledgeTask, 'id' | 'scope' | 'eventId'>, stage: 'extraction' | 'verification') {
  // While routing is accounted, the message's canonical inbound identity (shared bucket with routing; Reference and legacy then cannot
  // both reserve a stage for the message). Otherwise the per-task namespace (unchanged).
  const requestKey = canonicalMessageSpendActive(task.scope.businessId)
    ? inboundMessageSpendKey({ businessId: task.scope.businessId, channel: task.scope.channel, account: task.scope.providerAccount, eventId: task.eventId })
    : sha(JSON.stringify(['odinlink-reference-knowledge-v1', task.scope.businessId, task.id]));
  return { requestKey, reservationKey: sha(JSON.stringify([task.scope.businessId, requestKey, stage])) };
}
/** One reservation per dispatch; settle from the receipt; retain on any unknown outcome. Zero retries. */
/** Exact Sol receipt cost in nano-USD, the same formula the database recomputes at settlement (deployed Sol rows: input 2000, cached
 * read 100, cache write 2500, output 10000 nano-USD per token). */
export function referenceReceiptNanoUsd(u: Readonly<{ inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number }>): number {
  return (u.inputTokens - u.cachedTokens - u.cacheWriteTokens) * KNOWLEDGE_SOL_RATES.input * 1000 + u.cachedTokens * KNOWLEDGE_SOL_RATES.cacheRead * 1000 +
    u.cacheWriteTokens * KNOWLEDGE_SOL_RATES.cacheWrite * 1000 + u.outputTokens * KNOWLEDGE_SOL_RATES.output * 1000;
}
/** Time a stage may use given the time left before the worker's compute deadline: up to the stage cap, keeping the verifier floor (plus
 * margin) free while answering; null when less than the stage floor is available (do not dispatch). */
export function referenceStageBudgetMs(role: 'answer' | 'verifier', remainingMs: number): number | null {
  const left = remainingMs - REFERENCE_ADMISSION.marginMs;
  const floor = role === 'answer' ? REFERENCE_ADMISSION.answerFloorMs : REFERENCE_ADMISSION.verifierFloorMs;
  const reserveAfter = role === 'answer' ? REFERENCE_ADMISSION.verifierFloorMs + REFERENCE_ADMISSION.marginMs : 0;
  const ms = Math.min(role === 'answer' ? REFERENCE_ADMISSION.answerMs : REFERENCE_ADMISSION.verifierMs, left - reserveAfter);
  return ms >= floor ? Math.floor(ms) : null;
}
export function moneyBoundProvider(input: Readonly<{ task: KnowledgeTask; owner: MoneyOwner; transport: ReferenceTransport;
  reserveModelAttempt: () => Promise<void>;
  /** Worker cancellation (lease loss, stop, compute deadline) and the real compute deadline. */
  signal?: AbortSignal; deadlineAt?: number; current?: () => Promise<boolean>; now?: () => number }>): ReferenceProvider {
  const { task, owner } = input;
  const now = input.now ?? Date.now;
  return async (request: ProviderRequest): Promise<ProviderResult> => {
    // Stage budget from the real deadline: never dispatch with less than the stage floor left; never let the answer eat the
    // verifier's floor. Refused here = before any attempt, hold or dispatch.
    const stageMs = referenceStageBudgetMs(request.role, (input.deadlineAt ?? Infinity) - now());
    if (stageMs === null) throw new Error('reference_insufficient_time');
    const signal = AbortSignal.any([request.signal, ...(input.signal ? [input.signal] : []), AbortSignal.timeout(stageMs)]);
    const body = responsesBody(request);
    const text = JSON.stringify(body);
    const requestSha256 = sha(text);
    const stage = request.role === 'answer' ? 'extraction' as const : 'verification' as const;
    const keys = referenceMoneyKeys(task, stage);
    const quote: KnowledgeCostQuote = { businessId: task.scope.businessId, turnId: task.turnId, requestKey: keys.requestKey,
      stage, model: 'gpt-6.1-sol', requestSha256, reservationKey: keys.reservationKey,
      inputTokenProxy: bytes(text) + REFERENCE_ADMISSION.proxyFramingBytes,
      outputTokenLimit: 8192, maximumNanoUsd: worstNano(bytes(text)), ratesVersion: KNOWLEDGE_SOL_RATES.version,
      ...(owner.providerProjectId ? { providerProjectId: owner.providerProjectId } : {}), ownerId: owner.id, approvalReference: owner.approvalReference,
      maximumRequestNanoUsd: owner.maximumRequestNanoUsd, maximumTurnNanoUsd: owner.maximumTurnNanoUsd };
    if (request.maxOutputTokens > REFERENCE_ADMISSION.quoteOutputTokens) throw new Error('reference_output_above_reservation');
    // The provider project is bound to the reserving authority; without one nothing is attempted, reserved or dispatched.
    const projectId = owner.providerProjectId;
    if (!projectId || !/^proj_[A-Za-z0-9_-]+$/u.test(projectId)) throw new Error('reference_provider_project_missing');
    // Same pre-checks as production quotes (knowledge-model-policy.ts): long-context bound and owner request limit, before any hold.
    if (quote.inputTokenProxy > 272_000 || quote.maximumNanoUsd > owner.maximumRequestNanoUsd || quote.maximumNanoUsd > owner.maximumTurnNanoUsd)
      throw new Error('reference_request_budget');
    signal.throwIfAborted();
    if (input.current && !await input.current()) throw new Error('reference_not_current');
    await input.reserveModelAttempt();                 // durable attempt count (runner) BEFORE the money hold and the dispatch
    const hold = await owner.reserve(quote, signal);
    if (!hold) throw new Error('reference_money_denied');  // no hold → no dispatch
    // Recheck cancellation and lease ownership AFTER the hold and immediately before dispatch. The authority has no release: a hold
    // that will not be dispatched is retained as unknown (conservative; never silently released).
    if (signal.aborted || (input.current && !await input.current().catch(() => false))) {
      await owner.retainUnknown(quote, hold.id).catch(() => undefined);
      throw new Error('reference_cancelled_before_dispatch');
    }
    let response: Readonly<{ status: number; json: any }>;
    try { response = await input.transport(body, signal, projectId); }
    catch (error) { await owner.retainUnknown(quote, hold.id).catch(() => undefined); throw error; } // dispatched, outcome unknown: keep the hold
    const u = response.json?.usage;
    const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : NaN);
    const core = { inputTokens: n(u?.input_tokens), outputTokens: n(u?.output_tokens ?? 0), reasoningTokens: n(u?.output_tokens_details?.reasoning_tokens ?? 0),
      cachedTokens: n(u?.input_tokens_details?.cached_tokens ?? 0), cacheWriteTokens: n(u?.input_tokens_details?.cache_write_tokens ?? 0) };
    const valid = response.status === 200 && typeof response.json?.id === 'string' && /^resp_[A-Za-z0-9_-]+$/u.test(response.json.id) &&
      Object.values(core).every(Number.isFinite) && core.inputTokens <= quote.inputTokenProxy && core.outputTokens <= quote.outputTokenLimit &&
      core.cachedTokens + core.cacheWriteTokens <= core.inputTokens && core.reasoningTokens <= core.outputTokens;
    if (!valid) { await owner.retainUnknown(quote, hold.id).catch(() => undefined); throw new Error('reference_provider_failed'); }
    const usage: KnowledgeUsage = { model: 'gpt-6.1-sol', ownerId: owner.id, ratesVersion: KNOWLEDGE_SOL_RATES.version, requestSha256, ...core,
      estimatedNanoUsd: referenceReceiptNanoUsd(core), providerResponseId: response.json.id, ...(owner.providerProjectId ? { providerProjectId: owner.providerProjectId } : {}) };
    if (usage.estimatedNanoUsd > quote.maximumNanoUsd) { await owner.retainUnknown(quote, hold.id).catch(() => undefined); throw new Error('reference_receipt_above_hold'); }
    // A failed or uncertain settlement keeps the exposure (unknown), never a silently held or released reservation.
    try { await owner.settle(hold.id, quote, usage); }
    catch (error) { await owner.retainUnknown(quote, hold.id).catch(() => undefined); throw error; }
    // Never publish a result the worker no longer owns (lease lost, superseded or past the deadline while the provider answered).
    if (input.signal?.aborted || (input.current && !await input.current().catch(() => false))) throw new Error('reference_not_current');
    const out = (response.json.output ?? []).flatMap((o: any) => o.content ?? []).find((c: any) => c.type === 'output_text')?.text ?? '';
    return { text: out, status: response.json.status === 'completed' ? 'completed' : 'incomplete', model: String(response.json.model ?? ''),
      usage: { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedTokens, cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens }, requestSha256 };
  };
}

// ---------------------------------------------------------------- publication mapping (Blocker C)
/** Engine result → the existing VerifiedKnowledge contract (validated by captureVerified). Absence-bearing results carry the whole
 * pinned snapshot; complete results carry exactly the cited sources. Fallback → null (fixed safe-unavailable reply). */
export function toVerifiedKnowledge(result: ReferenceResult, pinned: readonly Readonly<{ id: string; revision: string }>[]): VerifiedKnowledge | null {
  if (result.publication === 'fallback' || !result.text.trim()) return null;
  const complete = result.publication === 'complete_draft' || result.publication === 'complete_units';
  if (!pinned.length || pinned.length > REFERENCE_ADMISSION.maxSources) return null;
  const pinnedIds = new Set(pinned.map(p => `${p.id}\u0000${p.revision}`));
  if (complete && !result.citedSources.every(s => pinnedIds.has(`${s.id}\u0000${s.revision}`))) return null;
  const sources = complete ? [...result.citedSources, { id: CORPUS_PIN_ID, revision: snapshotRevision(pinned) }]
    : [...pinned, { id: SNAPSHOT_PIN_ID, revision: snapshotRevision(pinned) }];
  if (!sources.length) return null;
  return captureVerified({ ...(complete
    ? { protocol: 'evidence-first-v2' as const, completeRequiredFacts: true as const }
    : { protocol: 'evidence-first-partial-v1' as const, completeRequiredFacts: false as const }),
    independentlyVerified: true, text: result.text, sources: sources.map(s => ({ id: s.id, revision: s.revision })) });
}

// ---------------------------------------------------------------- executor
export type ReferenceExecutorDeps = Readonly<{
  listSources: (businessId: number, signal: AbortSignal) => Promise<readonly KnowledgeSource[]>;
  /** The narrow money accessor (production: knowledgeReferenceMoneyAuthority). */
  owner: (businessId: number) => MoneyOwner | undefined;
  transport: ReferenceTransport;
  /** Remaining execution time for this task (upper bound; the runner's real compute deadline from the executor context also applies). */
  remainingMs: (task: KnowledgeTask) => number;
  now?: () => number;
  /** True when the question (or its carried interpretation) belongs to a domain whose authority is the tenant's configured policy
   * (cancellation, configured catalog/prices, opening hours). Such tasks are never admitted: the existing engine answers them with the
   * configured policy as authoritative evidence, so an uploaded document cannot override it. */
  configuredPolicyAuthority?: (task: KnowledgeTask) => boolean;
  diagnostic?: (event: Readonly<Record<string, unknown>>) => void;
}>;

/** Pre-execution admission happens BEFORE any provider call; a refusal returns `{ admitted: false }` so the host can keep using its
 * existing engine. After admission, any failure yields null (safe unavailable), never the old engine. */
export async function executeReferenceKnowledgeTask(task: KnowledgeTask, context: Parameters<KnowledgeExecutor>[1],
  current: () => Promise<boolean>, deps: ReferenceExecutorDeps): Promise<{ admitted: false; refusal: AdmissionRefusal } | { admitted: true; result: VerifiedKnowledge | null }> {
  const emit = (e: Record<string, unknown>) => { try { deps.diagnostic?.({ turnId: task.turnId, ...e }); } catch { /* diagnostics never affect results */ } };
  // Recovery after interruption: once any model attempt was reserved for this task (or the runner marked it final-only), the reference
  // engine never calls a provider again; the task ends with the fixed safe-unavailable reply (no repeated spend, no old engine).
  if (task.finalOnly || task.modelAttempts > 0) { emit({ stage: 'recovery', outcome: 'final_only' }); return { admitted: true, result: null }; }
  if (deps.configuredPolicyAuthority?.(task)) { emit({ stage: 'admission', refusal: 'CONFIGURED_POLICY_AUTHORITY' }); return { admitted: false, refusal: 'CONFIGURED_POLICY_AUTHORITY' }; }
  const owner = deps.owner(task.scope.businessId);
  if (!owner || !owner.businessIds.includes(task.scope.businessId)) { emit({ stage: 'admission', refusal: 'NO_MONEY_OWNER' }); return { admitted: false, refusal: 'NO_MONEY_OWNER' }; }
  const listed = await deps.listSources(task.scope.businessId, context.signal);
  // The worker's REAL compute deadline (the runner's executionSignal aborts there), not task expiry.
  const now = deps.now ?? Date.now;
  const deadlineAt = (context as { deadlineAt?: number }).deadlineAt ?? knowledgeExecutionDeadline(task);
  const remainingMs = Math.min(deps.remainingMs(task), deadlineAt - now());
  const a = admit(task, listed, { remainingMs, maximumRequestNanoUsd: owner.maximumRequestNanoUsd, maximumTurnNanoUsd: owner.maximumTurnNanoUsd });
  if (!a.records) { emit({ stage: 'admission', refusal: a.refusal, estimate: a.estimate }); return { admitted: false, refusal: a.refusal! }; }
  if (context.signal.aborted || !await current()) return { admitted: true, result: null };
  const pinned = a.records.map(r => ({ id: r.id, revision: r.revision! }));
  const revalidate = async (businessId: number, ids: readonly string[]) => {
    const live = await deps.listSources(businessId, context.signal);
    return new Map(live.filter(s => s.businessId === businessId && s.status === 'ready' && ids.includes(s.id)).map(s => [s.id, knowledgeSourceRevision(s)]));
  };
  const result = await runReferenceAnswer({ businessId: task.scope.businessId, question: task.input.question, language: a.language!,
    history: task.input.history.map(h => ({ role: h.role, content: h.content })), sources: a.records,
    ...(task.input.interpretation ? { interpretation: task.input.interpretation } : {}) },
  { provider: moneyBoundProvider({ task, owner, transport: deps.transport, reserveModelAttempt: context.reserveModelAttempt,
      signal: context.signal, deadlineAt, current, now }), revalidate,
    timeouts: { answerMs: REFERENCE_ADMISSION.answerMs, verifierMs: REFERENCE_ADMISSION.verifierMs } });
  emit({ stage: 'result', publication: result.publication, reasons: result.reasons.map(r => r.code), totalMs: result.metrics.totalMs });
  if (context.signal.aborted || !await current()) return { admitted: true, result: null };   // lease/turn lost: never publish
  const complete = result.publication === 'complete_draft' || result.publication === 'complete_units';
  if (!complete && result.publication !== 'fallback') {
    // A verified absence is relative to the WHOLE snapshot: the tenant's ready set must be exactly what was pinned.
    const live = await deps.listSources(task.scope.businessId, context.signal);
    const ready = live.filter(s => s.businessId === task.scope.businessId && s.status === 'ready');
    const same = !live.some(s => IN_FLIGHT.has(s.status)) && ready.length === pinned.length &&
      pinned.every(p => ready.some(s => s.id === p.id && knowledgeSourceRevision(s) === p.revision));
    if (!same) { emit({ stage: 'publication', refusal: 'SNAPSHOT_CHANGED' }); return { admitted: true, result: null }; }
  }
  return { admitted: true, result: toVerifiedKnowledge(result, pinned) };
}

// ---------------------------------------------------------------- production transport (existing credential architecture)
/** Minimal structural view of the OpenAI SDK client used by production (src/ai/providers/openai.ts). */
export type ResponsesClient = { responses: { create(body: any, options: any): { withResponse(): Promise<{ data: any; response: { status: number; headers: { get(name: string): string | null } } }> } } };
/** Same credential path as production: OPENAI_API_KEY from the environment, the official endpoint, maxRetries 0, the owner's project
 * header, and the provider's project echo verified before the result is used. The key is never read here unless a request is made,
 * and never logged. NOT installed in server.ts in this phase. */
export function createReferenceTransport(input: Readonly<{ projectId: string; timeoutMs: number; client: () => ResponsesClient }>): ReferenceTransport {
  return async (body, signal, projectId) => {
    // Bound to the reserving owner's project: a different authority is refused before any client or dispatch.
    if (projectId !== input.projectId) throw new Error('reference_project_binding');
    const { data, response } = await input.client().responses.create(body, { signal, timeout: input.timeoutMs, maxRetries: 0,
      headers: { 'OpenAI-Project': input.projectId } }).withResponse();
    if (response.headers.get('openai-project') !== input.projectId) throw new Error('reference_project_mismatch'); // retained, unknown
    return { status: response.status, json: data };
  };
}
