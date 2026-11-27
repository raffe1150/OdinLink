/**
 * Financially accounted semantic-routing dispatch through the EXISTING odin_ai_money_v1 authority (Sol stage 'routing', prepared migration
 * docs/designs/sol-understanding-ai-money-migration-package, NOT applied; the earlier Luna package is superseded). Reserve the conservative maximum before dispatch; one dispatch,
 * no retries; verify the provider project; settle the exact receipt; retain unknown exposure after any uncertain outcome.
 */
import { createHash } from 'node:crypto';
import { ROUTING_WIRE_SCHEMA } from './contract';
import { ROUTING_SYSTEM_INSTRUCTION, RoutingBudgetRefused, type AccountedRoutingClassifier, type RoutingClassifierInput, type RoutingDispatchIdentity } from './runtime';

/** Owner decision (Sol-first, Architecture A): semantic understanding runs on gpt-6.1-sol with EXPLICIT low reasoning effort. */
export const ROUTING_MODEL = Object.freeze({ model: 'gpt-6.1-sol' as const, reasoningEffort: 'low' as const, maxOutputTokens: 2048 as const });
/** PREPARED production money stage for Sol Understanding V2 (docs/designs/sol-understanding-ai-money-migration-package, NOT applied):
 * gpt-6.1-sol / routing / the deployed Sol card (openai-sol-standard-30m-2026-10-28), output limit = the body's max_output_tokens.
 * routingAllowanceNanoUsd: the per-message routing carve-out (Option A); the SQL row denies any routing quote above it, and the
 * knowledge-side owner ceilings are reduced by the same amount (knowledge-model-policy.ts configureRoutingTurnAllowance). */
export const ROUTING_MONEY = Object.freeze({
  model: 'gpt-6.1-sol' as const, stage: 'routing' as const, ratesVersion: 'openai-sol-standard-30m-2026-10-28' as const,
  outputTokenLimit: ROUTING_MODEL.maxOutputTokens, framingBytes: 2048, routingAllowanceNanoUsd: 100_000_000,
  // nano-USD per token; mirrors the deployed Sol rows and the prepared SQL row exactly.
  price: Object.freeze({ input: 2000, read: 100, write: 2500, output: 10000 }),
});
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const bytes = (v: string) => Buffer.byteLength(v, 'utf8');

/** Narrow accessor shape (generic reserve/settle/unknown transition of the installed durable owner). */
export type RoutingMoneyAuthority = Readonly<{
  id: string; approvalReference: string; providerProjectId?: string; maximumRequestNanoUsd: number; maximumTurnNanoUsd: number;
  transition(command: 'reserve' | 'settle' | 'unknown', payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}>;
/** projectId: the provider project of the SAME authority that made the reservation (never read from elsewhere at dispatch time). */
export type RoutingTransport = (body: Record<string, unknown>, signal: AbortSignal, projectId: string) => Promise<Readonly<{ status: number; json: any }>>;

export function routingRequestBody(input: RoutingClassifierInput): Record<string, unknown> {
  return { model: ROUTING_MODEL.model, instructions: ROUTING_SYSTEM_INSTRUCTION, input: JSON.stringify(input), store: false,
    reasoning: { effort: ROUTING_MODEL.reasoningEffort }, max_output_tokens: ROUTING_MODEL.maxOutputTokens,
    text: { format: { type: 'json_schema', name: 'odinlink_semantic_routing_v2', schema: ROUTING_WIRE_SCHEMA, strict: true } } };
}
export const routingMaximumNanoUsd = (bodyBytes: number) =>
  (bodyBytes + ROUTING_MONEY.framingBytes) * ROUTING_MONEY.price.write + ROUTING_MONEY.outputTokenLimit * ROUTING_MONEY.price.output;
export function routingCostNanoUsd(u: Readonly<{ inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number }>) {
  const p = ROUTING_MONEY.price;
  return (u.inputTokens - u.cachedTokens - u.cacheWriteTokens) * p.input + u.cachedTokens * p.read + u.cacheWriteTokens * p.write + u.outputTokens * p.output;
}
/** Production reservation-key formula (businessId, requestKey, stage), deterministic across recovery. */
export const routingReservationKey = (businessId: number, requestKey: string) => sha(JSON.stringify([businessId, requestKey, ROUTING_MONEY.stage]));

export function createAccountedRoutingClassifier(deps: Readonly<{ authority: (businessId: number) => RoutingMoneyAuthority | undefined; transport: RoutingTransport;
  /** Request body builder (default: the Sol understanding body). The money stage must match the body's model exactly. */
  body?: (input: RoutingClassifierInput) => Record<string, unknown> }>):
  AccountedRoutingClassifier {
  return {
    async classify(input, identity: RoutingDispatchIdentity, signal) {
      const body = (deps.body ?? routingRequestBody)(input);
      // The prepared money stage prices ROUTING_MONEY.model only. A body for any other model (today: Sol) is refused before any hold.
      if (body.model !== ROUTING_MONEY.model) throw new RoutingBudgetRefused('routing_money_stage_not_prepared_for_model');
      const owner = deps.authority(identity.businessId);
      if (!owner) throw new RoutingBudgetRefused('routing_money_owner_missing');
      // The provider project is bound to the reserving authority; without one nothing is reserved or dispatched.
      if (!owner.providerProjectId || !/^proj_[A-Za-z0-9_-]+$/u.test(owner.providerProjectId)) throw new RoutingBudgetRefused('routing_provider_project_missing');
      if (!/^[a-f0-9]{64}$/.test(identity.requestKey)) throw new RoutingBudgetRefused('routing_request_key_invalid');
      const text = JSON.stringify(body), requestSha256 = sha(text);
      const quote = { ownerId: owner.id, approvalReference: owner.approvalReference, ratesVersion: ROUTING_MONEY.ratesVersion, model: ROUTING_MONEY.model,
        stage: ROUTING_MONEY.stage, businessId: identity.businessId, requestKey: identity.requestKey, requestSha256,
        reservationKey: routingReservationKey(identity.businessId, identity.requestKey), turnId: identity.turnId,
        inputTokenProxy: bytes(text) + ROUTING_MONEY.framingBytes, outputTokenLimit: ROUTING_MONEY.outputTokenLimit,
        maximumNanoUsd: routingMaximumNanoUsd(bytes(text)), maximumRequestNanoUsd: owner.maximumRequestNanoUsd, maximumTurnNanoUsd: owner.maximumTurnNanoUsd,
        ...(owner.providerProjectId ? { providerProjectId: owner.providerProjectId } : {}) };
      if (quote.inputTokenProxy > 272_000 || quote.maximumNanoUsd > owner.maximumRequestNanoUsd || quote.maximumNanoUsd > owner.maximumTurnNanoUsd ||
        quote.maximumNanoUsd > ROUTING_MONEY.routingAllowanceNanoUsd)
        throw new RoutingBudgetRefused('routing_request_budget');
      signal.throwIfAborted();
      let hold: any;
      try { hold = await owner.transition('reserve', { quote }, signal); }
      catch { await owner.transition('unknown', { id: null, quote }).catch(() => undefined); throw new RoutingBudgetRefused('routing_reserve_uncertain'); }
      if (!hold || typeof hold.id !== 'string' && typeof hold.id !== 'number' || hold.denied) throw new RoutingBudgetRefused('routing_money_denied');
      const id = String(hold.id);
      let response: Readonly<{ status: number; json: any }>;
      try { response = await deps.transport(body, signal, owner.providerProjectId); }
      catch (error) { await owner.transition('unknown', { id, quote }).catch(() => undefined); throw error; } // dispatched: never release
      const j = response.json, u = j?.usage;
      const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : NaN);
      const usageCore = { inputTokens: n(u?.input_tokens), outputTokens: n(u?.output_tokens ?? 0), reasoningTokens: n(u?.output_tokens_details?.reasoning_tokens ?? 0),
        cachedTokens: n(u?.input_tokens_details?.cached_tokens ?? 0), cacheWriteTokens: n(u?.input_tokens_details?.cache_write_tokens ?? 0) };
      const valid = response.status === 200 && typeof j?.id === 'string' && /^resp_[A-Za-z0-9_-]+$/.test(j.id) && Object.values(usageCore).every(Number.isFinite) &&
        usageCore.inputTokens <= quote.inputTokenProxy && usageCore.outputTokens <= ROUTING_MONEY.outputTokenLimit &&
        usageCore.cachedTokens + usageCore.cacheWriteTokens <= usageCore.inputTokens && usageCore.reasoningTokens <= usageCore.outputTokens;
      if (!valid) { await owner.transition('unknown', { id, quote }).catch(() => undefined); throw new Error('routing_provider_receipt_invalid'); }
      const usage = { model: ROUTING_MONEY.model, ownerId: owner.id, ratesVersion: ROUTING_MONEY.ratesVersion, requestSha256, ...usageCore,
        estimatedNanoUsd: routingCostNanoUsd(usageCore), providerResponseId: j.id, ...(owner.providerProjectId ? { providerProjectId: owner.providerProjectId } : {}) };
      try {
        const settled: any = await owner.transition('settle', { id, quote, usage });
        if (!settled || settled.settled !== true) throw new Error('routing_settlement_unconfirmed');
      } catch (error) { await owner.transition('unknown', { id, quote }).catch(() => undefined); throw error; }
      if (j.status !== 'completed') throw new Error('routing_provider_incomplete');
      const out = (j.output ?? []).flatMap((o: any) => o.content ?? []).find((c: any) => c.type === 'output_text')?.text;
      if (typeof out !== 'string') throw new Error('routing_output_missing');
      return { output: JSON.parse(out) };
    },
  };
}

/** One dispatch, no SDK retries, project header + echo check (a mismatch is an uncertain outcome: exposure retained by the caller). */
export function createRoutingResponsesTransport(input: Readonly<{ projectId: string; timeoutMs: number;
  client: () => { responses: { create(body: any, options: any): { withResponse(): Promise<{ data: any; response: { status: number; headers: { get(n: string): string | null } } }> } } } }>): RoutingTransport {
  return async (body, signal, projectId) => {
    // Bound to the reserving authority's project: a different project is refused before any client or dispatch.
    if (projectId !== input.projectId) throw new Error('routing_project_binding');
    const { data, response } = await input.client().responses.create(body, { signal, timeout: input.timeoutMs, maxRetries: 0,
      headers: { 'OpenAI-Project': input.projectId } }).withResponse();
    if (response.headers.get('openai-project') !== input.projectId) throw new Error('routing_project_mismatch');
    return { status: response.status, json: data };
  };
}
