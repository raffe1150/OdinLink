import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ROUTING_MODEL, ROUTING_MONEY, routingRequestBody, createAccountedRoutingClassifier, createRoutingResponsesTransport, routingCostNanoUsd, routingMaximumNanoUsd, routingReservationKey } from './money';
import { RoutingBudgetRefused } from './runtime';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const input = { message: 'Måste jag komma tidigt?', history: [], booking: null, conversationLanguage: null, pendingClarification: null };
// The accounting mechanics are exercised with the production Sol understanding body (the prepared Sol money stage prices exactly it).
const solBody = (i: any) => routingRequestBody(i);
const identity = { businessId: 3, requestKey: sha('k'), turnId: 'routing:t' };
const output = { primaryIntent: 'business_information', secondaryIntents: [], confidence: 0.9, requestsMutation: false, asksInformation: true,
  confirmation: 'none', continuesActiveBooking: false, language: 'sv', resolvedQuestion: 'Måste jag komma tidigt?', referencesResolved: false, languageSwitch: false, bookingRequest: { serviceMention: '', affirmative: false }, mixedParts: { informationSpan: '', bookingSpan: '', informationQuestion: '' },
  evidence: [{ quote: 'komma tidigt', intent: 'business_information' }] };
const okResponse = (usage: any = { input_tokens: 900, output_tokens: 70, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }) =>
  ({ status: 200, json: { id: 'resp_abc', status: 'completed', usage, output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }] } });

/** Emulates the prepared SQL contract: envelope, one reservation per key, receipt identity and exact cost. */
function authority(over: Partial<{ deny: boolean; reserveThrows: boolean; settleFails: boolean; requestCap: number }> = {}) {
  const log: string[] = []; const rows = new Map<string, any>();
  const a = { id: 'owner', approvalReference: 'appr', providerProjectId: 'proj_x', maximumRequestNanoUsd: over.requestCap ?? 300_000_000, maximumTurnNanoUsd: 900_000_000,
    async transition(command: string, payload: any) {
      const q = payload.quote; log.push(command);
      if (command === 'reserve') {
        if (over.reserveThrows) throw new Error('network');
        assert.equal(q.stage, 'routing'); assert.equal(q.model, 'gpt-6.1-sol'); assert.equal(q.ratesVersion, 'openai-sol-standard-30m-2026-10-28');
        for (const k of ['requestKey', 'requestSha256', 'reservationKey']) assert.match(q[k], /^[a-f0-9]{64}$/);
        assert.equal(q.outputTokenLimit, 2048); assert.equal(q.maximumNanoUsd, q.inputTokenProxy * 2500 + 2048 * 10000);
        assert.ok(q.maximumNanoUsd <= ROUTING_MONEY.routingAllowanceNanoUsd, 'routing allowance (SQL row denies above it)');
        assert.equal(q.reservationKey, routingReservationKey(q.businessId, q.requestKey)); assert.equal(q.providerProjectId, 'proj_x');
        if (over.deny) return { denied: 'budget_exhausted' };
        if (rows.has(q.reservationKey)) return null; // never re-issue a dispatch permit
        rows.set(q.reservationKey, { id: 'r1', state: 'held', quote: q }); return { id: 'r1', reservationKey: q.reservationKey, maximumNanoUsd: q.maximumNanoUsd };
      }
      const r = rows.get(q.reservationKey);
      if (command === 'unknown') { if (r && r.state !== 'settled') r.state = 'unknown'; return null; }
      if (over.settleFails) throw new Error('db');
      const u = payload.usage;
      assert.equal(u.providerProjectId, q.providerProjectId); assert.match(u.providerResponseId, /^resp_/); assert.equal(u.requestSha256, q.requestSha256);
      const cost = (u.inputTokens - u.cachedTokens - u.cacheWriteTokens) * 2000 + u.cachedTokens * 100 + u.cacheWriteTokens * 2500 + u.outputTokens * 10000;
      assert.equal(u.estimatedNanoUsd, cost); assert.ok(cost <= q.maximumNanoUsd);
      r.state = 'settled'; r.cost = cost; return { settled: true };
    } };
  return { a, log, rows };
}

test('success: reserve → one dispatch → exact settlement; body is store:false, strict schema, 2048 output tokens', async () => {
  const m = authority(); const bodies: any[] = [];
  const c = createAccountedRoutingClassifier({ body: solBody, authority: () => m.a, transport: async b => { bodies.push(b); return okResponse(); } });
  const r = await c.classify(input, identity, new AbortController().signal);
  assert.deepEqual(r.output, output); assert.deepEqual(m.log, ['reserve', 'settle']); assert.equal(bodies.length, 1);
  assert.equal(bodies[0].store, false); assert.equal(bodies[0].max_output_tokens, 2048); assert.equal(bodies[0].text.format.strict, true);
  assert.equal(bodies[0].text.format.name, 'odinlink_semantic_routing_v2');
  assert.equal([...m.rows.values()][0].cost, 900 * 2000 + 70 * 10000);
});
test('duplicate dispatch prevented: the same request identity cannot reserve twice', async () => {
  const m = authority(); let sends = 0;
  const c = createAccountedRoutingClassifier({ body: solBody, authority: () => m.a, transport: async () => { sends++; return okResponse(); } });
  await c.classify(input, identity, new AbortController().signal);
  await assert.rejects(c.classify(input, identity, new AbortController().signal), RoutingBudgetRefused);
  assert.equal(sends, 1);
});
test('refusals dispatch nothing: denied, no owner, invalid key, owner request limit, uncertain reserve (retained as unknown)', async () => {
  for (const [name, auth, id] of [['denied', authority({ deny: true }), identity], ['cap', authority({ requestCap: 1000 }), identity],
    ['bad key', authority(), { ...identity, requestKey: 'x' }], ['reserve throws', authority({ reserveThrows: true }), identity]] as const) {
    let sends = 0;
    const c = createAccountedRoutingClassifier({ body: solBody, authority: () => auth.a, transport: async () => { sends++; return okResponse(); } });
    await assert.rejects(c.classify(input, id as any, new AbortController().signal), RoutingBudgetRefused, name);
    assert.equal(sends, 0, name);
    if (name === 'reserve throws') assert.deepEqual(auth.log, ['reserve', 'unknown']);
  }
  let sends = 0;
  const none = createAccountedRoutingClassifier({ body: solBody, authority: () => undefined, transport: async () => { sends++; return okResponse(); } });
  await assert.rejects(none.classify(input, identity, new AbortController().signal), RoutingBudgetRefused); assert.equal(sends, 0);
});
test('uncertain outcomes retain exposure (unknown), never release: transport error, non-200, bad receipt, over-bound usage, settle failure', async () => {
  for (const [name, transport, over] of [
    ['transport throws', async () => { throw new Error('reset'); }, {}],
    ['http 500', async () => ({ status: 500, json: {} }), {}],
    ['missing usage', async () => ({ status: 200, json: { id: 'resp_x', status: 'completed' } }), {}],
    ['foreign id', async () => ({ ...okResponse(), json: { ...okResponse().json, id: 'chatcmpl_1' } }), {}],
    ['output above limit', async () => okResponse({ input_tokens: 10, output_tokens: 5000 }), {}],
    ['settle fails', async () => okResponse(), { settleFails: true }],
  ] as const) {
    const m = authority(over as any);
    const c = createAccountedRoutingClassifier({ body: solBody, authority: () => m.a, transport: transport as any });
    await assert.rejects(c.classify(input, identity, new AbortController().signal), name);
    assert.equal([...m.rows.values()][0].state, 'unknown', name);
    assert.ok(!m.log.includes('release'), name);
  }
});
test('provider project identity: header sent, mismatch rejected; zero SDK retries', async () => {
  const seen: any[] = [];
  const client = (echo: string) => () => ({ responses: { create: (_b: any, o: any) => { seen.push(o); return { withResponse: async () => ({ data: okResponse().json,
    response: { status: 200, headers: { get: (n: string) => (n === 'openai-project' ? echo : null) } } }) }; } } });
  const ok = createRoutingResponsesTransport({ projectId: 'proj_x', timeoutMs: 2500, client: client('proj_x') });
  assert.equal((await ok({}, new AbortController().signal, 'proj_x')).status, 200);
  assert.equal(seen[0].maxRetries, 0); assert.equal(seen[0].headers['OpenAI-Project'], 'proj_x');
  const bad = createRoutingResponsesTransport({ projectId: 'proj_x', timeoutMs: 2500, client: client('proj_other') });
  await assert.rejects(bad({}, new AbortController().signal, 'proj_x'), /routing_project_mismatch/);
  const before = seen.length;
  await assert.rejects(ok({}, new AbortController().signal, 'proj_other'), /routing_project_binding/);
  assert.equal(seen.length, before, 'a different reserving project never reaches the client');
});
test('conservative envelope: typical body far below the routing allowance; cost formula matches the SQL row; oversize refused before any hold', async () => {
  assert.ok(routingMaximumNanoUsd(8_000) < 50_000_000);
  assert.equal(routingCostNanoUsd({ inputTokens: 100, cachedTokens: 40, cacheWriteTokens: 10, outputTokens: 7 }), 50 * 2000 + 40 * 100 + 10 * 2500 + 7 * 10000);
  assert.equal(ROUTING_MONEY.outputTokenLimit, 2048); assert.equal(ROUTING_MONEY.routingAllowanceNanoUsd, 100_000_000);
  // A body whose worst case exceeds the allowance (pathological escaping) is refused before reserve: legacy path, nothing dispatched.
  const m = authority(); let sends = 0;
  const huge = { ...input, message: '"'.repeat(4000), history: Array.from({ length: 12 }, () => ({ role: 'customer', text: '"'.repeat(600) })) };
  const c = createAccountedRoutingClassifier({ authority: () => m.a, transport: async () => { sends++; return okResponse(); } });
  await assert.rejects(c.classify(huge as any, identity, new AbortController().signal), /routing_request_budget/);
  assert.deepEqual([m.log.length, sends], [0, 0]);
});

// ---- prepared Sol migration package (static validation; not applied anywhere)
const root = new URL('../../../../docs/designs/sol-understanding-ai-money-migration-package/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, root), 'utf8');
const SIG = 'create or replace function ai_money.transition_core_v2(p_account text,p_approval text,p_command text,p_payload jsonb,p_scope jsonb default null)\nreturns jsonb language plpgsql security definer set search_path=pg_catalog as $$';
const bodyOf = (sql: string) => { const a = sql.indexOf(SIG) + SIG.length; return sql.slice(a, sql.indexOf('$$;', a)); };
const md5 = (v: string) => createHash('md5').update(v).digest('hex');
test('Sol migration: guarded deployed Tier B body, additive diff (Sol routing row + routing allowance), rollback restores base, no limit/privilege edits', () => {
  const v = JSON.parse(read('manifest.json'));
  assert.equal(v.applied, false); assert.equal(v.automaticMigrationDiscovery, false); assert.equal(v.deployedContractVerified, true);
  assert.equal(v.expectedCurrentBodyMd5, 'cf7773b3a165f6118f91cede0f265b45', 'the body verified byte for byte against the production export');
  const fwd = read(v.payload), rb = read(v.rollback), base = bodyOf(readFileSync(new URL('../tierb-natural-ai-money-migration-package/tierb-natural-stages-v1.sql', root), 'utf8'));
  assert.equal(sha(fwd), v.payloadSha256); assert.equal(sha(rb), v.rollbackSha256); assert.equal(sha(read(v.preflight)), v.preflightSha256);
  assert.equal(md5(base), v.expectedCurrentBodyMd5); assert.ok(fwd.includes(`is distinct from '${v.expectedCurrentBodyMd5}'`));
  const next = bodyOf(fwd); assert.equal(md5(next), v.newBodyMd5); assert.ok(fwd.includes(`is distinct from '${v.newBodyMd5}'`));
  assert.equal(bodyOf(rb), base, 'rollback restores the exact deployed body');
  const removed = base.split('\n').filter(l => !next.split('\n').includes(l)), added = next.split('\n').filter(l => !base.split('\n').includes(l));
  assert.equal(removed.length, 0, 'purely additive');
  const code = added.filter(l => !l.trim().startsWith('--'));
  assert.equal(code.length, 3, code.join('\n'));
  assert.match(code[0], /q->>'model'='gpt-6\.1-sol' and q->>'stage'='routing' and q->>'ratesVersion'='openai-sol-standard-30m-2026-10-28'/);
  assert.equal(code[1].trim(), 'price_input:=2000;price_read:=100;price_write:=2500;price_output:=10000;output_limit:=2048;');
  assert.equal(code[2].trim(), `if q->>'stage'='routing' and maximum>${ROUTING_MONEY.routingAllowanceNanoUsd} then return jsonb_build_object('denied','budget_exhausted'); end if;`);
  assert.equal(v.routingAllowanceNanoUsd, ROUTING_MONEY.routingAllowanceNanoUsd); assert.equal(v.outputTokenLimit, ROUTING_MODEL.maxOutputTokens);
  assert.ok(!/emergency_nano_usd|monthly_nano_usd|request_nano_usd|turn_nano_usd|grant |revoke /.test(code.join('\n')), 'no limit or privilege edits');
  assert.match(fwd, /ai_money_sol_routing_privileges_changed/); assert.match(fwd, /ai_money_sol_routing_missing_stage_uniqueness/); assert.match(fwd, /ai_money_sol_routing_rows_already_present/);
  assert.match(rb, /stage='routing' and state='held'/);
  // The restored body raises ai_money_unapproved_model_stage for every routing command (no routing rate row), so a held OR unknown
  // routing row would be stranded; the rollback refuses while any routing row is unsettled, and never deletes or updates rows.
  assert.ok(!base.includes("q->>'stage'='routing'"), 'restored body cannot price routing');
  assert.match(base, /else raise exception 'ai_money_unapproved_model_stage'; end if;/);
  assert.match(rb, /if exists\(select 1 from ai_money\.reservations where stage='routing' and state<>'settled'\) then raise exception 'ai_money_sol_routing_rollback_unsettled_rows'; end if;/);
  assert.ok(!/\b(insert into|update ai_money\.reservations set|delete from)\b/i.test(rb.slice(0, rb.indexOf(SIG))), 'rollback guard never changes rows');
  assert.match(read(v.preflight), /'routingRowsByState'/);
  assert.ok(!next.includes('turn ceiling - allowance'), 'no stale carve-out comment');
  assert.ok(next.includes("trial_case.kind='knowledge' and q->>'stage' not in ('language','query_embedding','extraction','re_extraction','verification')"), 'trials never admit routing');
  assert.ok(!/insert |update |delete /i.test(read(v.preflight)), 'preflight is read-only');
  const luna = JSON.parse(readFileSync(new URL('../semantic-routing-ai-money-migration-package/manifest.json', root), 'utf8'));
  assert.equal(luna.superseded, true); assert.equal(luna.applied, false);
});

test('Sol understanding body: explicit low reasoning, 2048 output tokens, strict v2 schema; priced exactly by the prepared Sol stage', async () => {
  const b: any = routingRequestBody(input);
  assert.equal(b.model, 'gpt-6.1-sol'); assert.deepEqual(b.reasoning, { effort: 'low' }); assert.equal(b.max_output_tokens, 2048);
  assert.equal(b.store, false); assert.equal(b.text.format.strict, true); assert.equal(ROUTING_MODEL.model, ROUTING_MONEY.model);
  // A body for any other model is still refused before any hold.
  const m = authority(); let sends = 0;
  const c = createAccountedRoutingClassifier({ body: i => ({ ...routingRequestBody(i), model: 'gpt-5.6-luna' }), authority: () => m.a, transport: async () => { sends++; return okResponse(); } });
  await assert.rejects(c.classify(input, identity, new AbortController().signal), /routing_money_stage_not_prepared_for_model/);
  assert.deepEqual([m.log.length, sends], [0, 0]);
});
