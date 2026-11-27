import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { brainV2ProductionWiring, managedEndpointConfigured, BRAIN_V2_TIMEOUTS, MANAGED_OPENAI_BASE_URL } from './brain-v2-production-wiring';
import { ROUTING_MONEY } from './understanding/routing/money';
import { configureKnowledgeBudgetOwner, configureRoutingTurnAllowance, installedKnowledgeBudgetOwner, knowledgeReferenceMoneyAuthority,
  knowledgeRoutingMoneyAuthority, KNOWLEDGE_SOL_RATES } from './knowledge-model-policy';
import { captureInput } from '../p2/knowledge-lifecycle';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const KEY = { OPENAI_API_KEY: 'sk-' + 'x'.repeat(40) };
const ROUTING_ON = { ODINLINK_SEMANTIC_ROUTING_MODE: 'owner', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3', ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: '3:telegram:1' };
const REFERENCE_ON = { ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'owner', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3', ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS: '3:telegram:0f8fad5b-d9cb-469f-a165-70867728950e' };
const output = { primaryIntent: 'business_information', secondaryIntents: [], confidence: 0.9, requestsMutation: false, asksInformation: true,
  confirmation: 'none', continuesActiveBooking: false, language: 'sv', resolvedQuestion: 'Finns det parkering?', referencesResolved: false, languageSwitch: false,
  bookingRequest: { serviceMention: '', affirmative: false }, mixedParts: { informationSpan: '', bookingSpan: '', informationQuestion: '' }, evidence: [{ quote: 'parkering', intent: 'business_information' }] };
function client(seen: any[], echo = 'proj_live') {
  return { responses: { create: (body: any, options: any) => { seen.push({ body, options }); return { withResponse: async () => ({
    data: { id: 'resp_1', status: 'completed', usage: { input_tokens: 1500, output_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] },
    response: { status: 200, headers: { get: (n: string) => (n === 'openai-project' ? echo : null) } } }) }; } } };
}
function routingAuthority(log: string[], project: string | null) {
  return (_b: number) => ({ id: 'own', approvalReference: 'appr', ...(project ? { providerProjectId: project } : {}), maximumRequestNanoUsd: 100_000_000, maximumTurnNanoUsd: 900_000_000,
    async transition(command: string, payload: any) { log.push(command);
      if (command === 'reserve') return { id: 'r1', reservationKey: payload.quote.reservationKey, maximumNanoUsd: payload.quote.maximumNanoUsd };
      if (command === 'settle') return { settled: true }; return null; } });
}
/** constructed: every credential-bearing client construction (with its options). */
const deps = (seen: any[], log: string[], o: { project?: string | null; trial?: boolean; echo?: string } = {}) => {
  const constructed: any[] = [];
  return { constructed, d: { createClient: (options: any) => { constructed.push(options); return client(seen, o.echo) as any; }, trialEnforced: () => o.trial === true,
    routingAuthority: routingAuthority(log, o.project === undefined ? 'proj_live' : o.project), referenceOwner: () => undefined, now: () => 1_000 } };
};
const input = { message: 'Finns det parkering?', history: [], booking: null, conversationLanguage: null, pendingClarification: null };
const ident = { businessId: 3, requestKey: sha('k'), turnId: 'routing:t' };
const ATTESTED = { ...KEY, ...ROUTING_ON, ODINLINK_SEMANTIC_ROUTING_MONEY_STAGE: 'sol-routing-v1' };

test('default environment: nothing installed (no classifier, no Reference binding, no request cap, no carriage)', () => {
  const w = brainV2ProductionWiring({ ...KEY }, deps([], []).d);
  assert.deepEqual(w.status, { routing: 'off', reference: 'off', interpretationCarriage: false, routingRequestCapNanoUsd: 0, canonicalSpendTenant: null });
  assert.equal(w.canonicalSpendTenant, null, 'OFF deployment: baseline spend keys');
  assert.equal(w.routingClassifier, null); assert.equal(w.referenceBinding, undefined); assert.equal(w.routingAllowanceNanoUsd, 0);
});
test('routing without the money-stage attestation, credential or managed endpoint installs nothing (legacy routing)', () => {
  assert.equal(brainV2ProductionWiring({ ...KEY, ...ROUTING_ON }, deps([], []).d).status.routing, 'not_attested');
  assert.equal(brainV2ProductionWiring({ ...KEY, ...ROUTING_ON, ODINLINK_SEMANTIC_ROUTING_MONEY_STAGE: 'luna-routing-v1' }, deps([], []).d).routingClassifier, null);
  assert.equal(brainV2ProductionWiring({ ...ROUTING_ON, ODINLINK_SEMANTIC_ROUTING_MONEY_STAGE: 'sol-routing-v1' }, deps([], []).d).status.routing, 'no_credential');
  for (const base of ['https://proxy.example.com/v1', 'http://api.openai.com/v1', 'https://api.openai.com/v2'])
    assert.equal(brainV2ProductionWiring({ ...ATTESTED, OPENAI_BASE_URL: base }, deps([], []).d).status.routing, 'endpoint_refused', base);
  assert.equal(brainV2ProductionWiring({ ...ATTESTED, OPENAI_BASE_URL: 'https://api.openai.com/v1/' }, deps([], []).d).status.routing, 'installed');
  assert.equal(managedEndpointConfigured({}), true);
});
test('attested routing: client pinned to the managed endpoint, project of the reserving authority, zero retries, settled', async () => {
  const seen: any[] = [], log: string[] = [], { d, constructed } = deps(seen, log);
  const w = brainV2ProductionWiring(ATTESTED, d);
  assert.equal(w.status.routing, 'installed'); assert.equal(w.routingAllowanceNanoUsd, ROUTING_MONEY.routingAllowanceNanoUsd);
  const r = await w.routingClassifier!.classify(input, ident, new AbortController().signal);
  assert.equal((r.output as any).primaryIntent, 'business_information');
  assert.deepEqual(log, ['reserve', 'settle']); assert.equal(seen.length, 1);
  assert.deepEqual(constructed, [{ apiKey: KEY.OPENAI_API_KEY, baseURL: MANAGED_OPENAI_BASE_URL, maxRetries: 0 }]);
  assert.equal(seen[0].body.model, 'gpt-6.1-sol'); assert.equal(seen[0].options.maxRetries, 0); assert.equal(seen[0].options.headers['OpenAI-Project'], 'proj_live');
});
test('no credential-bearing dispatch: missing owner project, controlled trial, or provider project mismatch', async () => {
  // owner authority without a provider project → refused before any reservation or client
  { const seen: any[] = [], log: string[] = [], { d, constructed } = deps(seen, log, { project: null });
    await assert.rejects(brainV2ProductionWiring(ATTESTED, d).routingClassifier!.classify(input, ident, new AbortController().signal), /routing_provider_project_missing/);
    assert.deepEqual([log, constructed.length, seen.length], [[], 0, 0]); }
  // controlled trial active at dispatch → no client is ever constructed; the hold is retained as unknown (never released)
  { const seen: any[] = [], log: string[] = [], { d, constructed } = deps(seen, log, { trial: true });
    await assert.rejects(brainV2ProductionWiring(ATTESTED, d).routingClassifier!.classify(input, ident, new AbortController().signal), /routing_controlled_trial_refused/);
    assert.deepEqual([log, constructed.length, seen.length], [['reserve', 'unknown'], 0, 0]); }
  // provider answers for another project → uncertain outcome, exposure retained
  { const seen: any[] = [], log: string[] = [], { d } = deps(seen, log, { echo: 'proj_other' });
    await assert.rejects(brainV2ProductionWiring(ATTESTED, d).routingClassifier!.classify(input, ident, new AbortController().signal), /routing_project_mismatch/);
    assert.deepEqual(log, ['reserve', 'unknown']); }
});
test('Reference binding: managed endpoint, reserving authority project, 20 s cap; trial and bad project refuse before any client; deadline from compute time', async () => {
  const seen: any[] = [], { d, constructed } = deps(seen, []);
  const w = brainV2ProductionWiring({ ...KEY, ...REFERENCE_ON }, d);
  assert.equal(w.status.reference, 'installed');
  await w.referenceBinding!.transport({ model: 'gpt-6.1-sol' }, new AbortController().signal, 'proj_live');
  assert.deepEqual(constructed, [{ apiKey: KEY.OPENAI_API_KEY, baseURL: MANAGED_OPENAI_BASE_URL, maxRetries: 0 }]);
  assert.equal(seen[0].options.headers['OpenAI-Project'], 'proj_live'); assert.equal(seen[0].options.timeout, BRAIN_V2_TIMEOUTS.referenceTransportMs);
  assert.equal(seen[0].options.maxRetries, 0);
  // remaining time = the worker's compute deadline (75 s window → 60 s) minus elapsed, never task expiry
  assert.equal(w.referenceBinding!.remainingMs({ acceptedAt: 0, expiresAt: 75_000 } as any), 60_000 - 1_000);
  for (const [o, err] of [[{ trial: true }, /reference_controlled_trial_refused/], [{}, /reference_provider_project_missing/]] as const) {
    const x = deps([], [], o as any); const bound = brainV2ProductionWiring({ ...KEY, ...REFERENCE_ON }, x.d);
    await assert.rejects(bound.referenceBinding!.transport({}, new AbortController().signal, o === undefined || 'trial' in o ? 'proj_live' : 'not-a-project'), err);
    assert.equal(x.constructed.length, 0, 'no credential-bearing client');
  }
  assert.equal(brainV2ProductionWiring({ ...KEY, ...REFERENCE_ON, OPENAI_BASE_URL: 'https://proxy.example.com/v1' }, deps([], []).d).status.reference, 'endpoint_refused');
  const mismatch = brainV2ProductionWiring({ ...KEY, ...REFERENCE_ON }, deps([], [], { echo: 'proj_other' }).d);
  await assert.rejects(mismatch.referenceBinding!.transport({}, new AbortController().signal, 'proj_live'), /reference_project_mismatch/);
});
test('owner scope: allowlists bind tenant + channel + conversation; distinct identity types; exactly one pilot tenant; no cross-product', async () => {
  const { readSemanticRoutingConfig, SemanticRoutingRuntime } = await import('./understanding/routing/runtime');
  const { referenceEngineConfig, referenceEngineSelected } = await import('../p2/reference-knowledge-executor');
  // routing: RAW PROVIDER RECIPIENT ids, tenant-bound
  const r = new SemanticRoutingRuntime({ config: readSemanticRoutingConfig({ ODINLINK_SEMANTIC_ROUTING_MODE: 'owner', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3',
    ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: '3:telegram:111,4:telegram:222,telegram:333' }), classifier: null });
  assert.equal(r.eligible({ businessId: 3, channel: 'telegram', conversationId: '111' }), true);
  assert.equal(r.eligible({ businessId: 3, channel: 'whatsapp', conversationId: '111' }), false, 'channel bound');
  assert.equal(r.eligible({ businessId: 3, channel: 'telegram', conversationId: '222' }), false, 'entry of another tenant never authorizes this tenant');
  assert.equal(r.eligible({ businessId: 4, channel: 'telegram', conversationId: '222' }), false, 'tenant not approved');
  assert.equal(r.eligible({ businessId: 3, channel: 'telegram', conversationId: '333' }), false, 'unbound legacy format ignored');
  assert.equal(readSemanticRoutingConfig({ ODINLINK_SEMANTIC_ROUTING_MODE: 'owner', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3,4' }).businessIds.size, 0, 'one pilot tenant only');
  // reference: AUTHENTICATED DURABLE CONVERSATION UUIDs, tenant-bound
  const U = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const cfg = referenceEngineConfig({ ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'owner', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3', ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS: `3:telegram:${U}` });
  const t = (businessId: number, channel: string, conversationId: string) => ({ scope: { businessId, channel, conversationId } }) as any;
  assert.equal(referenceEngineSelected(t(3, 'telegram', U), cfg), true);
  assert.equal(referenceEngineSelected(t(3, 'whatsapp', U), cfg), false);
  assert.equal(referenceEngineSelected(t(4, 'telegram', U), cfg), false);
  for (const owners of ['3:telegram:111', `4:telegram:${U}`, `telegram:${U}`, `3:sms:${U}`])
    assert.equal(referenceEngineConfig({ ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'owner', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3', ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS: owners }).mode, 'off', owners);
  assert.equal(referenceEngineConfig({ ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'owner', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '3,4', ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS: `3:telegram:${U}` }).mode, 'off');
});
/** Emulates the deployed odin_ai_money_v1 turn accounting exactly as it matters here: the bucket ('turn', business, requestKey) sums held
 * maxima and settled costs; a reserve is denied when bucket + maximum > least(operator turn cap, PLAN turn cap, quote.maximumTurnNanoUsd);
 * unique(business, request_key, stage) and unique(reservation_key) refuse a second reservation (returns null: no dispatch). */
function authorityEmulator(operatorTurn: number, planTurn: number) {
  const rows = new Map<string, { key: string; stage: string; max: number; cost?: number; state: string }>(); const log: string[] = [];
  const bucket = (key: string) => [...rows.values()].filter(r => r.key === key).reduce((n, r) => n + (r.state === 'settled' ? r.cost! : r.max), 0);
  const reserve = (q: any) => {
    if (rows.has(q.reservationKey) || [...rows.values()].some(r => r.key === q.requestKey && r.stage === q.stage)) { log.push(`refused:${q.stage}`); return null; }
    if (bucket(q.requestKey) + q.maximumNanoUsd > Math.min(operatorTurn, planTurn, q.maximumTurnNanoUsd)) { log.push(`denied:${q.stage}`); return { denied: 'budget_exhausted' }; }
    rows.set(q.reservationKey, { key: q.requestKey, stage: q.stage, max: q.maximumNanoUsd, state: 'held' }); log.push(`reserved:${q.stage}`);
    return { id: q.reservationKey, reservationKey: q.reservationKey, maximumNanoUsd: q.maximumNanoUsd };
  };
  const settle = (q: any, u: any) => { const r = rows.get(q.reservationKey)!; r.state = 'settled'; r.cost = u.estimatedNanoUsd; log.push(`settled:${q.stage}`); };
  const unknown = (q: any) => { const r = rows.get(q.reservationKey); if (r && r.state !== 'settled') r.state = 'unknown'; log.push(`unknown:${q.stage}`); };
  return { rows, log, bucket, reserve, settle, unknown };
}
test('aggregate per-message invariant: routing + Reference (or legacy) share ONE canonical bucket under the plan-aware ceiling; exclusivity and recovery', async () => {
  const { moneyBoundProvider } = await import('../p2/reference-knowledge-executor');
  const { createAccountedRoutingClassifier } = await import('./understanding/routing/money');
  const { inboundMessageSpendKey, canonicalMessageSpendActive, configureCanonicalMessageSpend } = await import('./knowledge-model-policy');
  const operatorTurn = 900_000_000, planTurn = 120_000_000; // effective plan ceiling BELOW the operator ceiling
  const db = authorityEmulator(operatorTurn, planTurn);
  configureRoutingTurnAllowance(ROUTING_MONEY.routingAllowanceNanoUsd); configureCanonicalMessageSpend(3);
  try {
    assert.equal(canonicalMessageSpendActive(3), true);
    const ident = { businessId: 3, channel: 'telegram', account: 'bot-3', eventId: '1001' };
    const key = inboundMessageSpendKey(ident);
    assert.equal(key, inboundMessageSpendKey({ ...ident }), 'deterministic (duplicates and recovery reuse it)');
    assert.notEqual(key, inboundMessageSpendKey({ ...ident, eventId: '1002' })); assert.notEqual(key, inboundMessageSpendKey({ ...ident, businessId: 4 }));
    // 1) routing (Sol understanding) under the canonical key
    const routingAuthority = { id: 'own', approvalReference: 'appr', providerProjectId: 'proj_live', maximumRequestNanoUsd: ROUTING_MONEY.routingAllowanceNanoUsd,
      maximumTurnNanoUsd: operatorTurn, async transition(c: string, p: any) { return c === 'reserve' ? db.reserve(p.quote) : c === 'settle' ? (db.settle(p.quote, p.usage), { settled: true }) : (db.unknown(p.quote), null); } };
    const classifier = createAccountedRoutingClassifier({ authority: () => routingAuthority, transport: async () => ({ status: 200, json: { id: 'resp_r', status: 'completed',
      usage: { input_tokens: 1500, output_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] } }) });
    await classifier.classify({ message: 'Finns det parkering?', history: [], booking: null, conversationLanguage: null, pendingClarification: null },
      { businessId: 3, requestKey: key, turnId: 'routing:t' }, new AbortController().signal);
    // 2) Reference Engine under the SAME key (task of the same inbound event)
    const task: any = { id: 'task-1', turnId: 'turn-1', eventId: '1001', acceptedAt: 0, expiresAt: 75_000, modelAttempts: 0,
      scope: { businessId: 3, channel: 'telegram', providerAccount: 'bot-3', conversationId: '00000000-0000-4000-8000-000000000001' }, input: { question: 'q', language: 'sv', history: [] } };
    const owner = { id: 'own', approvalReference: 'appr', providerProjectId: 'proj_live', businessIds: [3], maximumRequestNanoUsd: 300_000_000, maximumTurnNanoUsd: operatorTurn,
      reserve: async (q: any) => { const r: any = db.reserve(q); return r && !r.denied ? r : null; }, settle: async (_id: string, q: any, u: any) => db.settle(q, u), retainUnknown: async (q: any) => db.unknown(q) };
    const reference = moneyBoundProvider({ task, owner: owner as any, reserveModelAttempt: async () => undefined, deadlineAt: 60_000, now: () => 0,
      transport: async () => ({ status: 200, json: { id: 'resp_a', status: 'completed', output: [], usage: { input_tokens: 900, output_tokens: 300,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 900 }, output_tokens_details: { reasoning_tokens: 0 } } } }) });
    const req = (role: 'answer' | 'verifier') => ({ role, instructions: 'i', input: 'x'.repeat(200), schemaName: `reference_${role}`, schema: {}, maxOutputTokens: 2048, signal: new AbortController().signal });
    await reference(req('answer') as any).catch(e => db.log.push(`refused_answer:${(e as Error).message}`));
    // The routing reservation and the Reference answer reservation live in ONE bucket, which never exceeds the PLAN ceiling.
    assert.ok([...db.rows.values()].every(r => r.key === key), 'single canonical bucket');
    assert.ok(db.bucket(key) <= planTurn, `bucket ${db.bucket(key)} ≤ plan ${planTurn}`);
    // A Reference answer whose worst case would exceed the remaining plan headroom is denied BEFORE dispatch by the database rule
    // (the large 8,192-token Sol envelope does not fit the 0.12 USD plan ceiling next to the routing spend).
    assert.ok(db.log.some(l => l.startsWith('denied:extraction') || l === 'reserved:extraction'));
    // 3) exclusivity: a legacy engine for the same message cannot reserve the same stage again (refused, no dispatch)
    const legacyStage = db.reserve({ requestKey: key, reservationKey: 'legacy-' + key, stage: [...db.rows.values()].some(r => r.stage === 'extraction') ? 'extraction' : 'routing',
      maximumNanoUsd: 1, maximumTurnNanoUsd: operatorTurn });
    assert.equal(legacyStage, null, 'second reservation of a stage for the message is refused');
    // 4) duplicate / recovery of the same event: same key, same stage → refused; unknown exposure stays counted
    await classifier.classify({ message: 'Finns det parkering?', history: [], booking: null, conversationLanguage: null, pendingClarification: null },
      { businessId: 3, requestKey: key, turnId: 'routing:t' }, new AbortController().signal).catch(() => db.log.push('duplicate_routing_refused'));
    assert.ok(db.log.includes('refused:routing') && db.log.includes('duplicate_routing_refused'), 'duplicate routing never dispatches twice');
    assert.ok(db.bucket(key) <= planTurn);
  } finally { configureRoutingTurnAllowance(0); configureCanonicalMessageSpend(null); }
  assert.equal(canonicalMessageSpendActive(3), false, 'no attested money stage → baseline keys');
});
test('routing authority: per-request bound = routing cap; turn limit = owner (plan-aware ceiling enforced by the database on the shared bucket); knowledge ceilings untouched', () => {
  const owner = { id: 'own', approvalReference: 'appr', accounting: 'atomic-durable' as const, ratesVersion: KNOWLEDGE_SOL_RATES.version, providerProjectId: 'proj_live',
    businessIds: [3], maximumRequestNanoUsd: 300_000_000, maximumTurnNanoUsd: 900_000_000,
    reserve: async () => null, settle: async () => undefined, retainUnknown: async () => undefined, naturalTransition: async () => null };
  try {
    configureRoutingTurnAllowance(0); configureKnowledgeBudgetOwner(owner);
    assert.equal(knowledgeRoutingMoneyAuthority(3), undefined, 'routing not accounted: no routing authority');
    configureRoutingTurnAllowance(ROUTING_MONEY.routingAllowanceNanoUsd);
    assert.equal(installedKnowledgeBudgetOwner()!.maximumTurnNanoUsd, 900_000_000, 'no operator-based application carve-out');
    assert.equal(knowledgeReferenceMoneyAuthority(3)!.maximumTurnNanoUsd, 900_000_000);
    const r = knowledgeRoutingMoneyAuthority(3)!;
    assert.equal(r.maximumRequestNanoUsd, ROUTING_MONEY.routingAllowanceNanoUsd); assert.equal(r.maximumTurnNanoUsd, 900_000_000);
    assert.equal(knowledgeRoutingMoneyAuthority(4), undefined, 'tenant not covered');
  } finally { configureRoutingTurnAllowance(0); configureKnowledgeBudgetOwner(); }
  assert.equal(installedKnowledgeBudgetOwner(), undefined);
});
test('durable input: optional interpretation is bounded and allowlisted; absent stays absent', () => {
  const base = { question: 'Och var?', language: 'sv', history: [] };
  assert.equal('interpretation' in captureInput(base), false);
  assert.equal(captureInput({ ...base, interpretation: 'Var finns parkeringen?' }).interpretation, 'Var finns parkeringen?');
  assert.throws(() => captureInput({ ...base, interpretation: 'x'.repeat(601) }), /knowledge_invalid_text/);
  assert.throws(() => captureInput({ ...base, interpretation: '  ' }), /knowledge_invalid_text/);
  assert.equal(brainV2ProductionWiring({ ...KEY, ODINLINK_KNOWLEDGE_INTERPRETATION_CARRIAGE: 'true' }, deps([], []).d).interpretationCarriage, true);
  assert.equal(brainV2ProductionWiring({ ...KEY, ODINLINK_KNOWLEDGE_INTERPRETATION_CARRIAGE: '1' }, deps([], []).d).interpretationCarriage, false);
});

test('spend identity is stable across flag disablement, restart and durable recovery (no second bucket for an admitted message)', async () => {
  const { configureCanonicalMessageSpend, canonicalMessageSpendActive, inboundMessageSpendKey, knowledgeMessageRequestKey } = await import('./knowledge-model-policy');
  const { referenceMoneyKeys } = await import('../p2/reference-knowledge-executor');
  const ATTESTED = { ODINLINK_SEMANTIC_ROUTING_MONEY_STAGE: 'sol-routing-v1' };
  const message = { businessId: 3, channel: 'telegram', account: 'bot-3', eventId: '7001' };
  const K = inboundMessageSpendKey(message);
  const spend = { channel: message.channel, account: message.account, eventId: message.eventId };
  const durableTask: any = { id: 'task-77', eventId: message.eventId, scope: { businessId: 3, channel: 'telegram', providerAccount: 'bot-3', conversationId: '00000000-0000-4000-8000-000000000003' } };
  /** Every paid phase of the message under one boot configuration ("process"): routing key, foreground and durable legacy keys, Reference. */
  const boot = (env: Record<string, string>) => {
    const w = brainV2ProductionWiring({ ...KEY, ...env }, deps([], []).d);
    configureCanonicalMessageSpend(w.canonicalSpendTenant);
    return { status: w.status, foreground: knowledgeMessageRequestKey({ businessId: 3, spend, baselineKey: 'F' }),
      durable: knowledgeMessageRequestKey({ businessId: 3, spend, baselineKey: 'L' }),
      reference: referenceMoneyKeys(durableTask, 'extraction').requestKey, other: knowledgeMessageRequestKey({ businessId: 4, spend, baselineKey: 'B4' }) };
  };
  try {
    // Owner pilot: routing reserves under K (runtime requires it); every knowledge phase of the same message uses K.
    const pilot = boot({ ...ROUTING_ON, ...REFERENCE_ON, ...ATTESTED });
    assert.equal(pilot.status.routing, 'installed'); assert.equal(pilot.status.canonicalSpendTenant, 3);
    assert.deepEqual([pilot.foreground, pilot.durable, pilot.reference], [K, K, K]);
    assert.equal(pilot.other, 'B4', 'non-pilot tenants keep baseline keys');
    // Feature flags disabled (documented rollback: routing mode off, Reference off) + restart; the message is recovered by the worker.
    const disabled = boot({ ODINLINK_SEMANTIC_ROUTING_MODE: 'off', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3', ...ATTESTED });
    assert.equal(disabled.status.routing, 'off'); assert.equal(disabled.status.reference, 'off');
    assert.deepEqual([disabled.foreground, disabled.durable, disabled.reference], [K, K, K], 'same bucket after flags are disabled');
    // Plain restart / recovery with the same configuration: identical.
    assert.deepEqual(boot({ ...ROUTING_ON, ...REFERENCE_ON, ...ATTESTED }), pilot);
    // Re-enabling the flags: identical again.
    assert.deepEqual([boot({ ...ROUTING_ON, ...ATTESTED }).durable], [K]);
    // OFF deployment (no attested money stage): exact baseline keys, no canonical identity anywhere.
    const off = boot({});
    assert.equal(off.status.canonicalSpendTenant, null);
    assert.deepEqual([off.foreground, off.durable, off.other], ['F', 'L', 'B4']);
    assert.notEqual(off.reference, K);
    // A tenant list (not exactly one) never activates the canonical identity.
    assert.equal(boot({ ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3,4', ...ATTESTED }).status.canonicalSpendTenant, null);
    assert.equal(canonicalMessageSpendActive(3), false);
  } finally { configureCanonicalMessageSpend(null); }
});

test('Reference timing eligibility from the real worker deadline: 75 s pilot window admits after intake, routing and queue overhead; 40 s never does', async () => {
  const { knowledgeExecutionDeadline } = await import('../p2/knowledge-operation');
  const { REFERENCE_ADMISSION, referenceStageBudgetMs } = await import('../p2/reference-knowledge-executor');
  const { nativeAsyncControls, nativeExecutionMsFor } = await import('../p2/native-knowledge-runtime');
  const need = REFERENCE_ADMISSION.answerFloorMs + REFERENCE_ADMISSION.verifierFloorMs + 2 * REFERENCE_ADMISSION.marginMs;
  assert.equal(need, 27_000);
  let clock = 0;
  const w = brainV2ProductionWiring({ ...KEY, ...REFERENCE_ON }, { ...deps([], []).d, now: () => clock });
  const remainingAt = (windowMs: number, overheadMs: number) => { clock = overheadMs; return w.referenceBinding!.remainingMs({ acceptedAt: 0, expiresAt: windowMs } as any); };
  // Compute deadline = expiresAt − min(15 s, max(1.5 s, 37.5 % of the window)).
  assert.equal(knowledgeExecutionDeadline({ acceptedAt: 0, expiresAt: 40_000 }), 25_000);
  assert.equal(knowledgeExecutionDeadline({ acceptedAt: 0, expiresAt: 75_000 }), 60_000);
  // 40 s window: 25 s of compute even with zero overhead → below 27 s → Reference refuses; the existing engine answers.
  assert.ok(remainingAt(40_000, 0) < need);
  // 75 s pilot window. acceptedAt is set at intake BEFORE routing, so routing (timeout cap 8 s), the booking clause and the queue wait all
  // consume the window. Measured worst case before the worker starts Reference: 8 s routing cap + ~1 s turn processing.
  assert.equal(remainingAt(75_000, 9_000), 51_000);
  assert.ok(remainingAt(75_000, 9_000) >= need);
  assert.equal(remainingAt(75_000, 33_000), need, 'eligible with up to 33 s of total intake + routing + queue overhead');
  assert.ok(remainingAt(75_000, 33_001) < need);
  // With 51 s left both stages get their full 20 s caps (measured max: answer 7.6 s, verifier 10.2 s).
  assert.equal(referenceStageBudgetMs('answer', 51_000), 20_000);
  assert.equal(referenceStageBudgetMs('verifier', 51_000 - 7_600), 20_000);
  // Windows: the 75 s window applies only to the listed pilot tenant; every other tenant keeps the unchanged global window.
  const controls = nativeAsyncControls({ ODINLINK_ASYNC_KNOWLEDGE_EXECUTION_MS: '40000', ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_EXECUTION_MS: '75000',
    ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_TENANTS: '3' } as any);
  assert.equal(nativeExecutionMsFor(controls, 3), 75_000); assert.equal(nativeExecutionMsFor(controls, 4), 40_000);
  assert.throws(() => nativeAsyncControls({ ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_EXECUTION_MS: '90000' } as any), /knowledge_invalid_execution_limit/);
});
