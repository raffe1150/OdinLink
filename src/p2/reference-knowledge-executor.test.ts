/** Reference adapter — offline integration tests (SYNTHETIC scripted model outputs; no provider, no database, no money). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { knowledgeSourceRevision, type KnowledgeSource } from '../../knowledge';
import { captureVerified, type KnowledgeTask } from './knowledge-lifecycle';
import { admit, documentComplete, executeReferenceKnowledgeTask, moneyBoundProvider, referenceEngineConfig, referenceEngineSelected, referenceReceiptNanoUsd,
  referenceStageBudgetMs, toVerifiedKnowledge, REFERENCE_ADMISSION, type ReferenceTransport } from './reference-knowledge-executor';
import { knowledgeExecutionDeadline } from './knowledge-operation';
import { pinCorpus } from '../experimental/knowledge-reference/corpus';
import { loadFixtureSources } from '../experimental/knowledge-reference/eval/dataset';
import { approvingVerifier, scriptedProvider, type Script } from '../experimental/knowledge-reference/eval/scripted';
import type { AnswerOutput, ProviderRequest } from '../experimental/knowledge-reference/types';

const fixture = loadFixtureSources();
const asSource = (r: (typeof fixture)[number], over: Partial<KnowledgeSource> = {}): KnowledgeSource => ({ id: r.id, businessId: r.businessId,
  type: r.type as any, title: r.title, status: r.status as any, content: r.content, createdAt: r.updatedAt, updatedAt: r.updatedAt,
  metadata: (r.type === 'document' ? { segments: [{ start: 0, end: r.content.length }] } : {}) as any, ...over });
const SOURCES = fixture.map(r => asSource(r));
const task = (over: Partial<KnowledgeTask['input']> = {}, scope: Partial<KnowledgeTask['scope']> = {}): KnowledgeTask => ({
  id: 'task-1', turnId: 'turn-1', eventId: 'e1', sequence: 1, acceptedAt: 0, expiresAt: 75_000, state: 'RUNNING', revision: 1, fence: 7, lease: null,
  runAttempts: 1, maxRunAttempts: 2, modelAttempts: 0, maxModelAttempts: 4, checkpoint: null, result: null, resultDigest: null,
  scope: { businessId: 3, channel: 'telegram', providerAccount: 'bot', conversationId: '0f8fad5b-d9cb-469f-a165-70867728950e', ...scope },
  input: { question: 'När ska jag komma till mitt första besök?', language: 'sv', history: [], ...over } } as KnowledgeTask);
// Owner limits are database policy (unknown locally); the worst-case quote uses 8,192 output tokens and 1 token per byte.
const LIMITS = { remainingMs: 60_000, maximumRequestNanoUsd: 250_000_000, maximumTurnNanoUsd: 600_000_000 };

// ---------------- feature flag ----------------
test('flag: missing or malformed configuration is OFF; owner mode needs an explicit conversation allowlist', () => {
  const t = task();
  for (const env of [{}, { ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'on', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3' },
    { ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'active' }, { ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'active', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3,x' },
    { ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'owner', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3' },
    { ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'owner', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3', ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS: 'sms:1' }])
    assert.equal(referenceEngineSelected(t, referenceEngineConfig(env)), false, JSON.stringify(env));
  const owner = referenceEngineConfig({ ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'owner', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3',
    ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS: '3:telegram:0f8fad5b-d9cb-469f-a165-70867728950e' });
  assert.equal(referenceEngineSelected(t, owner), true);
  assert.equal(referenceEngineSelected(task({}, { conversationId: '9b2f6c1e-4d3a-4e8b-9c7d-1a2b3c4d5e6f' }), owner), false, 'tenant match alone is not owner authorization');
  assert.equal(referenceEngineSelected(task({}, { channel: 'whatsapp' }), owner), false);
  const active = referenceEngineConfig({ ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'active', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3' });
  assert.equal(referenceEngineSelected(task({}, { conversationId: 'anyone' }), active), true);
  assert.equal(referenceEngineSelected(task({}, { businessId: 4 }), active), false);
});

// ---------------- admission (Blockers B and D) ----------------
test('admission pins every ready source with the host revision (knowledgeSourceRevision), and refuses incomplete or oversized corpora explicitly', () => {
  const ok = admit(task(), SOURCES, LIMITS);
  assert.ok(ok.records && !ok.refusal);
  assert.deepEqual(ok.records!.map(r => r.revision), SOURCES.map(s => knowledgeSourceRevision(s)));
  const doc = { ...SOURCES[0], type: 'document' as const, content: 'A. B. C.' };
  assert.equal(documentComplete({ ...doc, metadata: { segments: [{ start: 0, end: 8 }] } as any }), true);
  assert.equal(documentComplete({ ...doc, metadata: { segments: [{ start: 0, end: 3 }] } as any }), false, 'uncovered text');
  assert.equal(documentComplete({ ...doc, metadata: {} as any }), false, 'no segments');
  assert.equal(documentComplete({ ...doc, metadata: { segments: [{ start: 3, end: 2 }] } as any }), false, 'malformed');
  const cases: [string, KnowledgeSource[], any, string][] = [
    ['source still processing', [...SOURCES, { ...SOURCES[0], id: 'p', status: 'processing' as any }], LIMITS, 'CORPUS_INCOMPLETE'],
    ['failed extraction', [...SOURCES, { ...SOURCES[0], id: 'f', status: 'failed' as any }], LIMITS, 'CORPUS_INCOMPLETE'],
    ['incomplete document', [...SOURCES, { ...doc, id: 'd', metadata: { segments: [{ start: 0, end: 3 }] } as any }], LIMITS, 'DOCUMENT_INCOMPLETE'],
    ['other tenant row', [...SOURCES, { ...SOURCES[0], id: 'x', businessId: 4 }], LIMITS, 'TENANT_MISMATCH'],
    ['too many sources', Array.from({ length: 11 }, (_, i) => ({ ...SOURCES[0], id: `s${i}` })), LIMITS, 'TOO_MANY_SOURCES'],
    ['oversized corpus', [{ ...SOURCES[0], content: 'Lång text. '.repeat(6000), metadata: { segments: [{ start: 0, end: 'Lång text. '.repeat(6000).length }] } as any }], LIMITS, 'CORPUS_TOO_LARGE'],
    ['owner request limit', SOURCES, { ...LIMITS, maximumRequestNanoUsd: 50_000_000 }, 'COST_ABOVE_OWNER_LIMIT'],
    ['deadline', SOURCES, { ...LIMITS, remainingMs: 26_000 }, 'INSUFFICIENT_TIME'],
    ['nothing ready', [{ ...SOURCES[0], status: 'disabled' as any }], LIMITS, 'NO_SOURCES'],
  ];
  for (const [name, listed, limits, refusal] of cases) assert.equal(admit(task(), listed, limits).refusal, refusal, name);
  assert.equal(admit(task({ language: 'fr' }), SOURCES, LIMITS).refusal, 'LANGUAGE_UNSUPPORTED');
  assert.equal(REFERENCE_ADMISSION.maxSources, 9, '9 real pins + the snapshot pin = the captureVerified cap of 10');
});

// ---------------- execution through the money-bound provider ----------------
const ARRIVE = pinCorpus(3, fixture).corpus!.evidence.passages.find(p => p.text.includes('cirka 10 minuter'))!.ref;
const COMPLETE: AnswerOutput = { language: 'sv', draft: '', obligations: [{ id: 'a1', description: 'ankomst', status: 'answered' }],
  units: [{ id: 'u1', text: 'Vid ditt första besök rekommenderas du att komma cirka 10 minuter före din bokade tid.', modality: 'recommended',
    conditions: [], citations: [], evidence: [ARRIVE], addresses: ['a1'] }] };
const ABSENT: AnswerOutput = { language: 'sv', draft: '', obligations: [{ id: 'a1', description: 'öppettider', status: 'not_in_sources' }],
  units: [{ id: 'h1', kind: 'limitation', text: 'Öppettiderna har jag tyvärr ingen information om.', modality: 'descriptive', conditions: [],
    citations: [], evidence: [], addresses: ['a1'] }] };
const ob = (available: boolean) => (s: readonly { id: string }[]) => [{ id: 'v1', description: 'x', kind: 'information' as const,
  availableInSources: available, sourcesConflict: false, status: (available ? 'complete' : 'not_addressed') as any, coveredByUnits: s.map(u => u.id), missingInformation: [] }];

function harness(script: Script, opts: { deny?: boolean; transportThrows?: boolean; mutate?: (n: number) => KnowledgeSource[] | undefined; now?: () => number } = {}) {
  const log: string[] = [];
  const scripted = scriptedProvider(script);
  let lists = 0;
  const transport: ReferenceTransport = async (body: any, signal) => {
    log.push('dispatch');
    if (opts.transportThrows) throw new Error('network');
    const request: ProviderRequest = { role: String(body.text.format.name).includes('answer') ? 'answer' : 'verifier', instructions: body.instructions,
      input: body.input, schemaName: body.text.format.name, schema: body.text.format.schema, maxOutputTokens: body.max_output_tokens, signal };
    const r = await scripted(request);
    return { status: 200, json: { id: `resp_${log.length}`, status: 'completed', model: 'gpt-6.1-sol', output: [{ content: [{ type: 'output_text', text: r.text }] }],
      usage: { input_tokens: 3000, output_tokens: 200, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 3000 }, output_tokens_details: { reasoning_tokens: 0 } } } };
  };
  const owner = { id: 'own', approvalReference: 'appr', providerProjectId: 'proj_owner', businessIds: [3], maximumRequestNanoUsd: 250_000_000, maximumTurnNanoUsd: 600_000_000,
    reserve: async (q: any) => { log.push(`reserve:${q.stage}`); return opts.deny ? null : { id: `h-${q.stage}`, reservationKey: q.reservationKey, maximumNanoUsd: q.maximumNanoUsd }; },
    settle: async (id: string) => { log.push(`settle:${id}`); }, retainUnknown: async (_q: any, id: string | null) => { log.push(`retain:${id}`); } };
  // Fake epoch: task acceptedAt 0 / expiresAt 75 s, so the worker's compute deadline is 60 s; the executor reads this clock.
  const deps = { owner: (_b: number) => owner as any, transport, remainingMs: () => 60_000, now: opts.now ?? (() => 0),
    listSources: async () => { lists++; return opts.mutate?.(lists) ?? SOURCES; } };
  const ctx = (abort?: AbortController) => ({ signal: (abort ?? new AbortController()).signal, expiresAt: 75_000,
    reserveModelAttempt: async () => { log.push('attempt'); }, checkpoint: async () => undefined });
  return { log, deps, ctx };
}
const approve = (available: boolean) => approvingVerifier(ob(available));

test('complete answer: attempt → money hold → dispatch → settle for each of the two calls; result is evidence-first-v2 with the cited source', async () => {
  const h = harness({ answer: COMPLETE, verifier: approve(true) });
  const r = await executeReferenceKnowledgeTask(task(), h.ctx() as any, async () => true, h.deps);
  assert.ok(r.admitted && r.result);
  assert.equal(r.result!.protocol, 'evidence-first-v2');
  const cited = SOURCES.find(s => s.content.includes('cirka 10 minuter'))!;
  // Phase 5: the cited source stays exact, plus the corpus pin over the whole authorized corpus the answer was derived from.
  const corpus = SOURCES.map(s => ({ id: s.id, revision: knowledgeSourceRevision(s) }));
  assert.deepEqual(r.result!.sources, [{ id: cited.id, revision: knowledgeSourceRevision(cited) }, { id: CORPUS_PIN_ID, revision: snapshotRevision(corpus) }]);
  assert.deepEqual(h.log, ['attempt', 'reserve:extraction', 'dispatch', 'settle:h-extraction', 'attempt', 'reserve:verification', 'dispatch', 'settle:h-verification']);
});

test('verified absence (limitation-only, the en-07 class) is published as partial-v1 bound to the WHOLE pinned snapshot, natural text kept', async () => {
  const h = harness({ answer: ABSENT, verifier: approve(false) });
  const r = await executeReferenceKnowledgeTask(task({ question: 'Vilka är era öppettider?' }), h.ctx() as any, async () => true, h.deps);
  assert.ok(r.admitted && r.result);
  assert.equal(r.result!.protocol, 'evidence-first-partial-v1');
  assert.equal(r.result!.text, ABSENT.units[0].text);
  const pins = SOURCES.map(s => ({ id: s.id, revision: knowledgeSourceRevision(s) }));
  assert.deepEqual(r.result!.sources, [...pins, { id: SNAPSHOT_PIN_ID, revision: snapshotRevision(pins) }]);
});

test('absence is never proven from a changed snapshot: a modified, removed, added or in-flight source after the run → null', async () => {
  const variants: [string, (l: KnowledgeSource[]) => KnowledgeSource[]][] = [
    ['modified', l => l.map((s, i) => i === 0 ? { ...s, content: s.content + ' Ny mening.' } : s)],
    ['removed', l => l.slice(1)],
    ['added', l => [...l, { ...l[0], id: 'new-source' }]],
    ['now processing', l => [...l, { ...l[0], id: 'p', status: 'processing' as any }]],
  ];
  for (const [name, change] of variants) {
    // listSources call 1 = admission, 2 = engine revalidation (none for limitation-only), then the snapshot check.
    const h = harness({ answer: ABSENT, verifier: approve(false) }, { mutate: n => n >= 2 ? change(SOURCES) : undefined });
    const r = await executeReferenceKnowledgeTask(task({ question: 'Vilka är era öppettider?' }), h.ctx() as any, async () => true, h.deps);
    assert.ok(r.admitted && r.result === null, name);
  }
});

test('a cited source modified during execution is rejected before publication (STALE_SOURCE) → null; no newer text is substituted', async () => {
  const h = harness({ answer: COMPLETE, verifier: approve(true) },
    { mutate: n => n >= 2 ? SOURCES.map(s => s.content.includes('cirka 10 minuter') ? { ...s, content: s.content.replace('10', '15') } : s) : undefined });
  const r = await executeReferenceKnowledgeTask(task(), h.ctx() as any, async () => true, h.deps);
  assert.ok(r.admitted && r.result === null);
});

test('money denial stops before any dispatch; a transport failure retains the hold; both → null, zero retries', async () => {
  const denied = harness({ answer: COMPLETE, verifier: approve(true) }, { deny: true });
  const a = await executeReferenceKnowledgeTask(task(), denied.ctx() as any, async () => true, denied.deps);
  assert.ok(a.admitted && a.result === null);
  assert.deepEqual(denied.log, ['attempt', 'reserve:extraction']);
  const failed = harness({ answer: COMPLETE, verifier: approve(true) }, { transportThrows: true });
  const b = await executeReferenceKnowledgeTask(task(), failed.ctx() as any, async () => true, failed.deps);
  assert.ok(b.admitted && b.result === null);
  assert.deepEqual(failed.log, ['attempt', 'reserve:extraction', 'dispatch', 'retain:h-extraction']);
});

test('lease/turn loss or cancellation: nothing is published', async () => {
  const lost = harness({ answer: COMPLETE, verifier: approve(true) });
  let calls = 0;
  const r = await executeReferenceKnowledgeTask(task(), lost.ctx() as any, async () => ++calls < 2, lost.deps);
  assert.ok(r.admitted && r.result === null);
  const abort = new AbortController(); abort.abort();
  const c = harness({ answer: COMPLETE, verifier: approve(true) });
  const x = await executeReferenceKnowledgeTask(task(), c.ctx(abort) as any, async () => true, c.deps);
  assert.ok(x.admitted && x.result === null);
  assert.ok(!c.log.includes('dispatch'));
});

test('a negative verdict is never bypassed: the result is null (safe unavailable), never the old engine', async () => {
  const h = harness({ answer: COMPLETE, verifier: (s: any, d: string) => { const o = approve(true)(s, d); return { ...o, units: o.units.map(u => ({ ...u, verdict: 'NOT_ENTAILED' as const })) }; } });
  const r = await executeReferenceKnowledgeTask(task(), h.ctx() as any, async () => true, h.deps);
  assert.deepEqual(r, { admitted: true, result: null });
});

test('no money owner or an inadmissible corpus → not admitted (the host keeps its existing engine); no provider call', async () => {
  const h = harness({ answer: COMPLETE, verifier: approve(true) }, { mutate: () => [...SOURCES, { ...SOURCES[0], id: 'p', status: 'processing' as any }] });
  assert.deepEqual(await executeReferenceKnowledgeTask(task(), h.ctx() as any, async () => true, h.deps), { admitted: false, refusal: 'CORPUS_INCOMPLETE' });
  assert.deepEqual(await executeReferenceKnowledgeTask(task(), h.ctx() as any, async () => true, { ...h.deps, owner: () => undefined }),
    { admitted: false, refusal: 'NO_MONEY_OWNER' });
  assert.ok(!h.log.includes('dispatch'));
});

test('GENUINE Pilot 7 en-07 (not_in_sources) maps to a valid partial-v1 result bound to the pinned snapshot; the natural text is unchanged', {
  skip: !existsSync('Claude outputs/reference-pilot/ref-pilot-20261125-6/en-07.json') && 'Pilot 7 artifacts not present' }, () => {
  const a = JSON.parse(readFileSync('Claude outputs/reference-pilot/ref-pilot-20261125-6/en-07.json', 'utf8'));
  assert.equal(a.result.publication, 'not_in_sources');
  const pinned = SOURCES.map(s => ({ id: s.id, revision: knowledgeSourceRevision(s) }));
  const v = toVerifiedKnowledge({ ...a.result, citedSources: [] }, pinned)!;
  assert.equal(v.protocol, 'evidence-first-partial-v1');
  assert.equal(v.text, a.result.text);
  assert.deepEqual(captureVerified(v), v);
  assert.equal(toVerifiedKnowledge({ ...a.result, publication: 'fallback', citedSources: [] }, pinned), null);
});

// ---------------- Phase 2: money contract, calibration, transport ----------------
import { createReferenceTransport, referenceMoneyKeys, CORPUS_PIN_ID, SNAPSHOT_PIN_ID, snapshotRevision } from './reference-knowledge-executor';
import { createHash } from 'node:crypto';
import { REFERENCE_MAX_OUTPUT } from '../experimental/knowledge-reference/wire';

test('quotes follow the money authority contract exactly; the sent output limit (2,048) never exceeds the reservation (8,192)', async () => {
  const quotes: any[] = []; const bodies: any[] = [];
  const h = harness({ answer: COMPLETE, verifier: approve(true) });
  const owner = h.deps.owner(3);
  const spy = { ...h.deps, owner: () => ({ ...owner, reserve: async (q: any, s: AbortSignal) => { quotes.push(q); return owner.reserve(q, s); } }),
    transport: async (b: any, s: AbortSignal, p: string) => { bodies.push(b); return h.deps.transport(b, s, p); } };
  const r = await executeReferenceKnowledgeTask(task(), h.ctx() as any, async () => true, spy);
  assert.ok(r.admitted && r.result);
  assert.deepEqual(REFERENCE_MAX_OUTPUT, { answer: 2048, verifier: 2048 });
  quotes.forEach((q, i) => {
    const sent = Buffer.byteLength(JSON.stringify(bodies[i]), 'utf8');
    assert.equal(q.outputTokenLimit, 8192);
    assert.equal(q.inputTokenProxy, sent + 2048);
    assert.equal(q.maximumNanoUsd, q.inputTokenProxy * 2500 + 8192 * 10000, 'odin_ai_money_v1 maximum formula');
    assert.ok(bodies[i].max_output_tokens === 2048 && bodies[i].max_output_tokens <= q.outputTokenLimit);
    assert.ok(q.maximumNanoUsd <= 150_000_000, `request reservation ${q.maximumNanoUsd} within $0.15`);
    // Deployed odin_ai_money_v1 contract: ^[a-f0-9]{64}$ for all three identities.
    for (const k of ['requestKey', 'reservationKey', 'requestSha256']) assert.match(q[k], /^[a-f0-9]{64}$/u, k);
    assert.deepEqual({ requestKey: q.requestKey, reservationKey: q.reservationKey }, referenceMoneyKeys(task(), q.stage));
  });
  assert.equal(quotes[0].requestKey, quotes[1].requestKey, 'one request key per task');
  assert.notEqual(quotes[0].reservationKey, quotes[1].reservationKey, 'one reservation key per stage');
  assert.deepEqual(quotes.map(q => q.stage), ['extraction', 'verification']);
});

test('recovery after any reserved model attempt (or final-only) never calls a provider again and never uses the old engine', async () => {
  for (const t of [{ ...task(), modelAttempts: 1 }, { ...task(), finalOnly: true }] as KnowledgeTask[]) {
    const h = harness({ answer: COMPLETE, verifier: approve(true) });
    assert.deepEqual(await executeReferenceKnowledgeTask(t, h.ctx() as any, async () => true, h.deps), { admitted: true, result: null });
    assert.deepEqual(h.log, []);
  }
});

test('production transport: maxRetries 0, owner project header, provider project echo verified; a mismatch is an unknown outcome', async () => {
  const seen: any[] = [];
  const client = (project: string | null) => () => ({ responses: { create: (body: any, options: any) => ({ withResponse: async () => {
    seen.push(options); return { data: { id: 'resp', body }, response: { status: 200, headers: { get: (n: string) => n === 'openai-project' ? project : null } } }; } }) } });
  const ok = createReferenceTransport({ projectId: 'proj_abc', timeoutMs: 30_000, client: client('proj_abc') });
  assert.equal((await ok({ x: 1 }, new AbortController().signal, 'proj_abc')).status, 200);
  assert.equal(seen[0].maxRetries, 0); assert.equal(seen[0].headers['OpenAI-Project'], 'proj_abc'); assert.equal(seen[0].timeout, 30_000);
  const bad = createReferenceTransport({ projectId: 'proj_abc', timeoutMs: 30_000, client: client('proj_other') });
  await assert.rejects(bad({}, new AbortController().signal, 'proj_abc'), /reference_project_mismatch/u);
  const before = seen.length;
  await assert.rejects(ok({}, new AbortController().signal, 'proj_owner'), /reference_project_binding/u);
  assert.equal(seen.length, before, 'a different reserving project never reaches the client');
});

test('money identities: deterministic per task and stage (recovery-stable), production reservation formula, distinct across tasks', () => {
  const t = task();
  const a = referenceMoneyKeys(t, 'extraction'), b = referenceMoneyKeys({ ...t, fence: 99 } as KnowledgeTask, 'extraction');
  assert.deepEqual(a, b, 'a new fence after recovery reuses the same keys, so the database refuses a second reservation');
  const sha = (x: string) => createHash('sha256').update(x).digest('hex');
  assert.equal(a.reservationKey, sha(JSON.stringify([3, a.requestKey, 'extraction'])));
  assert.notEqual(referenceMoneyKeys({ ...t, id: 'task-2' } as KnowledgeTask, 'extraction').requestKey, a.requestKey);
  assert.notEqual(referenceMoneyKeys(t, 'verification').reservationKey, a.reservationKey);
  assert.equal(referenceMoneyKeys(t, 'verification').requestKey, a.requestKey);
});

test('a request whose reservation would exceed the owner request limit is refused before any attempt, hold or dispatch', async () => {
  const h = harness({ answer: COMPLETE, verifier: approve(true) });
  const owner = h.deps.owner(3);
  const r = await executeReferenceKnowledgeTask(task(), h.ctx() as any, async () => true,
    { ...h.deps, owner: () => ({ ...owner, maximumRequestNanoUsd: 100_000_000, maximumTurnNanoUsd: 600_000_000 }) });
  // 100M is below the admission estimate, so the task is refused before execution (existing engine keeps the turn).
  assert.deepEqual(r, { admitted: false, refusal: 'COST_ABOVE_OWNER_LIMIT' });
  assert.deepEqual(h.log, []);
});

test('durable resolved-question carriage: a stored interpretation reaches the answer request next to the original words; none → none', async () => {
  const bodies: string[] = [];
  for (const over of [{ interpretation: 'När ska jag komma till mitt första besök hos er studio?' }, {}]) {
    const h = harness({ answer: COMPLETE, verifier: approve(true) });
    const inner = h.deps.transport;
    h.deps.transport = async (body: any, signal, project) => { if (String(body.text.format.name).includes('answer')) bodies.push(String(body.input)); return inner(body, signal, project); };
    const r = await executeReferenceKnowledgeTask(task(over), h.ctx() as any, async () => true, h.deps);
    assert.ok(r.admitted && r.result);
  }
  assert.ok(bodies[0].includes('När ska jag komma till mitt första besök?'), 'original words travel');
  assert.ok(bodies[0].includes('hos er studio'), 'interpretation travels');
  assert.ok(!bodies[1].includes('hos er studio'));
});

// ---------------- timing from the REAL compute deadline, cancellation, settlement (release-blocker corrections) ----------------
const windowTask = (executionMs: number) => ({ ...task(), acceptedAt: 0, expiresAt: executionMs }) as KnowledgeTask;
test('timing: standard 20/30/35/40 s windows are refused before any call; the 75 s owner-pilot window admits and fits the genuine Sol latencies', async () => {
  for (const ms of [20_000, 30_000, 35_000, 40_000]) {
    const t = windowTask(ms), h = harness({ answer: COMPLETE, verifier: approve(true) });
    const r = await executeReferenceKnowledgeTask(t, { ...h.ctx(), deadlineAt: knowledgeExecutionDeadline(t) } as any, async () => true, h.deps);
    assert.deepEqual(r, { admitted: false, refusal: 'INSUFFICIENT_TIME' }, `${ms} ms window`);
    assert.deepEqual(h.log, [], 'no attempt, hold or dispatch');
  }
  const pilot = windowTask(75_000);
  assert.equal(knowledgeExecutionDeadline(pilot), 60_000, '75 s window → 60 s of compute (15 s finalization/delivery reserve kept)');
  // Genuine Stages A–D maxima: understanding 5.05 s (spent before intake work, counted here), answer 7.6 s, verifier 10.2 s.
  const afterUnderstanding = 60_000 - 5_050;
  const answerBudget = referenceStageBudgetMs('answer', afterUnderstanding)!;
  const verifierBudget = referenceStageBudgetMs('verifier', afterUnderstanding - 7_600)!;
  assert.ok(answerBudget >= 7_600 && verifierBudget >= 10_200, JSON.stringify({ answerBudget, verifierBudget }));
  assert.ok(answerBudget <= REFERENCE_ADMISSION.answerMs && verifierBudget <= REFERENCE_ADMISSION.verifierMs);
  const h = harness({ answer: COMPLETE, verifier: approve(true) });
  const r = await executeReferenceKnowledgeTask(pilot, { ...h.ctx(), deadlineAt: knowledgeExecutionDeadline(pilot) } as any, async () => true, h.deps);
  assert.ok(r.admitted && r.result, 'admitted and published');
});
test('timing: the answer never consumes the verifier floor; a verifier with less than its floor left is not dispatched (no hold leaked)', async () => {
  assert.equal(referenceStageBudgetMs('answer', 26_000), null, 'answer + verifier floors do not fit');
  assert.equal(referenceStageBudgetMs('answer', 40_000), 20_000);
  assert.equal(referenceStageBudgetMs('answer', 30_000), 30_000 - 1_500 - 12_000 - 1_500);
  assert.equal(referenceStageBudgetMs('verifier', 13_000), null);
  let clock = 0;
  const h = harness({ answer: COMPLETE, verifier: approve(true) }, { now: () => clock });
  const inner = h.deps.transport;
  h.deps.transport = async (body: any, signal, project) => { const res = await inner(body, signal, project); if (String(body.text.format.name).includes('answer')) clock = 50_000; return res; };
  const r = await executeReferenceKnowledgeTask(task(), { ...h.ctx(), deadlineAt: 60_000 } as any, async () => true, h.deps);
  assert.ok(r.admitted); assert.equal(r.result, null, 'verifier refused for time → safe unavailable, never an unverified answer');
  assert.deepEqual(h.log, ['attempt', 'reserve:extraction', 'dispatch', 'settle:h-extraction'], 'no verifier attempt, hold or dispatch');
});
test('cancellation: worker abort or lost ownership after the hold → retained, never dispatched; abort during dispatch reaches the transport and is retained', async () => {
  // ownership lost between hold and dispatch
  { let checks = 0; const h = harness({ answer: COMPLETE, verifier: approve(true) });
    const r = await executeReferenceKnowledgeTask(task(), { ...h.ctx(), deadlineAt: 60_000 } as any, async () => ++checks <= 2, h.deps);
    assert.ok(r.admitted); assert.equal(r.result, null);
    assert.deepEqual(h.log, ['attempt', 'reserve:extraction', 'retain:h-extraction'], 'held exposure retained; no dispatch'); }
  // worker stops while the request is in flight: the transport sees the abort; exposure retained; nothing published
  { const abort = new AbortController(); const h = harness({ answer: COMPLETE, verifier: approve(true) }); let sawAbort = false;
    h.deps.transport = (async (_body: any, signal: AbortSignal) => { h.log.push('dispatch'); abort.abort();
      await new Promise(resolve => setTimeout(resolve, 5)); sawAbort = signal.aborted; throw new Error('aborted'); }) as any;
    const r = await executeReferenceKnowledgeTask(task(), { ...h.ctx(abort), deadlineAt: 60_000 } as any, async () => !abort.signal.aborted, h.deps);
    assert.equal(sawAbort, true, 'worker cancellation propagated to the provider transport');
    assert.ok(r.admitted); assert.equal(r.result, null);
    assert.deepEqual(h.log, ['attempt', 'reserve:extraction', 'dispatch', 'retain:h-extraction']); }
  // lease lost while the provider answered: the receipt is settled (cost is real), the result is never published
  { let owned = true; const h = harness({ answer: COMPLETE, verifier: approve(true) }); const inner = h.deps.transport;
    h.deps.transport = async (body: any, signal, project) => { const res = await inner(body, signal, project); owned = false; return res; };
    const r = await executeReferenceKnowledgeTask(task(), { ...h.ctx(), deadlineAt: 60_000 } as any, async () => owned, h.deps);
    assert.ok(r.admitted); assert.equal(r.result, null);
    assert.deepEqual(h.log, ['attempt', 'reserve:extraction', 'dispatch', 'settle:h-extraction'], 'settled, then stopped: no verifier, no publication'); }
});
test('settlement: exact Sol receipt cost (the database formula); a failed settlement is retained as unknown, never left held', async () => {
  assert.equal(referenceReceiptNanoUsd({ inputTokens: 3000, cachedTokens: 1000, cacheWriteTokens: 1500, outputTokens: 200 }),
    500 * 2000 + 1000 * 100 + 1500 * 2500 + 200 * 10000);
  const log: string[] = []; let settled: any;
  const owner = { id: 'own', approvalReference: 'appr', providerProjectId: 'proj_owner', businessIds: [3], maximumRequestNanoUsd: 250_000_000, maximumTurnNanoUsd: 600_000_000,
    reserve: async (q: any) => ({ id: 'h1', reservationKey: q.reservationKey, maximumNanoUsd: q.maximumNanoUsd }),
    settle: async (_id: string, _q: any, u: any) => { settled = u; log.push('settle'); throw new Error('db'); }, retainUnknown: async () => { log.push('retain'); } };
  const provider = moneyBoundProvider({ task: task(), owner: owner as any, reserveModelAttempt: async () => undefined, deadlineAt: 60_000, now: () => 0,
    // input tokens within the request's proxy bound (request bytes + framing)
    transport: async () => ({ status: 200, json: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 1000, output_tokens: 200,
      input_tokens_details: { cached_tokens: 300, cache_write_tokens: 500 }, output_tokens_details: { reasoning_tokens: 0 } } } }) });
  const schema = { type: 'object' };
  await assert.rejects(provider({ role: 'answer', instructions: 'i', input: 'x', schemaName: 'reference_answer', schema, maxOutputTokens: 2048, signal: new AbortController().signal }), /db/);
  assert.equal(settled.estimatedNanoUsd, 200 * 2000 + 300 * 100 + 500 * 2500 + 200 * 10000);
  assert.deepEqual(log, ['settle', 'retain']);
});
test('provider project: bound to the reserving authority and passed to the transport; an owner without one is refused before any attempt or hold', async () => {
  const h = harness({ answer: COMPLETE, verifier: approve(true) }); const projects: string[] = []; const inner = h.deps.transport;
  h.deps.transport = async (body: any, signal, projectId) => { projects.push(projectId); return inner(body, signal, projectId); };
  const r = await executeReferenceKnowledgeTask(task(), { ...h.ctx(), deadlineAt: 60_000 } as any, async () => true, h.deps);
  assert.ok(r.admitted && r.result); assert.deepEqual(projects, ['proj_owner', 'proj_owner']);
  const none = harness({ answer: COMPLETE, verifier: approve(true) });
  const ownerWithout = { ...(none.deps.owner(3) as any) }; delete ownerWithout.providerProjectId;
  const r2 = await executeReferenceKnowledgeTask(task(), { ...none.ctx(), deadlineAt: 60_000 } as any, async () => true, { ...none.deps, owner: () => ownerWithout });
  assert.ok(r2.admitted); assert.equal(r2.result, null); assert.deepEqual(none.log, [], 'no attempt, hold or dispatch');
});
test('configured-policy authority: a task in a configured-policy domain is never admitted (no list, attempt, hold or dispatch); the host keeps its engine', async () => {
  const h = harness({ answer: COMPLETE, verifier: approve(true) }); let listed = 0; const list = h.deps.listSources;
  const r = await executeReferenceKnowledgeTask(task({ question: 'Vad kostar det att avboka sent?' }), { ...h.ctx(), deadlineAt: 60_000 } as any, async () => true,
    { ...h.deps, listSources: async (...args: any[]) => { listed++; return (list as any)(...args); }, configuredPolicyAuthority: () => true });
  assert.deepEqual(r, { admitted: false, refusal: 'CONFIGURED_POLICY_AUTHORITY' }); assert.equal(listed, 0); assert.deepEqual(h.log, []);
});
