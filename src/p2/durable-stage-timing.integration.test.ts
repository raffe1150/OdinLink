/** Durable Async Sol stage timing (offline). Every Sol call is a MOCK of OpenAI.Responses.create that honours the exact
 * `timeout` the application authorizes (as the SDK does): a response slower than that timeout is a timeout, never a
 * late success. A simulated clock replaces real waiting; while a call is in flight the mock emulates the runner's lease
 * heartbeat (renew every 5 s for 15 s) unless a test stops it. No database, network, provider or production write. */
import test, { afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { FakeKnowledgeDatabase, FakeKnowledgeLifecycle } from '../../tests/helpers/fake-knowledge-lifecycle';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';
import { configureKnowledgeBudgetOwner, durableVerificationDeadline, knowledgeStageOptions, captureKnowledgeModelProfile } from '../ai/knowledge-model-policy';
import { ACCURACY_FIRST_POLICY, DURABLE_EXTENDED_STAGE_TIMING, accuracyFirstExtractionAllowance, durableExtendedExtractionAllowance,
  durableStageCapMs, knowledgeStageCapMs } from '../ai/knowledge-timing-policy';
import { DurableKnowledgeBudget } from './durable-knowledge-budget';
import { knowledgeExecutionDeadline } from './knowledge-operation';
import { KnowledgeRunner, deliverKnowledge, type GuardedKnowledgeTransport } from './knowledge-runner';
import { safeUnavailableKnowledge, type KnowledgeScope } from './knowledge-lifecycle';

Object.assign(process.env, {
  NODE_ENV: 'test', AI_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-offline', ODINLINK_AI_DEFAULT_MODEL: 'gpt-6.1-sol',
  ODINLINK_EVIDENCE_FIRST_KNOWLEDGE: 'true', ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'source-exhaustive-v2', ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL: 'v2',
  ODINLINK_GROUNDED_NATURAL_RESPONSES: 'false', ODINLINK_KNOWLEDGE_NATURAL_COMPOSER: 'off', ODINLINK_SMART_WAITING: 'false',
});
delete process.env.AI_PROVIDER_TIMEOUT_MS; // production-shaped default (20 s) so the provider-layer cap is exercised too
const realNow = Date.now.bind(Date); let skew = 0; Date.now = () => realNow() + skew;
const { executeDurableKnowledgeTask, priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
afterEach(() => { b.reset(); configureKnowledgeBudgetOwner(); });

type Channel = KnowledgeScope['channel'];
type Plan = { preMs?: number; windowMs?: number; extractionMs?: number; verificationMs?: number; publicationV2?: boolean; businessId?: number;
  betweenStagesMs?: number; verificationReservationMs?: number;
  heartbeat?: boolean; extraction?: 'ok' | 'drop' | 'interrupt' | 'steal' | 'revise'; channel?: Channel };
const FACT = 'Parking is in the courtyard behind the studio.';
const QUESTION = 'Where can I park my car when visiting the studio?';

function verifier(data: any) {
  const accepted = data.units.map((u: any) => u.id);
  return {
    decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: 'ENTAILED', meaningPreserved: true, modalityPreserved: true,
      qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
    coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE',
      materialUnitIds: accepted, obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'COVERED', unitIds: accepted })) })),
    sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: true, conditionsPreserved: true,
      conflictsAbsent: true, evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: accepted,
      obligations: data.facets.flatMap((f: any) => f.obligations.map((o: any) => ({ facetId: f.id, obligationId: o.id, state: 'COMPLETE' }))) },
  };
}

async function harness(t: TestContext, plan: Plan) {
  for (const level of ['log', 'warn', 'info', 'error'] as const) t.mock.method(console, level, () => {});
  const businessId = plan.businessId ?? 3, channel = plan.channel ?? 'telegram';
  const owner = new ScriptedKnowledgeBudgetOwner(); owner.businessIds = [businessId]; configureKnowledgeBudgetOwner(owner);
  let revision = 'v1';
  const decisions: Record<string, unknown>[] = [];
  b.configure({
    evidenceFirstDecisionDiagnostic: (event: Record<string, unknown>) => decisions.push(event),
    knowledgeSearch: async () => [{ businessId, sourceId: 'doc', text: FACT, score: 1, metadata: { source: 'document', documentRevision: revision } }],
    semanticKnowledgeSearch: async () => [], validateKnowledgeMatches: async (_id: any, matches: any) => matches.map((m: any) => ({ ...m, metadata: { ...m.metadata, documentRevision: revision } })),
    calendarAdapter: { getCalendarId: () => 'unused', getEvents: async () => assert.fail('No Booking reads'), insertAppointment: async () => assert.fail('No Booking'),
      cancelAppointment: async () => assert.fail('No Booking'), updateAppointment: async () => assert.fail('No Booking'), checkSlots: async () => assert.fail('No Booking') },
  } as any);
  const db = new FakeKnowledgeDatabase(), repo = new FakeKnowledgeLifecycle(db, () => Date.now(), async () => true);
  const scope: KnowledgeScope = { businessId, channel, providerAccount: 'account', conversationId: randomUUID() };
  const eventId = randomUUID();
  const accepted = await repo.accept(scope, eventId, { question: QUESTION, language: 'en', history: [] },
    { executionMs: plan.windowMs ?? 75_000, maxModelAttempts: 4 });
  const taskId = accepted.task!.id;
  if (plan.publicationV2 ?? true) (db.rows.tasks.get(taskId) as any).publicationV2 = true; // persisted admission field (fixture)
  let heartbeatStopped = plan.heartbeat === false;
  const heartbeat = () => { if (heartbeatStopped) return;
    for (const task of db.rows.tasks.values()) if (task.lease && task.lease.until > Date.now())
      task.lease = { ...task.lease, until: Math.min(Date.now() + 15_000, task.expiresAt) }; };
  const advance = (ms: number) => { for (let left = ms; left > 0; left -= 5_000) { skew += Math.min(5_000, left); heartbeat(); } };
  if (plan.verificationReservationMs) {
    const reserve = repo.reserveModelAttempt.bind(repo);
    t.mock.method(repo, 'reserveModelAttempt', async (...args: Parameters<typeof reserve>) => {
      if (db.rows.tasks.get(taskId)?.modelAttempts === 1) advance(plan.verificationReservationMs!);
      return reserve(...args);
    });
  }
  const calls: { stage: string; timeoutMs: number; generationRemainingMs: number; outcome: string }[] = [];
  let runner: KnowledgeRunner | undefined;
  t.mock.method(OpenAI.Responses.prototype, 'create', async function (wire: any, options: any) {
    const instructions = String(wire.instructions);
    const stage = wire.text?.format?.name === 'odinlink_knowledge_source_exhaustive_v2' || /ENTAILMENT/u.test(instructions) ? 'verification' : 'extraction';
    assert.equal(wire.model, 'gpt-6.1-sol'); assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted);
    const task = db.rows.tasks.get(taskId)!;
    const record = { stage, timeoutMs: options.timeout, generationRemainingMs: knowledgeExecutionDeadline(task) - 1_500 - Date.now(), outcome: 'pending' };
    calls.push(record);
    const data = JSON.parse(wire.input[0].content);
    if (stage === 'extraction') {
      if (plan.extraction === 'drop') { advance(5_000); record.outcome = 'connection_lost'; throw new Error('socket hang up'); }
      if (plan.extraction === 'interrupt') { advance(5_000); record.outcome = 'worker_stopped'; heartbeatStopped = true; runner!.stop(); throw options.signal.reason ?? new Error('aborted'); }
      if (plan.extraction === 'steal') { advance(16_000); await repo.claim(scope, taskId, 'worker-2', 15_000); }
      if (plan.extraction === 'revise') revision = 'v2';
    }
    const latency = stage === 'extraction' ? plan.extractionMs ?? 8_000 : plan.verificationMs ?? 6_000;
    if (latency > options.timeout) { advance(options.timeout); record.outcome = 'timeout';
      throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }); }
    advance(plan.extraction === 'steal' && stage === 'extraction' ? Math.max(0, latency - 16_000) : latency);
    record.outcome = 'completed';
    const payload = stage === 'verification' ? verifier(data) : { units: [{ facetIds: data.facets.map((f: any) => f.id), subject: 'studio',
      predicate: 'parking', value: FACT, modality: 'descriptive', negation: false, scope: 'studio visitors', qualifiers: [], language: 'en', text: FACT,
      evidenceRefs: [{ evidenceId: data.evidence.find((e: any) => e.text.includes(FACT))?.id, exactQuote: FACT }] }] };
    const text = JSON.stringify(payload);
    return { object: 'response', id: `resp_offline_${calls.length}`, model: wire.model, status: 'completed', service_tier: wire.service_tier,
      reasoning: wire.reasoning, prompt_cache_options: wire.prompt_cache_options, output_text: text,
      output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 500, output_tokens: 200, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  });
  const config = { id: businessId, businessId, businessName: 'Synthetic studio', language: 'en', timezone: 'Europe/Stockholm', services: [] };
  skew += plan.preMs ?? 5_000; // intake -> worker start (foreground routing, poll, claim), counted against the persisted window
  const makeRunner = (name: string) => new KnowledgeRunner(repo, (task, context) => executeDurableKnowledgeTask(task, {
    ...context,
    checkpoint: async stage => {
      if (stage === 'extraction' && plan.betweenStagesMs) advance(plan.betweenStagesMs);
      await context.checkpoint(stage);
    },
  }, config, async () => true), name);
  const run = async (name = 'worker') => { runner = makeRunner(name); return runner.run(scope, taskId); };
  return { db, repo, scope, taskId, eventId, owner, calls, decisions, run, advance, task: () => repo.get(scope, taskId) };
}
const safeText = safeUnavailableKnowledge('en').text;
const transport = (sends: string[], outcome: 'ok' | 'ambiguous' = 'ok'): GuardedKnowledgeTransport => ({
  authorize: async () => true, eligible: async () => true,
  resolve: async task => ({ recipient: 'recipient-1', channel: task.scope.channel, providerAccount: task.scope.providerAccount }),
  send: async (_target, text) => { sends.push(text); if (outcome === 'ambiguous') throw new Error('provider_timeout_after_entry');
    return { kind: 'API_ACCEPTED', providerMessageId: `msg-${sends.length}` }; } });

test('policy: async-only constants; foreground caps unchanged', () => {
  assert.equal(knowledgeStageCapMs('extraction'), 20_000); assert.equal(knowledgeStageCapMs('verification'), 19_999);
  assert.equal(durableStageCapMs('verification'), 22_000);
  assert.deepEqual([ACCURACY_FIRST_POLICY.extractionMs, ACCURACY_FIRST_POLICY.verificationMs, ACCURACY_FIRST_POLICY.verificationReserveMs], [20_000, 19_999, 12_000]);
  assert.equal(accuracyFirstExtractionAllowance(53_500), 20_000);
  assert.deepEqual([durableExtendedExtractionAllowance(53_500), durableExtendedExtractionAllowance(40_000), durableExtendedExtractionAllowance(22_000),
    durableExtendedExtractionAllowance(Number.NaN)], [30_000, 18_000, 0, 0]);
  const task = (windowMs: number, publicationV2: boolean, businessId = 3) => ({ acceptedAt: 1_000, expiresAt: 1_000 + windowMs, publicationV2,
    scope: { businessId }, maxModelAttempts: 4, modelAttempts: 0 }) as any;
  const signal = new AbortController().signal, reserve = async () => {};
  assert.equal(new DurableKnowledgeBudget(task(75_000, true), signal, reserve).stageTiming, DURABLE_EXTENDED_STAGE_TIMING);
  for (const t of [task(40_000, true), task(75_000, false), task(75_000, true, 77), task(74_999, true)])
    assert.equal(new DurableKnowledgeBudget(t, signal, reserve).stageTiming, undefined);
});

test('permit: a durable stage cap is refused for a non-durable selection and for any other value', () => {
  const owner = new ScriptedKnowledgeBudgetOwner(); owner.businessIds = [3]; configureKnowledgeBudgetOwner(owner);
  const base = { businessId: 3, turnId: 't', requestKey: 'a'.repeat(64), provider: 'openai', natural: false, extractionProtocol: 'v2',
    verificationProtocol: 'source-exhaustive-v2', documentary: true, operational: false, current: async () => true };
  const binding = { businessId: 3, turnId: 't', requestKey: 'a'.repeat(64) };
  const durable = captureKnowledgeModelProfile({ ...base, nativeForeground: false, durable: true, durablePublicationV2: true }, {});
  assert.throws(() => knowledgeStageOptions(durable, 'extraction', binding, Date.now() + 1_000, 45_000), /stage_cap/);
  assert.equal(knowledgeStageOptions(durable, 'extraction', binding, Date.now() + 1_000, 30_000).model, 'gpt-6.1-sol');
  assert.throws(() => knowledgeStageOptions(durable, 'verification', binding, Date.now() + 40_000, 19_999), /stage_cap/);
  const now = Date.now();
  const permit = knowledgeStageOptions(durable, 'verification', binding, now + 40_000, 22_000).knowledgeExecution;
  assert.ok(durableVerificationDeadline(permit)! >= now + 22_000 && durableVerificationDeadline(permit)! <= Date.now() + 22_000);
  const foreground = captureKnowledgeModelProfile({ ...base, turnId: 'f', nativeForeground: true, durable: false },
    { ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'off', ODINLINK_AI_DEFAULT_MODEL: 'gpt-6.1-sol' } as any);
  if (foreground.id !== 'default') assert.throws(() => knowledgeStageOptions(foreground, 'extraction', { ...binding, turnId: 'f' }, Date.now() + 1_000, 30_000), /stage_cap/);
});

for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger'] as const)
  test(`${channel}: 25 s extraction (> foreground 20 s) then independent verification publishes the verified fact once`, async t => {
    const h = await harness(t, { channel, extractionMs: 25_000, verificationMs: 8_000 });
    const delivery = await h.run();
    assert.deepEqual(h.calls.map(c => [c.stage, c.outcome]), [['extraction', 'completed'], ['verification', 'completed']]);
    const [extraction, verification] = h.calls;
    assert.ok(extraction.timeoutMs > 25_000 && extraction.timeoutMs <= 30_000, `extraction timeout ${extraction.timeoutMs}`);
    assert.ok(extraction.timeoutMs <= extraction.generationRemainingMs - DURABLE_EXTENDED_STAGE_TIMING.verificationReserveMs, 'verification reserve kept');
    assert.ok(verification.timeoutMs <= 22_000 && verification.timeoutMs <= verification.generationRemainingMs + 1);
    assert.equal(delivery?.text, FACT); assert.equal((await h.task())?.state, 'FINALIZED'); assert.equal(h.db.rows.deliveries.size, 1);
    assert.equal((await h.task())?.modelAttempts, 2);
    assert.deepEqual(h.owner.events, ['reserve', 'settle', 'reserve', 'settle']);
  });

test('verification near its deadline: slow pre-work and slow extraction still leave the verifier its full cap', async t => {
  const h = await harness(t, { preMs: 12_000, extractionMs: 24_000, verificationMs: 19_500 });
  const delivery = await h.run();
  assert.deepEqual(h.calls.map(c => c.outcome), ['completed', 'completed']);
  assert.ok(h.calls[0].timeoutMs <= h.calls[0].generationRemainingMs - 22_000 + 1, `extraction ${h.calls[0].timeoutMs}`);
  assert.ok(h.calls[1].timeoutMs >= 19_500, `verifier got ${h.calls[1].timeoutMs}`);
  assert.equal(delivery?.text, FACT);
});

// 23.503 s of extraction allowance at about 13 s into the 75 s task. The
// extraction, checkpoint/freshness gap, and second reservation then consume
// roughly 23.3 s, leaving about 22.181 s of generation budget at reservation.
const observedTiming = { preMs: 12_997, extractionMs: 20_943, betweenStagesMs: 1_924, verificationReservationMs: 455 };

for (const [label, extraMs] of [['22 s cap', 0], ['generation cutoff', 900]] as const)
  test(`observed extraction timing: verifier succeeds after 20 s within the ${label}`, async t => {
    const h = await harness(t, { ...observedTiming, betweenStagesMs: observedTiming.betweenStagesMs + extraMs, verificationMs: 20_500 });
    const delivery = await h.run();
    assert.deepEqual(h.calls.map(c => [c.stage, c.outcome]), [['extraction', 'completed'], ['verification', 'completed']]);
    const [extraction, verification] = h.calls;
    assert.ok(extraction.timeoutMs > 20_943 && extraction.timeoutMs <= 23_503);
    assert.ok(verification.timeoutMs >= 20_500 && verification.timeoutMs <= 22_000);
    assert.ok(verification.timeoutMs <= verification.generationRemainingMs + 1);
    if (extraMs) assert.ok(verification.timeoutMs >= verification.generationRemainingMs - 1);
    const admission = h.decisions.filter(event => event.eventType === 'verification_admission')
      .map(event => event.admission as { effectiveAllowanceMs: number; admitted: boolean });
    assert.equal(admission.length, 3);
    assert.ok(admission.every(event => event.admitted && event.effectiveAllowanceMs <= 22_000));
    assert.ok(admission[2].effectiveAllowanceMs < admission[1].effectiveAllowanceMs, 'reservation consumes the same deadline');
    const task = (await h.task())!;
    assert.equal(task.expiresAt - task.acceptedAt, 75_000);
    assert.equal(task.expiresAt - knowledgeExecutionDeadline(task), 15_000);
    assert.ok(knowledgeExecutionDeadline(task) - Date.now() >= 1_500);
    assert.equal(task.modelAttempts, 2);
    assert.equal(task.result?.independentlyVerified, true);
    assert.deepEqual(h.owner.events, ['reserve', 'settle', 'reserve', 'settle']);
    assert.ok(delivery);
    const sends: string[] = [];
    assert.equal(await h.run('new-worker'), null);
    assert.equal((await deliverKnowledge(h.repo, transport(sends), h.scope, h.taskId, delivery.id, 'sender'))?.settled, true);
    assert.equal(await deliverKnowledge(h.repo, transport(sends), h.scope, h.taskId, delivery.id, 'sender'), null);
    assert.deepEqual(sends, [FACT]);
    assert.equal(h.calls.length, 2);
  });

test('verification exceeding its cap times out once: safe reply, unknown hold kept, no re-dispatch', async t => {
  const h = await harness(t, { ...observedTiming, verificationMs: 22_500 });
  const delivery = await h.run();
  assert.deepEqual(h.calls.map(c => [c.stage, c.outcome]), [['extraction', 'completed'], ['verification', 'timeout']]);
  assert.equal(delivery?.text, safeText); assert.equal(h.db.rows.deliveries.size, 1);
  const holds = [...h.owner.reservations.values()];
  assert.deepEqual(holds.map(r => [r.quote.stage, !!r.unknown, r.cost !== undefined]), [['extraction', false, true], ['verification', true, false]]);
  assert.equal(await h.run('new-worker'), null);
  const sends: string[] = [];
  assert.ok(delivery);
  assert.equal((await deliverKnowledge(h.repo, transport(sends), h.scope, h.taskId, delivery.id, 'sender'))?.settled, true);
  assert.equal(await deliverKnowledge(h.repo, transport(sends), h.scope, h.taskId, delivery.id, 'sender'), null);
  assert.deepEqual(sends, [safeText]);
  assert.equal(h.calls.length, 2);
});

test('insufficient verifier dispatch time after the durable reservation leaves only the extraction charge', async t => {
  const h = await harness(t, { ...observedTiming, betweenStagesMs: observedTiming.betweenStagesMs + 11_000, verificationReservationMs: 2_500 });
  assert.equal((await h.run())?.text, safeText);
  assert.deepEqual(h.calls.map(c => c.stage), ['extraction']);
  assert.deepEqual(h.owner.events, ['reserve', 'settle']);
  const admission = h.decisions.filter(event => event.eventType === 'verification_admission');
  assert.equal(admission.length, 3);
  assert.equal(admission[2].reason, 'STAGE_ADMISSION');
  assert.ok(Number((admission[2].admission as any).effectiveAllowanceMs) < ACCURACY_FIRST_POLICY.verificationDispatchMs);
});

test('extraction slower than the authorized allowance is a timeout (no late capture) and keeps an unknown hold', async t => {
  const h = await harness(t, { extractionMs: 31_000 });
  const delivery = await h.run();
  assert.deepEqual(h.calls.map(c => [c.stage, c.outcome]), [['extraction', 'timeout']]);
  assert.ok(h.calls[0].timeoutMs <= 30_000);
  assert.equal(delivery?.text, safeText);
  assert.deepEqual([...h.owner.reservations.values()].map(r => [r.quote.stage, !!r.unknown]), [['extraction', true]]);
});

test('no room for the verification reserve: zero Sol dispatch, zero reservation, safe reply', async t => {
  const h = await harness(t, { preMs: 37_000 });
  const delivery = await h.run();
  assert.deepEqual(h.calls, []); assert.equal(h.owner.reservations.size, 0);
  assert.equal(delivery?.text, safeText);
});

test('worker interrupted mid-extraction (outcome unknown): hold kept, recovery never re-dispatches, one safe reply', async t => {
  const h = await harness(t, { extraction: 'interrupt', extractionMs: 25_000 });
  await assert.rejects(h.run('worker-1'));
  assert.deepEqual([...h.owner.reservations.values()].map(r => [r.quote.stage, !!r.unknown]), [['extraction', true]]);
  h.advance(16_000); // stale lease expires; a recovering worker claims with a new fence
  const recovered = await h.run('worker-2');
  assert.equal(h.calls.length, 1, 'the uncertain extraction is never dispatched again');
  assert.equal(h.owner.reservations.size, 1);
  assert.equal(recovered?.text, safeText); assert.equal((await h.task())?.fence, 2); assert.equal(h.db.rows.deliveries.size, 1);
});

test('connection lost mid-extraction: unknown hold, no retry, safe reply', async t => {
  const h = await harness(t, { extraction: 'drop' });
  const delivery = await h.run();
  assert.deepEqual(h.calls.map(c => c.outcome), ['connection_lost']);
  assert.deepEqual([...h.owner.reservations.values()].map(r => !!r.unknown), [true]);
  assert.equal(delivery?.text, safeText);
});

test('lost lease: a stale worker finishing a slow extraction cannot verify, publish or deliver', async t => {
  const h = await harness(t, { extraction: 'steal', extractionMs: 25_000, heartbeat: false });
  await assert.rejects(h.run('worker-1'));
  assert.deepEqual(h.calls.map(c => c.stage), ['extraction']);
  const task = await h.task();
  assert.equal(task?.fence, 2); assert.equal(task?.lease?.owner, 'worker-2'); assert.equal(task?.result, null);
  assert.equal(h.db.rows.deliveries.size, 0);
});

test('source revision changes during a slow extraction: the stale fact is not published', async t => {
  const h = await harness(t, { extraction: 'revise', extractionMs: 25_000 });
  const delivery = await h.run();
  assert.notEqual(delivery?.text, FACT);
  assert.ok(!delivery || delivery.text === safeText, delivery?.text);
});

test('duplicate inbound event attaches to the same task; one execution, one delivery, exactly one send', async t => {
  const h = await harness(t, { extractionMs: 25_000 });
  const duplicate = await h.repo.accept(h.scope, h.eventId, { question: QUESTION, language: 'en', history: [] }, { executionMs: 75_000, maxModelAttempts: 4 });
  assert.equal(duplicate.inserted, false); assert.equal(duplicate.task?.id, h.taskId);
  const delivery = await h.run(); assert.equal(await h.run('worker-2'), null);
  assert.equal(h.calls.length, 2);
  const sends: string[] = [];
  const first = await deliverKnowledge(h.repo, transport(sends), h.scope, h.taskId, delivery!.id, 'sender');
  const second = await deliverKnowledge(h.repo, transport(sends), h.scope, h.taskId, delivery!.id, 'sender');
  assert.equal(first?.outcome.kind, 'API_ACCEPTED'); assert.equal(second, null);
  assert.deepEqual(sends, [FACT]);
});

test('ambiguous outbound send is never retried', async t => {
  const h = await harness(t, { extractionMs: 25_000 });
  const delivery = await h.run();
  const sends: string[] = [];
  await assert.rejects(deliverKnowledge(h.repo, transport(sends, 'ambiguous'), h.scope, h.taskId, delivery!.id, 'sender'));
  assert.equal(await deliverKnowledge(h.repo, transport(sends), h.scope, h.taskId, delivery!.id, 'sender'), null);
  assert.deepEqual(sends, [FACT]); assert.equal(h.db.rows.deliveries.get(delivery!.id)?.state, 'UNCERTAIN');
});

test('regression: a non-extended durable window keeps the 20 s Sol extraction cap', async t => {
  const h = await harness(t, { windowMs: 40_000, preMs: 2_000, extractionMs: 25_000 });
  const delivery = await h.run();
  assert.deepEqual(h.calls.map(c => [c.stage, c.outcome]), [['extraction', 'timeout']]);
  assert.ok(h.calls[0].timeoutMs <= 20_000, String(h.calls[0].timeoutMs));
  assert.equal(delivery?.text, safeText);
});

test('regression: a non-extended durable verifier still times out at its original cap', async t => {
  const h = await harness(t, { windowMs: 40_000, preMs: 1_000, extractionMs: 1_000, verificationMs: 20_500 });
  assert.equal((await h.run())?.text, safeText);
  assert.deepEqual(h.calls.map(c => [c.stage, c.outcome]), [['extraction', 'completed'], ['verification', 'timeout']]);
  assert.ok(h.calls[1].generationRemainingMs > 20_500);
  assert.ok(h.calls[1].timeoutMs <= 19_999);
});

test('regression: a non-v2 durable task never selects Sol and gets no durable stage timing', async t => {
  const h = await harness(t, { publicationV2: false, extractionMs: 25_000 });
  await h.run().catch(() => null);
  assert.deepEqual(h.calls, []); assert.equal(h.owner.reservations.size, 0);
});
