import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { incidentChannels, incidentConfig, incidentInbound, incidentSession, interceptedIncidentSend,
  type IncidentChannel } from '../../../../tests/helpers/p0-incident-knowledge';
import { CURRENT_BOOKING_STATE_VERSION } from '../../booking-operation-state';

Object.assign(process.env, {
  NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-offline',
  ODINLINK_EVIDENCE_FIRST_KNOWLEDGE: 'true', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1',
  ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77', ODINLINK_ASYNC_KNOWLEDGE_ADMISSION: 'false',
});
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../../../server');
const recipient = '46700000001';
const information = 'Ja, det passar bra. Men jag vill gärna veta lite mer om vad den här konsultationen innebär innan jag bokar.';
const followUp = 'Tack! Kan du berätta lite mer om hur själva konsultationen går till?';
const overview = 'Konsultationen hjälper oss att förstå dina mål.';
const details = 'Under konsultationen går vi igenom målgrupp, budskap och annonsformat.';
const authorization = 'Ja tack, boka den.';
const start = '2026-12-02T09:00:00.000Z';
const end = '2026-12-02T10:00:00.000Z';

async function play(t: TestContext, channel: IncidentChannel, owner: boolean) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-27T10:00:00Z') });
  b.reset();
  const replies: string[][] = [];
  const states: Array<{ status: string | null; dateTime: string | null }> = [];
  const lanes: string[] = [];
  const verifiedTurns: number[] = [];
  let mutations = 0;
  const forbidden = async () => { mutations++; throw Error('Unexpected mutation'); };
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    replies.at(-1)!.push(interceptedIncidentSend(url, options));
    return new Response(JSON.stringify({
      ok: true, result: { message_id: 1, chat: { id: recipient } },
      message_id: 'm', recipient_id: recipient, messages: [{ id: 'wamid.x' }],
    }));
  });
  let routing = null;
  if (owner) {
    const { SemanticRoutingRuntime, readSemanticRoutingConfig } = await import('./runtime');
    routing = new SemanticRoutingRuntime({
      config: readSemanticRoutingConfig({
        ODINLINK_SEMANTIC_ROUTING_MODE: 'owner', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '77',
        ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: `77:${channel}:${recipient}`,
      }),
      observe: observation => lanes.push(observation.lane),
      classifier: { classify: async ({ message }) => {
        const confirm = message === authorization;
        const intent = confirm ? 'confirmation' : 'knowledge_interruption';
        return { output: {
          primaryIntent: intent, secondaryIntents: [], confidence: 1,
          requestsMutation: confirm, asksInformation: !confirm, confirmation: confirm ? 'affirmed' : 'none',
          continuesActiveBooking: confirm, language: 'sv', resolvedQuestion: message, referencesResolved: false, languageSwitch: false,
          bookingRequest: { serviceMention: '', affirmative: confirm },
          mixedParts: { informationSpan: '', bookingSpan: '', informationQuestion: '' },
          evidence: [{ quote: message, intent }],
        } };
      } },
    });
  }
  b.configure({
    ...(routing ? { semanticRoutingRuntime: routing } : {}),
    semanticLanguageResolver: async () => ({ language: 'sv', confidence: 1 }),
    postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    knowledgeSearch: async () => [{
      sourceId: 'synthetic-consultation', businessId: 77, text: `${overview} ${details}`, score: 1,
      metadata: { source: 'document', documentRevision: 'synthetic-v1' },
    }],
    semanticKnowledgeSearch: async () => [],
    validateKnowledgeMatches: async (_id: number, matches: unknown[]) => matches,
    geminiGenerate: async (request: any) => {
      const instruction = request.config.systemInstruction;
      const consultation = replies.length === 1 ? overview : details;
      if (instruction.includes('retrieval query planner')) return { text: JSON.stringify({
        canonicalMeaning: 'Vad ingår i konsultationen?', queries: ['Vad ingår i konsultationen?'],
        requestKind: 'BUSINESS_INFORMATION', referenceResolution: 'RESOLVED',
        requestedFacets: [{ subject: 'konsultation', attribute: 'innehåll', questionType: 'description' }],
      }) };
      if (instruction.includes('EVIDENCE-FIRST UNIT EXTRACTION')) {
        const payload = JSON.parse(request.contents[0].parts[0].text);
        const evidence = payload.evidence.find((entry: { text: string }) => entry.text.includes(consultation));
        assert.ok(evidence, 'the consultation fact is present in tenant evidence');
        return { text: JSON.stringify({ units: [{
          facetIds: ['f1'], subject: 'konsultation', predicate: 'omfattar', value: consultation,
          modality: 'descriptive', negation: false, scope: 'this business', qualifiers: [], language: 'sv', text: consultation,
          evidenceRefs: [{ evidenceId: evidence.id, exactQuote: consultation }],
        }] }) };
      }
      if (instruction.includes('EVIDENCE-FIRST BATCH ENTAILMENT')) {
        verifiedTurns.push(replies.length);
        const payload = JSON.parse(request.contents[0].parts[0].text);
        return { text: JSON.stringify({
          decisions: payload.units.map((unit: any) => ({
            unitId: unit.id, relation: 'ENTAILED', facetIds: unit.facetIds,
            meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true,
            languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false,
          })),
          coverage: payload.facets.map((facet: any) => ({
            facetId: facet.id, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE',
            materialUnitIds: payload.units.map((unit: any) => unit.id),
            obligations: facet.obligations.map((obligation: any) => ({
              obligationId: obligation.id, status: 'COVERED', unitIds: payload.units.map((unit: any) => unit.id),
            })),
          })),
        }) };
      }
      return { text: consultation };
    },
    calendarAdapter: {
      getCalendarId: () => 'cal-77', getEvents: async () => [], checkSlots: async () => [],
      insertAppointment: forbidden, updateAppointment: forbidden, cancelAppointment: forbidden,
    },
    recordAppointment: forbidden, updateAppointmentRow: forbidden, cancelAppointmentRow: forbidden,
  } as any);
  const session = incidentSession(b, channel, recipient);
  const pendingOwner = channel === 'telegram' ? recipient
    : channel === 'whatsapp' ? session.replace(/\D/g, '') : session.slice(3);
  b.seedPending(session, {
    businessConfig: incidentConfig, businessId: '77', platform: channel, userId: pendingOwner,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, operation: 'new_booking', status: 'awaiting_confirmation',
    service: 'Video Consultation', serviceId: 'video', language: 'sv', selectedDate: '2026-12-02',
    dateTime: start, selectedSlotEnd: end, durationMinutes: 60,
    offeredSlots: [`Onsdag kl 10:00 (ISO: ${start})`],
    ownedOfferedSlots: [{ start, end, durationMinutes: 60, service: 'Video Consultation',
      businessId: '77', platform: channel, userId: recipient, generatedAt: Date.now(),
      searchStartDate: '2026-12-02', searchEndDate: '2026-12-02' }],
  });
  try {
    for (const message of [information, followUp, authorization]) {
      replies.push([]);
      await incidentInbound(b, channel, message, recipient);
      const pending = b.pendingStateSnapshot(session);
      states.push({ status: pending?.status ?? null, dateTime: pending?.dateTime ?? null });
      t.mock.timers.tick(1000);
    }
    return { replies, states, lanes, mutations, verifiedTurns };
  } finally {
    b.reset();
  }
}

// Exact replies and states observed with this fixture on the independent dca2223 tree.
const stateAfterTurn = [
  { status: 'awaiting_confirmation', dateTime: start },
  { status: 'awaiting_confirmation', dateTime: start },
  { status: 'awaiting_contact', dateTime: start },
];

for (const channel of incidentChannels) {
  test(`pending confirmation OFF ${channel} follows dca2223 across all three turns`, async t => {
    const result = await play(t, channel, false);
    const contact = channel === 'whatsapp'
      ? 'Självklart. Jag behöver bara ditt namn för att slutföra bokningen.'
      : 'Självklart. Jag behöver bara ditt namn och mobilnummer för att slutföra bokningen.';
    assert.deepEqual(result.replies, [
      ['Vad syftar du på, och vilken plats menar du?'], [details], [contact],
    ]);
    assert.deepEqual(result.states, stateAfterTurn);
    assert.deepEqual(result.lanes, []);
    assert.equal(result.mutations, 0);
  });
  test(`pending confirmation OWNER ${channel} answers, preserves selection and waits for full authorization`, async t => {
    const result = await play(t, channel, true);
    assert.deepEqual(result.lanes, ['knowledge', 'knowledge', 'booking']);
    assert.deepEqual(result.verifiedTurns, [1, 2]);
    assert.deepEqual(result.replies.slice(0, 2), [[overview], [details]]);
    assert.equal(result.replies[2].length, 1);
    assert.match(result.replies[2][0], /namn|telefonnummer|mobilnummer/iu);
    assert.deepEqual(result.states, stateAfterTurn);
    assert.equal(result.mutations, 0);
  });
}
