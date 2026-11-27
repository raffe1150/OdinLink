/** Native-channel timing: the semantic decision is made ONCE, before the accuracy-first timing decision, and reused by the turn.
 * SCRIPTED classifier: integration mechanics only, no model accuracy. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { incidentConfig, incidentChannels, incidentInbound, interceptedIncidentSend } from '../../../../tests/helpers/p0-incident-knowledge';
Object.assign(process.env, { NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', AI_PROVIDER: 'gemini',
  ODINLINK_EVIDENCE_FIRST_KNOWLEDGE: 'true', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77',
  ODINLINK_ASYNC_KNOWLEDGE_ADMISSION: 'false', ODINLINK_ASYNC_KNOWLEDGE_PROCESSING: 'false', ODINLINK_ASYNC_KNOWLEDGE_DELIVERY: 'false', ODINLINK_SMART_WAITING: 'false' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../../../server');
const { SemanticRoutingRuntime, readSemanticRoutingConfig } = await import('./runtime');

const RECIPIENT = '46700000001';
const KNOWLEDGE = 'Is it mandatory to be there 10 minutes before my appointment?'; // en-03: legacy NOT admitted
const BOOKING = 'Kan jag boka en tid på tisdag klockan 14?';                      // sv-09: legacy admitted to knowledge
const span = (m: string, intent: string) => [{ quote: [...m].slice(0, 120).join(''), intent }];
const proposal = (m: string) => m === BOOKING
  ? { primaryIntent: 'new_booking', secondaryIntents: [], confidence: 0.95, requestsMutation: true, asksInformation: false, confirmation: 'none', continuesActiveBooking: false, language: 'sv', resolvedQuestion: 'q', referencesResolved: false, languageSwitch: false, bookingRequest: { serviceMention: '', affirmative: false }, mixedParts: { informationSpan: '', bookingSpan: '', informationQuestion: '' }, evidence: span(m, 'new_booking') }
  : { primaryIntent: 'business_information', secondaryIntents: [], confidence: 0.95, requestsMutation: false, asksInformation: true, confirmation: 'none', continuesActiveBooking: false, language: 'en', resolvedQuestion: 'q', referencesResolved: false, languageSwitch: false, bookingRequest: { serviceMention: '', affirmative: false }, mixedParts: { informationSpan: '', bookingSpan: '', informationQuestion: '' }, evidence: span(m, 'business_information') };

async function run(t: any, channel: typeof incidentChannels[number], text: string, mode: 'off' | 'shadow' | 'owner', fail?: 'throw' | 'hang' | null, allow = RECIPIENT) {
  b.reset();
  const policies: unknown[] = [], lanes: string[] = [], latencies: number[] = []; let classify = 0, actions = 0, sends = 0;
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, (label: unknown, data: unknown) => { if (label === '[KnowledgeTimingPolicy]') policies.push(data); });
  t.mock.method(globalThis, 'fetch', async (input: any, options: any) => { interceptedIncidentSend(input, options); sends++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'm' }), { status: 200 }); });
  const rt = mode === 'off' ? null : new SemanticRoutingRuntime({
    config: readSemanticRoutingConfig({ ODINLINK_SEMANTIC_ROUTING_MODE: mode, ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '77',
      ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: `77:${channel}:${allow}`, ODINLINK_SEMANTIC_ROUTING_TIMEOUT_MS: '60' }),
    classifier: { classify: async (input: any, _id: any, signal: AbortSignal) => { classify++;
      if (fail === 'throw') throw new Error('provider_down');
      if (fail === 'hang') await new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
      return { output: proposal(input.message) }; } },
    observe: o => { lanes.push(o.lane); latencies.push(o.latencyMs); } });
  const forbidden = async () => { actions++; throw Error('No booking mutation without confirmation'); };
  b.configure({ semanticRoutingRuntime: rt as any, semanticLanguageResolver: async () => ({ language: 'en', confidence: 1 }),
    postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }), knowledgeSearch: async () => [], semanticKnowledgeSearch: async () => [],
    geminiGenerate: async () => ({ text: 'Please provide the booking details.' }),
    calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: async () => [], checkSlots: async () => [], insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
    recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden } as any);
  const started = performance.now();
  try { await incidentInbound(b, channel, text, RECIPIENT); } finally { b.reset(); }
  return { scoped: policies.length > 0, classify, lanes, latencies, actions, sends, ms: performance.now() - started };
}

const timing: Record<string, number[]> = { off: [], owner: [], routeOverheadMs: [] };
for (const channel of incidentChannels) {
  test(`${channel}: OFF keeps legacy timing; no classification`, async t => {
    const k = await run(t, channel, KNOWLEDGE, 'off'), bk = await run(t, channel, BOOKING, 'off');
    assert.deepEqual([k.scoped, k.classify, bk.scoped, bk.classify], [false, 0, true, 0]);
    assert.equal(k.actions + bk.actions, 0); timing.off.push(k.ms);
  });
  test(`${channel}: OWNER classifies once before timing; knowledge enters accuracy-first; booking keeps foreground responsiveness`, async t => {
    const k = await run(t, channel, KNOWLEDGE, 'owner');
    assert.equal(k.classify, 1, 'classified exactly once per message'); assert.deepEqual(k.lanes, ['knowledge']); assert.equal(k.scoped, true);
    const bk = await run(t, channel, BOOKING, 'owner');
    assert.equal(bk.classify, 1); assert.deepEqual(bk.lanes, ['booking']); assert.equal(bk.scoped, false, 'booking request is not held in the knowledge timing lifecycle');
    assert.equal(k.actions + bk.actions, 0); assert.ok(k.sends <= 1 && bk.sends <= 1, 'at most one customer message per turn'); timing.owner.push(k.ms); timing.routeOverheadMs.push(...k.latencies, ...bk.latencies);
  });
  test(`${channel}: SHADOW classifies once and changes nothing; failures/timeouts keep legacy timing`, async t => {
    const s = await run(t, channel, BOOKING, 'shadow');
    assert.deepEqual([s.classify, s.scoped], [1, true]);
    for (const fail of ['throw', 'hang'] as const) {
      const f = await run(t, channel, KNOWLEDGE, 'owner', fail);
      assert.deepEqual([f.classify, f.scoped, f.actions], [1, false, 0], fail);
    }
  });
  test(`${channel}: OWNER outside the allowlisted conversation: no classification, legacy timing`, async t => {
    const k = await run(t, channel, KNOWLEDGE, 'owner', null, 'someone-else'), bk = await run(t, channel, BOOKING, 'owner', null, 'someone-else');
    assert.deepEqual([k.classify, k.scoped, bk.classify, bk.scoped], [0, false, 0, true]);
  });
}
test('latency (offline, scripted zero-delay classifier): report only', () => {
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  if (process.env.SEMANTIC_ROUTING_LATENCY) writeFileSync(process.env.SEMANTIC_ROUTING_LATENCY, JSON.stringify({ offMs: avg(timing.off), ownerMs: avg(timing.owner), routeOverheadMs: timing.routeOverheadMs }));
  assert.ok(timing.off.length === 4 && timing.owner.length === 4);
});
