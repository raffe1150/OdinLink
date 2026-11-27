/**
 * EXPERIMENTAL — request shape, size and cost accounting for a LATER, separately authorized evaluation.
 * This file contains no network code. Phase 1 never calls a provider; tests inject scripted providers.
 */
import { createHash } from 'node:crypto';
import type { ProviderRequest, ProviderUsage } from './types';

export const REFERENCE_MODEL = 'gpt-6.1-sol';

/** USD per 1M tokens. Mirrors KNOWLEDGE_SOL_RATES in src/ai/knowledge-model-policy.ts (version openai-sol-standard-30m-2026-10-28);
 * a test asserts they stay equal. Reasoning tokens are billed as output. */
export const SOL_RATES = Object.freeze({ version: 'openai-sol-standard-30m-2026-10-28', input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 });

/** Output ceilings for the reference calls (bound worst-case cost; production Knowledge stages use 8192). */
/** Output allowance per stage (Production Integration Phase 2 calibration). Genuine maxima under the current protocol (Pilots 6–7):
 * answer 575, verifier 539 tokens; all-time maxima incl. the older quote+draft protocols: 1,746 / 1,107. 2,048 covers every genuine
 * call ever made; a larger response is truncated, and truncation fails closed (ANSWER_TRUNCATED / VERIFIER_TRUNCATED, no retry). */
export const REFERENCE_MAX_OUTPUT = Object.freeze({ answer: 2048, verifier: 2048 });

/** The exact OpenAI Responses API body the evaluation adapter would send (reasoning low, strict schema, no retries). */
export function responsesBody(request: Omit<ProviderRequest, 'signal'>, model = REFERENCE_MODEL) {
  return {
    model,
    instructions: request.instructions,
    input: request.input,
    reasoning: { effort: 'low' },
    max_output_tokens: request.maxOutputTokens,
    text: { format: { type: 'json_schema', name: request.schemaName, schema: request.schema, strict: true } },
    store: false,
  };
}
export const requestBytes = (request: Omit<ProviderRequest, 'signal'>): number =>
  Buffer.byteLength(JSON.stringify(responsesBody(request)), 'utf8');
/** Software-owned request/response correlation: SHA-256 of the exact body the transport sends for this request. */
export const requestSha256 = (request: Omit<ProviderRequest, 'signal'>): string =>
  createHash('sha256').update(JSON.stringify(responsesBody(request)), 'utf8').digest('hex');

/** Cost from a provider usage receipt, using the SAME convention as the settlement ledger (actualUsd in the shared experiment accounting):
 * uncached input at the input rate, cached input at the cache-read rate, cache-written input at the cache-write rate, output (including
 * reasoning) at the output rate. A test asserts equality with actualUsd and with every Pilot 4 receipt. */
export function costUsd(usage: ProviderUsage, rates = SOL_RATES): number {
  const written = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens - written);
  return (uncached * rates.input * 1000 + usage.cachedInputTokens * rates.cacheRead * 1000 + written * rates.cacheWrite * 1000 +
    usage.outputTokens * rates.output * 1000) / 1e9;
}

/** Conservative pre-dispatch hold: 1 byte = 1 token (the production quote convention; real wires measure ~3–5 bytes/token for
 * Swedish/English), priced at the cache-write rate, plus the full output ceiling. */
export function worstCaseUsd(bytes: number, maxOutputTokens: number, rates = SOL_RATES): number {
  return (bytes * rates.cacheWrite + maxOutputTokens * rates.output) / 1e6;
}
