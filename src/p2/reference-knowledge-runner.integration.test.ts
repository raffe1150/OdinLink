/** End-to-end offline: the REAL KnowledgeRunner + fake lifecycle repository + the reference adapter + a scripted transport.
 * SYNTHETIC model outputs; no provider, database or money. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { brainV2ProductionWiring, MANAGED_OPENAI_BASE_URL } from '../ai/brain-v2-production-wiring';
import { KnowledgeRunner, deliverKnowledge, type KnowledgeExecutor, type GuardedKnowledgeTransport } from './knowledge-runner';
import { FakeKnowledgeDatabase, FakeKnowledgeLifecycle } from '../../tests/helpers/fake-knowledge-lifecycle';
import { safeUnavailableKnowledge, type KnowledgeScope, type VerifiedKnowledge } from './knowledge-lifecycle';
import { executeReferenceKnowledgeTask, referenceEngineConfig, referenceEngineSelected, type ReferenceTransport } from './reference-knowledge-executor';
import type { KnowledgeSource } from '../../knowledge';
import { pinCorpus } from '../experimental/knowledge-reference/corpus';
import { loadFixtureSources } from '../experimental/knowledge-reference/eval/dataset';
import { approvingVerifier, scriptedProvider, type Script } from '../experimental/knowledge-reference/eval/scripted';
import type { AnswerOutput, ProviderRequest } from '../experimental/knowledge-reference/types';

const fixture = loadFixtureSources();
const SOURCES: KnowledgeSource[] = fixture.map(r => ({ id: r.id, businessId: r.businessId, type: r.type as any, title: r.title, status: r.status as any,
  content: r.content, createdAt: r.updatedAt, updatedAt: r.updatedAt, metadata: (r.type === 'document' ? { segments: [{ start: 0, end: r.content.length }] } : {}) as any }));
const ARRIVE = pinCorpus(3, fixture).corpus!.evidence.passages.find(p => p.text.includes('cirka 10 minuter'))!.ref;
const TEXT = 'Vid ditt första besök rekommenderas du att komma cirka 10 minuter före din bokade tid.';
const COMPLETE: AnswerOutput = { language: 'sv', draft: '', obligations: [{ id: 'a1', description: 'ankomst', status: 'answered' }],
  units: [{ id: 'u1', text: TEXT, modality: 'recommended', conditions: [], citations: [], evidence: [ARRIVE], addresses: ['a1'] }] };
const ABSENT_TEXT = 'Öppettiderna har jag tyvärr ingen information om.';
const ABSENT: AnswerOutput = { language: 'sv', draft: '', obligations: [{ id: 'a1', description: 'öppettider', status: 'not_in_sources' }],
  units: [{ id: 'h1', kind: 'limitation', text: ABSENT_TEXT, modality: 'descriptive', conditions: [], citations: [], evidence: [], addresses: ['a1'] }] };
const verifier = (available: boolean) => approvingVerifier(s => [{ id: 'v1', description: 'x', kind: 'information', availableInSources: available,
  sourcesConflict: false, status: available ? 'complete' : 'not_addressed', coveredByUnits: s.map(u => u.id), missingInformation: [] }]);
const ON = { ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'owner', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3', ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS: '3:telegram:0f8fad5b-d9cb-469f-a165-70867728950e' };

function world(script: Script, opts: { env?: Record<string, string>; deny?: boolean; failAt?: number; duringDispatch?: (n: number) => Promise<void> | void } = {}) {
  let now = Date.now(); let allowed = true;
  const db = new FakeKnowledgeDatabase();
  const scope: KnowledgeScope = { businessId: 3, channel: 'telegram', providerAccount: 'bot', conversationId: '0f8fad5b-d9cb-469f-a165-70867728950e' };
  const repo = new FakeKnowledgeLifecycle(db, () => now, async () => allowed);
  const log: string[] = [];
  const scripted = scriptedProvider(script);
  let dispatches = 0;
  const transport: ReferenceTransport = async (body: any, signal) => {
    dispatches++; log.push(`dispatch:${dispatches}`);
    await opts.duringDispatch?.(dispatches);
    if (opts.failAt === dispatches) throw Object.assign(new Error('timeout'), { name: 'AbortError' });
    const r = await scripted({ role: String(body.text.format.name).includes('answer') ? 'answer' : 'verifier', instructions: body.instructions, input: body.input,
      schemaName: body.text.format.name, schema: body.text.format.schema, maxOutputTokens: body.max_output_tokens, signal } as ProviderRequest);
    return { status: 200, json: { id: `resp_${dispatches}`, status: 'completed', model: 'gpt-6.1-sol', output: [{ content: [{ type: 'output_text', text: r.text }] }],
      usage: { input_tokens: 3000, output_tokens: 200, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 3000 }, output_tokens_details: { reasoning_tokens: 0 } } } };
  };
  const owner = { id: 'own', approvalReference: 'appr', providerProjectId: 'proj_owner', businessIds: [3], maximumRequestNanoUsd: 150_000_000, maximumTurnNanoUsd: 300_000_000,
    reserve: async (q: any) => { log.push(`reserve:${q.stage}`); return opts.deny ? null : { id: `h-${q.stage}`, reservationKey: q.reservationKey, maximumNanoUsd: q.maximumNanoUsd }; },
    settle: async (id: string) => { log.push(`settle:${id}`); }, retainUnknown: async (_q: any, id: string | null) => { log.push(`retain:${id}`); } };
  let legacy = 0;
  const env = { ...(opts.env ?? ON), OPENAI_API_KEY: 'synthetic-offline' };
  const config = referenceEngineConfig(env);
  const binding = brainV2ProductionWiring(env, {
    trialEnforced: () => false,
    routingAuthority: () => undefined,
    referenceOwner: () => owner,
    createClient: options => {
      assert.equal(options.baseURL, MANAGED_OPENAI_BASE_URL);
      assert.equal(options.maxRetries, 0);
      return { responses: { create: (body, requestOptions) => ({
        withResponse: async () => {
          assert.equal(body.model, 'gpt-6.1-sol');
          assert.equal(requestOptions.maxRetries, 0);
          assert.equal(requestOptions.headers['OpenAI-Project'], owner.providerProjectId);
          const result = await transport(body, requestOptions.signal, owner.providerProjectId);
          return { data: result.json, response: { status: result.status, headers: new Headers({ 'OpenAI-Project': owner.providerProjectId }) } };
        },
      }) } };
    },
  }).referenceBinding;
  // The exact server.ts dispatch, with the binding installed for the test.
  const executor: KnowledgeExecutor = async (task, context) => {
    if (binding && referenceEngineSelected(task, config)) {
      const r = await executeReferenceKnowledgeTask(task, context, async () => true, {
        ...binding, listSources: async () => SOURCES,
      });
      if (r.admitted) return r.result;
    }
    legacy++; return null;
  };
  const send = { calls: 0 };
  const guarded: GuardedKnowledgeTransport = { authorize: async () => allowed, eligible: async () => true,
    resolve: async task => ({ channel: task.scope.channel, providerAccount: task.scope.providerAccount, recipient: 'owner' }),
    send: async () => { send.calls++; return { kind: 'API_ACCEPTED', providerMessageId: `m${send.calls}` }; } };
  return { current: '', db, scope, repo, log, executor, guarded, send, legacy: () => legacy, advance: (ms: number) => { now += ms; }, revoke: () => { allowed = false; },
    connect: () => new FakeKnowledgeLifecycle(db, () => now, async () => allowed) };
}
const question = { question: 'När ska jag komma till mitt första besök?', language: 'sv', history: [] };
/** The owner-pilot window (ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_EXECUTION_MS=75000): the only window in which the Reference Engine is admitted
 * (standard 20–40 s windows leave < 27 s of compute and keep the existing engine; asserted in reference-knowledge-executor.test.ts). */
const PILOT = { executionMs: 75_000 };

async function runOnce(w: ReturnType<typeof world>, input = question) {
  const a = await w.repo.accept(w.scope, 'event-1', input, PILOT);
  w.current = a.task!.id;
  const delivery = await new KnowledgeRunner(w.repo, w.executor, 'worker').run(w.scope, a.task!.id);
  return { a, delivery };
}

test('complete answer: two sequential stages, attempts and money per stage, one delivery; a duplicate delivery is refused', async () => {
  const w = world({ answer: COMPLETE, verifier: verifier(true) });
  const { a, delivery } = await runOnce(w);
  assert.ok(delivery);
  assert.equal(delivery!.text, TEXT);
  assert.deepEqual(w.log, ['reserve:extraction', 'dispatch:1', 'settle:h-extraction', 'reserve:verification', 'dispatch:2', 'settle:h-verification']);
  assert.equal((await w.repo.get(w.scope, a.task!.id))!.modelAttempts, 2);
  const sent = await deliverKnowledge(w.repo, w.guarded, w.scope, a.task!.id, delivery!.id, 'sender');
  assert.equal(sent!.outcome.kind, 'API_ACCEPTED');
  assert.equal(await deliverKnowledge(w.repo, w.guarded, w.scope, a.task!.id, delivery!.id, 'sender'), null);
  assert.equal(w.send.calls, 1);
  assert.equal(w.legacy(), 0);
});

test('verified absence is finalized and delivered with its natural wording', async () => {
  const w = world({ answer: ABSENT, verifier: verifier(false) });
  const { delivery } = await runOnce(w, { ...question, question: 'Vilka är era öppettider?' });
  assert.equal(delivery!.text, ABSENT_TEXT);
});

test('reservation denial, provider timeout or a negative verdict: safe-unavailable or nothing — never the old engine, never the answer', async () => {
  const cases: [string, ReturnType<typeof world>][] = [
    ['denied', world({ answer: COMPLETE, verifier: verifier(true) }, { deny: true })],
    ['timeout', world({ answer: COMPLETE, verifier: verifier(true) }, { failAt: 2 })],
    ['rejected', world({ answer: COMPLETE, verifier: (s: any, d: string) => { const o = verifier(true)(s, d); return { ...o, units: o.units.map(u => ({ ...u, verdict: 'NOT_ENTAILED' as const })) }; } })],
  ];
  for (const [name, w] of cases) {
    const { delivery } = await runOnce(w);
    assert.ok(!delivery || delivery.text === safeUnavailableKnowledge('sv').text, name);
    assert.ok(!delivery?.text.includes('10 minuter'), name);
    assert.equal(w.legacy(), 0, name);
  }
  assert.ok(cases[0][1].log.every(l => !l.startsWith('dispatch')), 'no dispatch without a hold');
  assert.ok(cases[1][1].log.includes('retain:h-verification'), 'unknown outcome retained');
});

test('lease lost during a provider call: the old worker cannot finalize or deliver', async () => {
  const w = world({ answer: COMPLETE, verifier: verifier(true) }, { duringDispatch: async n => {
    if (n === 2) { w.advance(15_001); await w.connect().claim(w.scope, w.current, 'other', 15_000); } } });
  const { delivery } = await runOnce(w);
  assert.equal(delivery, null);
  assert.equal(w.db.rows.deliveries.size, 0);
});

test('recovery after interruption: the recovered run makes no further provider call and publishes no reference answer', async () => {
  const w = world({ answer: COMPLETE, verifier: verifier(true) });
  const a = await w.repo.accept(w.scope, 'event-1', question, PILOT);
  const t = (await w.repo.claim(w.scope, a.task!.id, 'dead', 100))!;
  await w.repo.reserveModelAttempt(w.scope, { taskId: t.id, owner: 'dead', fence: t.fence }); w.advance(101);
  await new KnowledgeRunner(w.connect(), w.executor, 'recovery').recover(w.scope);
  assert.ok(!w.log.some(l => l.startsWith('dispatch')));
  const deliveries = [...w.db.rows.deliveries.values()] as any[];
  assert.ok(deliveries.every(d => d.text === safeUnavailableKnowledge('sv').text));
  assert.equal(w.legacy(), 0);
});

test('authority revoked before delivery (e.g. a source changed): nothing is sent', async () => {
  const w = world({ answer: COMPLETE, verifier: verifier(true) });
  const { a, delivery } = await runOnce(w);
  w.revoke();
  assert.equal(await deliverKnowledge(w.repo, w.guarded, w.scope, a.task!.id, delivery!.id, 'sender'), null);
  assert.equal(w.send.calls, 0);
});

test('flag OFF and unauthorized owner-mode conversations keep the existing engine; no provider call is made by the adapter', async () => {
  for (const env of [{}, { ...ON, ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS: '3:telegram:9b2f6c1e-4d3a-4e8b-9c7d-1a2b3c4d5e6f' }]) {
    const w = world({ answer: COMPLETE, verifier: verifier(true) }, { env });
    await runOnce(w);
    assert.equal(w.legacy(), 1);
    assert.deepEqual(w.log, []);
  }
});
