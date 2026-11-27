/**
 * Semantic routing contract routing-v2 (Sol-first conversation understanding). A decoded value is a PROPOSAL only; it never
 * authorizes a mutation. The Booking Engine remains the sole mutation authority with its existing validations and confirmations.
 *
 * v2 vs v1 (genuine R1 evidence): character-offset evidence was replaced by short VERBATIM QUOTES validated by normalized inclusion
 * (11/13 R1 failures were correct decisions rejected only because model-counted offsets overshot the message). Imperfect evidence never
 * rejects an information decision; any booking-lane decision still requires a matching quote for its intent (strict for actions).
 */
export const ROUTING_UNDERSTANDING_VERSION = 'routing-v2' as const;

export const ROUTING_INTENTS = [
  'business_information', 'booking_policy_question', 'new_booking', 'availability',
  'booking_lookup', 'reschedule', 'cancellation', 'confirmation', 'booking_continuation',
  'knowledge_interruption', 'mixed', 'general_conversation', 'clarification',
] as const;
export type RoutingIntent = typeof ROUTING_INTENTS[number];

export const INFORMATION_INTENTS: ReadonlySet<RoutingIntent> = new Set(['business_information', 'booking_policy_question', 'knowledge_interruption']);
export const BOOKING_INTENTS: ReadonlySet<RoutingIntent> = new Set(['new_booking', 'availability', 'booking_lookup', 'reschedule', 'cancellation', 'confirmation', 'booking_continuation']);
export const MUTATION_INTENTS: ReadonlySet<RoutingIntent> = new Set(['new_booking', 'reschedule', 'cancellation', 'confirmation']);

export type RoutingEvidence = Readonly<{ quote: string; intent: RoutingIntent }>;
export type RoutingUnderstanding = Readonly<{
  version: typeof ROUTING_UNDERSTANDING_VERSION;
  primaryIntent: RoutingIntent;
  secondaryIntents: readonly RoutingIntent[];
  confidence: number;
  requestsMutation: boolean;
  asksInformation: boolean;
  confirmation: 'affirmed' | 'rejected' | 'none';
  continuesActiveBooking: boolean;
  language: string;
  /** Standalone restatement of the latest message in the customer's language, references resolved from history. An aid only: the
   * customer's original words always travel with it and prevail. */
  resolvedQuestion: string;
  referencesResolved: boolean;
  languageSwitch: boolean;
  /** Only quotes that were found verbatim (normalized) in the customer's latest message. */
  evidence: readonly RoutingEvidence[];
  droppedEvidence: number;
  /** Mixed requests only (null otherwise): the customer's OWN words for each part, verbatim spans of the latest message, plus a
   * standalone restatement of the information part alone. The booking span is never authorization: the Booking Engine decides. */
  mixedParts: null | Readonly<{ informationSpan: string; bookingSpan: string; informationQuestion: string }>;
  /** Structured booking intent (null when no booking intent is proposed). serviceMention: the customer's exact words naming the
   * requested service, verbatim from the latest message (the booking span for a mixed request), or null when no service is named.
   * Never authority: the Booking Engine still matches it against the configured catalog and owns availability and confirmation. */
  bookingRequest: null | Readonly<{ intent: RoutingIntent; serviceMention: string | null; affirmative: boolean }>;
}>;
/** Mixed split coverage: at most this many non-whitespace characters of the normalized message may lie outside both spans (connectives
 * such as "and" / "okay, thanks"). More means a qualifier or condition was left out of the parts: the split is not usable. */
export const MIXED_UNCOVERED_MAX_CHARS = 20;

export const ROUTING_WIRE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['primaryIntent', 'secondaryIntents', 'confidence', 'requestsMutation', 'asksInformation', 'confirmation', 'continuesActiveBooking',
    'language', 'resolvedQuestion', 'referencesResolved', 'languageSwitch', 'mixedParts', 'bookingRequest', 'evidence'],
  properties: {
    primaryIntent: { type: 'string', enum: [...ROUTING_INTENTS] },
    secondaryIntents: { type: 'array', maxItems: 3, items: { type: 'string', enum: [...ROUTING_INTENTS] } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    requestsMutation: { type: 'boolean' },
    asksInformation: { type: 'boolean' },
    confirmation: { type: 'string', enum: ['affirmed', 'rejected', 'none'] },
    continuesActiveBooking: { type: 'boolean' },
    language: { type: 'string' },
    resolvedQuestion: { type: 'string', maxLength: 600 },
    referencesResolved: { type: 'boolean' },
    languageSwitch: { type: 'boolean' },
    mixedParts: { type: 'object', additionalProperties: false, required: ['informationSpan', 'bookingSpan', 'informationQuestion'],
      properties: { informationSpan: { type: 'string', maxLength: 400 }, bookingSpan: { type: 'string', maxLength: 400 }, informationQuestion: { type: 'string', maxLength: 600 } } },
    bookingRequest: { type: 'object', additionalProperties: false, required: ['serviceMention', 'affirmative'],
      properties: { serviceMention: { type: 'string', maxLength: 200 }, affirmative: { type: 'boolean' } } },
    evidence: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['quote', 'intent'],
      properties: { quote: { type: 'string', maxLength: 200 }, intent: { type: 'string', enum: [...ROUTING_INTENTS] } } } },
  },
} as const;

export type RoutingDecodeFailure = 'not_object' | 'unexpected_field' | 'invalid_field' | 'invalid_evidence' | 'action_evidence_missing' | 'mixed_parts_invalid' | 'booking_request_invalid';
const KEYS = new Set(Object.keys(ROUTING_WIRE_SCHEMA.properties));
const isIntent = (v: unknown): v is RoutingIntent => typeof v === 'string' && (ROUTING_INTENTS as readonly string[]).includes(v);

/** Script-neutral normalization for quote inclusion: Unicode NFKC, case fold, Arabic/Persian tatweel and diacritics removed, all
 * punctuation/symbols and whitespace runs collapsed. No language-specific vocabulary. */
export function normalizeForQuote(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('und')
    .replace(/[\u0640\u064B-\u065F\u0670\u06D6-\u06ED\u200B-\u200F\u2060\uFEFF]/gu, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}
/** Inclusion test that is also insensitive to word spacing (Persian ZWNJ vs space vs none, e.g. «می‌شود» / «می شود» / «میشود»). */
export const quoteIncluded = (haystack: string, needle: string): boolean =>
  !!needle && haystack.replace(/ /gu, '').includes(needle.replace(/ /gu, ''));

/** Strict on structure; tolerant on evidence formatting for information; strict on evidence for every booking-lane intent. */
export function decodeRoutingUnderstanding(raw: unknown, message: string):
  { ok: true; value: RoutingUnderstanding } | { ok: false; reason: RoutingDecodeFailure } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_object' };
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some(k => !KEYS.has(k)) || Object.keys(o).length !== KEYS.size) return { ok: false, reason: 'unexpected_field' };
  const { primaryIntent, secondaryIntents, confidence, requestsMutation, asksInformation, confirmation, continuesActiveBooking, language,
    resolvedQuestion, referencesResolved, languageSwitch, mixedParts, bookingRequest, evidence } = o;
  if (!isIntent(primaryIntent) || !Array.isArray(secondaryIntents) || secondaryIntents.length > 3 || !secondaryIntents.every(isIntent) ||
    new Set(secondaryIntents).size !== secondaryIntents.length || secondaryIntents.includes(primaryIntent) ||
    typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
    typeof requestsMutation !== 'boolean' || typeof asksInformation !== 'boolean' || typeof continuesActiveBooking !== 'boolean' ||
    typeof referencesResolved !== 'boolean' || typeof languageSwitch !== 'boolean' ||
    !['affirmed', 'rejected', 'none'].includes(confirmation as string) ||
    typeof language !== 'string' || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language) ||
    typeof resolvedQuestion !== 'string' || resolvedQuestion.length > 600 || (asksInformation && !resolvedQuestion.trim()))
    return { ok: false, reason: 'invalid_field' };
  if (!Array.isArray(evidence) || evidence.length > 8) return { ok: false, reason: 'invalid_evidence' };
  const intents = new Set<RoutingIntent>([primaryIntent, ...secondaryIntents as RoutingIntent[]]);
  const haystack = normalizeForQuote(message);
  const kept: RoutingEvidence[] = []; let dropped = 0;
  for (const e of evidence) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, reason: 'invalid_evidence' };
    const { quote, intent, ...rest } = e as Record<string, unknown>;
    if (Object.keys(rest).length || typeof quote !== 'string' || quote.length > 200 || !isIntent(intent)) return { ok: false, reason: 'invalid_evidence' };
    const needle = normalizeForQuote(quote);
    // A quote that is not in the latest message, or is attributed to an intent not proposed, is dropped (never decisive).
    if (needle && intents.has(intent) && quoteIncluded(haystack, needle)) kept.push(Object.freeze({ quote, intent })); else dropped++;
  }
  // Actions stay strict: every proposed booking-lane intent must be grounded in the customer's own latest words.
  for (const intent of intents) if (BOOKING_INTENTS.has(intent) && !kept.some(k => k.intent === intent)) return { ok: false, reason: 'action_evidence_missing' };
  // Mixed parts: structure always validated; content required (and verbatim) only for a mixed decision, ignored otherwise.
  const mp = mixedParts as Record<string, unknown> | null;
  if (!mp || typeof mp !== 'object' || Array.isArray(mp) || Object.keys(mp).sort().join() !== 'bookingSpan,informationQuestion,informationSpan' ||
    typeof mp.informationSpan !== 'string' || typeof mp.bookingSpan !== 'string' || typeof mp.informationQuestion !== 'string' ||
    mp.informationSpan.length > 400 || mp.bookingSpan.length > 400 || mp.informationQuestion.length > 600) return { ok: false, reason: 'invalid_field' };
  let parts: RoutingUnderstanding['mixedParts'] = null;
  if (primaryIntent === 'mixed') {
    const info = normalizeForQuote(mp.informationSpan), book = normalizeForQuote(mp.bookingSpan);
    // Both parts must be the customer's own words (no paraphrased action, no invented question), distinct, and the information part
    // needs a standalone restatement. Otherwise the mixed decision is not usable: legacy behaviour (fail closed, no new route).
    if (!info || !book || info === book || !quoteIncluded(haystack, info) || !quoteIncluded(haystack, book) || !mp.informationQuestion.trim())
      return { ok: false, reason: 'mixed_parts_invalid' };
    // Each part must occur exactly once, the parts must not overlap, and together they must cover the message up to a few connective
    // characters: a dropped negation-bearing clause, condition or qualifier makes the split unusable (fail closed, legacy path).
    const flat = haystack.replace(/ /gu, ''), fi = info.replace(/ /gu, ''), fb = book.replace(/ /gu, '');
    const at = (needle: string) => { const i = flat.indexOf(needle); return i >= 0 && flat.indexOf(needle, i + 1) < 0 ? i : -1; };
    const ii = at(fi), ib = at(fb);
    if (ii < 0 || ib < 0 || (ii < ib + fb.length && ib < ii + fi.length)) return { ok: false, reason: 'mixed_parts_invalid' };
    if (flat.length - fi.length - fb.length > MIXED_UNCOVERED_MAX_CHARS) return { ok: false, reason: 'mixed_parts_invalid' };
    parts = Object.freeze({ informationSpan: mp.informationSpan.trim(), bookingSpan: mp.bookingSpan.trim(), informationQuestion: mp.informationQuestion.trim() });
  }
  // Structured booking intent: only for a booking-lane intent; a named service must be the customer's own words in the booking text.
  const br = bookingRequest as Record<string, unknown> | null;
  if (!br || typeof br !== 'object' || Array.isArray(br) || Object.keys(br).sort().join() !== 'affirmative,serviceMention' ||
    typeof br.serviceMention !== 'string' || br.serviceMention.length > 200 || typeof br.affirmative !== 'boolean') return { ok: false, reason: 'invalid_field' };
  const bookingIntent = [primaryIntent, ...secondaryIntents as RoutingIntent[]].find(i => BOOKING_INTENTS.has(i));
  let booking: RoutingUnderstanding['bookingRequest'] = null;
  if (bookingIntent) {
    const mention = normalizeForQuote(br.serviceMention);
    if (mention && !quoteIncluded(parts ? normalizeForQuote(parts.bookingSpan) : haystack, mention)) return { ok: false, reason: 'booking_request_invalid' };
    booking = Object.freeze({ intent: bookingIntent, serviceMention: mention ? br.serviceMention.trim() : null, affirmative: br.affirmative });
  }
  return { ok: true, value: Object.freeze({ version: ROUTING_UNDERSTANDING_VERSION, primaryIntent, secondaryIntents: Object.freeze([...secondaryIntents as RoutingIntent[]]),
    confidence, requestsMutation, asksInformation, confirmation: confirmation as RoutingUnderstanding['confirmation'], continuesActiveBooking, language,
    resolvedQuestion: resolvedQuestion.trim(), referencesResolved, languageSwitch, evidence: Object.freeze(kept), droppedEvidence: dropped, mixedParts: parts, bookingRequest: booking }) };
}
