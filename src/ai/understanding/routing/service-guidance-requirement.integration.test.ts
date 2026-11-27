/** AI Brain V2 product requirement (owner decision 2026-11-27, channel parity line 902):
 * a customer who wants to book but does not know which service fits is helped to choose, while the booking goal is retained as
 * awaiting_service, and the next short reply (the chosen service) continues the booking.
 * - OFF: the exact dca2223 baseline (expected values recorded from the independent baseline tree with the same harness).
 * - Authorized OWNER/V2: requirement holds on all four channels for each plausible Sol reading of the message (booking, information,
 *   clarification). SCRIPTED classifier: mechanics only. No mutation in any case. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentConfig, incidentInbound, incidentSession, interceptedIncidentSend } from '../../../../tests/helpers/p0-incident-knowledge';
Object.assign(process.env, { NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', AI_PROVIDER: 'gemini', ODINLINK_EVIDENCE_FIRST_KNOWLEDGE: 'true',
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77', ODINLINK_ASYNC_KNOWLEDGE_ADMISSION: 'false',
  ODINLINK_ASYNC_KNOWLEDGE_PROCESSING: 'false', ODINLINK_ASYNC_KNOWLEDGE_DELIVERY: 'false', ODINLINK_SMART_WAITING: 'false' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../../../server');
const { SemanticRoutingRuntime, readSemanticRoutingConfig } = await import('./runtime');

const R = '46700000001';
const CHANNELS = ['telegram', 'whatsapp', 'instagram', 'messenger'] as const;
type Channel = typeof CHANNELS[number];
const GOAL = 'Jag behöver boka en tid, men jag vet inte vilken tjänst som passar.';
const SHORT = 'Konsultation';
const SERVICES = [
  { id: 'video', name: 'Video Consultation', durationMinutes: 60 },
  { id: 'k', name: 'Konsultation', durationMinutes: 30 },
  { id: 'inactive', name: 'Pausad tjänst', durationMinutes: 45, active: false },
];
type Reading = 'booking' | 'information' | 'clarification';
const proposal = (m: string, reading: Reading | 'continuation') => {
  const intent = reading === 'booking' ? 'new_booking' : reading === 'information' ? 'business_information' : reading === 'clarification' ? 'new_booking' : 'booking_continuation';
  return { primaryIntent: intent, secondaryIntents: reading === 'clarification' ? ['business_information'] : [], confidence: 0.92,
    requestsMutation: intent === 'new_booking', asksInformation: reading !== 'continuation' && reading !== 'booking', confirmation: 'none',
    continuesActiveBooking: reading === 'continuation', language: 'sv', resolvedQuestion: m, referencesResolved: false, languageSwitch: false,
    bookingRequest: { serviceMention: reading === 'continuation' ? SHORT : '', affirmative: intent === 'new_booking' },
    mixedParts: { informationSpan: '', bookingSpan: '', informationQuestion: '' }, evidence: [{ quote: m, intent }] };
};
async function play(t: any, channel: Channel, reading: Reading | null) {
  b.reset(); const perTurn: string[][] = []; let actions = 0, turn = 0, classifications = 0;
  t.mock.method(globalThis, 'fetch', async (i: any, o: any) => { perTurn.at(-1)!.push(String(interceptedIncidentSend(i, o)));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'm', messages: [{ id: 'wamid.x' }] }), { status: 200 }); });
  const original = { ...incidentConfig }; Object.assign(incidentConfig, { language: 'sv', services: SERVICES, defaultBookingService: undefined });
  const forbidden = async () => { actions++; throw Error('no mutation'); };
  const rt = reading === null ? null : new SemanticRoutingRuntime({ config: readSemanticRoutingConfig({ ODINLINK_SEMANTIC_ROUTING_MODE: 'owner',
    ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '77', ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: `77:${channel}:${R}` }),
    classifier: { classify: async (input: any) => { classifications++; return { output: proposal(input.message, turn === 1 ? reading : 'continuation') }; } } });
  b.configure({ semanticRoutingRuntime: rt as any, semanticLanguageResolver: async () => ({ language: 'sv', confidence: 1 }), postProcess: async () => {},
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }), knowledgeSearch: async () => [], semanticKnowledgeSearch: async () => [],
    geminiGenerate: async () => ({ text: 'GENERATED' }),
    calendarAdapter: { getCalendarId: () => 's', getEvents: async () => [], checkSlots: async () => [], insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
    recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden } as any);
  const session = incidentSession(b, channel, R); const states: any[] = [];
  try {
    for (const text of [GOAL, SHORT]) { turn++; perTurn.push([]); await incidentInbound(b, channel, text, R); states.push(b.pendingStateSnapshot(session)); }
    return { perTurn, states, actions, classifications };
  } finally { Object.assign(incidentConfig, original); b.reset(); }
}

/** Recorded from dca2223 (independent baseline tree, identical harness and fixtures). */
const UNVERIFIED = 'Jag kan inte verifiera ett svar om de efterfrågade uppgifterna just nu. Verksamheten kan bekräfta vad som gäller.';
const CHOSEN = 'Jag har valt Konsultation. Vilka datum finns i åtanke för bokningen?';
const BASELINE: Record<Channel, { sends: [string[], string[]]; second: { status: string | null; service: string | null } }> = {
  telegram: { sends: [[UNVERIFIED], [CHOSEN]], second: { status: 'awaiting_date_or_time', service: 'Konsultation' } },
  whatsapp: { sends: [[UNVERIFIED], ['Menar du en ny bokning, ombokning, avbokning eller att kontrollera en tidigare bokning?']], second: { status: null, service: null } },
  instagram: { sends: [[UNVERIFIED], [CHOSEN]], second: { status: 'awaiting_date_or_time', service: 'Konsultation' } },
  messenger: { sends: [[UNVERIFIED], [CHOSEN]], second: { status: 'awaiting_date_or_time', service: 'Konsultation' } },
};

for (const channel of CHANNELS) test(`service guidance OFF ${channel}: exact dca2223 baseline (no awaiting_service is created; next short reply as baseline)`, async (t) => {
  const off = await play(t, channel, null);
  assert.equal(off.classifications, 0);
  assert.deepEqual(off.perTurn, BASELINE[channel].sends);
  assert.equal(off.states[0], null, 'baseline: the information branch answers and creates no booking state');
  assert.equal(off.states[1]?.status ?? null, BASELINE[channel].second.status);
  assert.equal(off.states[1]?.service ?? null, BASELINE[channel].second.service);
  assert.equal(off.actions, 0);
});

for (const reading of ['booking', 'information', 'clarification'] as const) for (const channel of CHANNELS)
  test(`service guidance OWNER ${channel} (${reading} reading): booking goal retained as awaiting_service; the next short reply continues it`, async (t) => {
    const owner = await play(t, channel, reading);
    assert.equal(owner.classifications, 2);
    const [first, second] = owner.states;
    assert.equal(first?.status, 'awaiting_service', 'booking goal retained');
    assert.equal(first?.operation, 'new_booking');
    assert.equal(first?.dateTime ?? null, null);
    assert.deepEqual(first?.ownedOfferedSlots ?? [], []);
    assert.ok(!first?.continuationPaused, 'the goal this turn retained is not paused by it');
    assert.equal(owner.perTurn[0].length, 1, 'the customer is helped in the same turn (one acknowledged message)');
    assert.doesNotMatch(owner.perTurn[0][0], /fortsätt min bokning/iu);
    if (reading === 'booking') {
      assert.match(owner.perTurn[0][0], /Video Consultation — 60 minuter/u);
      assert.match(owner.perTurn[0][0], /Konsultation — 30 minuter/u);
      assert.doesNotMatch(owner.perTurn[0][0], /Pausad tjänst/u);
    }
    assert.equal(second?.status, 'awaiting_date_or_time', 'the short reply selected the service and the booking continued');
    assert.equal(second?.operation, 'new_booking');
    assert.equal(second?.service, 'Konsultation');
    assert.deepEqual(owner.perTurn[1], [CHOSEN]);
    assert.equal(owner.actions, 0, 'no calendar or database mutation');
  });
