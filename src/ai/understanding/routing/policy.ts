import { BOOKING_INTENTS, INFORMATION_INTENTS, MUTATION_INTENTS, type RoutingIntent, type RoutingUnderstanding } from './contract';

/** Channel-independent context. Only booking-state facts; no message content. */
export type RoutingContext = Readonly<{
  activeBooking: null | Readonly<{ phase: string; awaitingConfirmation: boolean }>;
}>;
/** Existing deterministic signals, reported for comparison and fallback. */
export type LegacySignals = Readonly<{ knowledgeAdmitted: boolean; explicitAction: boolean }>;
export type ClassifierOutcome =
  | Readonly<{ kind: 'ok'; value: RoutingUnderstanding }>
  | Readonly<{ kind: 'unavailable'; reason: 'disabled' | 'not_eligible' | 'not_accounted' | 'budget_refused' | 'timeout' | 'provider_error' | 'invalid' }>;

export type RouteLane = 'knowledge' | 'booking' | 'mixed' | 'general' | 'clarify' | 'legacy';
export type RouteDecision = Readonly<{
  lane: RouteLane;
  /** knowledge: admit to evidence lane; deny: never admit this turn to knowledge; null: legacy predicates decide. */
  knowledge: 'admit' | 'deny' | null;
  preserveBookingState: boolean;
  order: readonly ('knowledge' | 'booking')[];
  reason: string;
  /** Mixed lane only: semantic split of the customer's own words (information span -> knowledge; booking span -> Booking Engine). */
  parts?: Readonly<{ informationSpan: string; bookingSpan: string; informationQuestion: string }>;
  /** Booking and mixed lanes: Sol's structured booking intent for the booking text (service words verbatim or null). */
  booking?: Readonly<{ intent: RoutingIntent; serviceMention: string | null; affirmative: boolean }>;
  /** Knowledge lane only: Sol's standalone restatement (references resolved from history) when it differs from the message. An aid for
   * the Reference Engine; the customer's original words always travel with it and prevail. */
  interpretation?: string;
}>;

/** Necessary, never sufficient: structural and contextual checks must also pass. */
export const ROUTING_MIN_CONFIDENCE = 0.8;

const legacy = (reason: string): RouteDecision => Object.freeze({ lane: 'legacy', knowledge: null, preserveBookingState: true, order: Object.freeze([]), reason });
const decision = (lane: RouteLane, knowledge: RouteDecision['knowledge'], preserve: boolean, order: RouteDecision['order'], reason: string): RouteDecision =>
  Object.freeze({ lane, knowledge, preserveBookingState: preserve, order: Object.freeze([...order]), reason });

/**
 * Pure routing policy. Fail-closed rules:
 * - provider failure / low confidence / invalid output -> existing legacy behavior (no new route);
 * - contradictory or unsupported action intent -> clarify (never a mutation route, never knowledge);
 * - information never becomes a booking route; a booking route only hands the turn to the
 *   Booking Engine, which keeps all existing validations and confirmations.
 */
export function decideRoute(outcome: ClassifierOutcome, context: RoutingContext, _legacy: LegacySignals): RouteDecision {
  if (outcome.kind !== 'ok') return legacy(`unavailable:${outcome.reason}`);
  const u = outcome.value, active = context.activeBooking;
  if (u.confidence < ROUTING_MIN_CONFIDENCE) return legacy('low_confidence');
  const intents = new Set<RoutingIntent>([u.primaryIntent, ...u.secondaryIntents]);
  const hasInfo = [...intents].some(i => INFORMATION_INTENTS.has(i));
  const hasBooking = [...intents].some(i => BOOKING_INTENTS.has(i));
  const hasMutation = [...intents].some(i => MUTATION_INTENTS.has(i));

  if (u.primaryIntent === 'clarification') return decision('clarify', 'deny', true, [], 'model_clarification');
  if (u.primaryIntent === 'mixed') {
    if (!hasInfo || !hasBooking || !u.asksInformation) return decision('clarify', 'deny', true, [], 'mixed_incomplete');
    if (!u.mixedParts) return decision('clarify', 'deny', true, [], 'mixed_without_parts');
    // Semantic parts are routing aids for a fresh, affirmative, unconditional booking START only. A non-affirmative (negated, conditional,
    // hypothetical) booking part, or any other booking operation, keeps the full message on the existing path (consent stays whole).
    const b = u.bookingRequest;
    if (!b || !b.affirmative || !['new_booking', 'availability'].includes(b.intent)) return legacy('mixed_requires_full_message');
    return Object.freeze({ ...decision('mixed', null, true, ['knowledge', 'booking'], 'mixed_information_then_booking'), parts: u.mixedParts,
      ...(u.bookingRequest ? { booking: u.bookingRequest } : {}) });
  }
  if (INFORMATION_INTENTS.has(u.primaryIntent)) {
    // An informational reading that also requests a mutation is contradictory.
    if (u.requestsMutation || hasMutation || u.confirmation !== 'none') return decision('clarify', 'deny', true, [], 'information_with_action_conflict');
    if (!u.asksInformation) return legacy('information_without_question');
    // The caller compares it with the exact question text and carries it only when it differs.
    return Object.freeze({ ...decision('knowledge', 'admit', true, ['knowledge'], active ? 'information_interruption_preserving_booking' : 'information'),
      ...(u.resolvedQuestion ? { interpretation: u.resolvedQuestion } : {}) });
  }
  if (u.primaryIntent === 'confirmation') {
    if (u.confirmation === 'none' || !active?.awaitingConfirmation) return decision('clarify', 'deny', true, [], 'confirmation_without_pending_confirmation');
    if (hasInfo) return decision('clarify', 'deny', true, [], 'confirmation_with_information_conflict');
    return decision('booking', 'deny', true, ['booking'], 'confirmation_to_booking_engine');
  }
  if (u.primaryIntent === 'booking_continuation') {
    if (!active || !u.continuesActiveBooking) return decision('clarify', 'deny', true, [], 'continuation_without_active_booking');
    return decision('booking', 'deny', true, ['booking'], 'booking_continuation');
  }
  if (BOOKING_INTENTS.has(u.primaryIntent)) {
    // A booking-labelled question that requests nothing is a policy question mislabelled: contradictory.
    if (MUTATION_INTENTS.has(u.primaryIntent) && !u.requestsMutation) return decision('clarify', 'deny', true, [], 'action_label_without_request');
    if (hasInfo) return decision('clarify', 'deny', true, [], 'booking_with_information_conflict');
    return Object.freeze({ ...decision('booking', 'deny', true, ['booking'], 'booking_engine'), ...(u.bookingRequest ? { booking: u.bookingRequest } : {}) });
  }
  if (u.primaryIntent === 'general_conversation') {
    if (u.requestsMutation) return decision('clarify', 'deny', true, [], 'general_with_action_conflict');
    return decision('general', 'deny', true, [], 'general_conversation');
  }
  return legacy('unhandled');
}
