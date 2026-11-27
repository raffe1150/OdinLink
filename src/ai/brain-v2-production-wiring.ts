/**
 * AI Brain V2 production wiring (Sol Understanding V2 + Reference Knowledge Engine). EVERYTHING DEFAULTS OFF.
 *
 * Builds, from server-side environment only, the bindings the hosted runtimes consume:
 *  1. the accounted Sol understanding classifier for SemanticRoutingRuntime (stage 'routing', durable money owner);
 *  2. the Reference Knowledge Engine binding for the durable NativeKnowledgeRuntime (Sol answer + independent Sol verifier);
 *  3. the routing request cap (per-message canonical spend identity becomes active) and the durable resolved-question carriage switch.
 *
 * Managed endpoint (same contract as the existing Knowledge Sol path, src/ai/providers/openai.ts): every credential-bearing client is
 * constructed ONLY with the pinned official endpoint, ONLY after the endpoint, controlled-trial and provider-project checks pass, and
 * every request carries the provider project of the SAME money authority that made its reservation (echo verified before use).
 * Any violation refuses before a client exists: no credential leaves the process.
 *
 * Two bindings depend on a database change this code cannot verify by itself, so each needs an explicit attestation besides its mode flag:
 *  - ODINLINK_SEMANTIC_ROUTING_MONEY_STAGE=sol-routing-v1   (docs/designs/sol-understanding-ai-money-migration-package applied)
 *  - ODINLINK_KNOWLEDGE_INTERPRETATION_CARRIAGE=true        (the durable knowledge input allowlist accepts `interpretation`; keep OFF until a
 *                                                            reviewed migration exists for the verified live contract)
 * Rollback = set the mode flag to off (or drop the attestation) and restart; no deploy needed.
 */
import { createAccountedRoutingClassifier, ROUTING_MONEY, type RoutingMoneyAuthority, type RoutingTransport } from './understanding/routing/money';
import { readSemanticRoutingConfig, type AccountedRoutingClassifier } from './understanding/routing/runtime';
import { referenceEngineConfig, type ReferenceExecutorDeps, type ReferenceTransport, type ResponsesClient } from '../p2/reference-knowledge-executor';
import { knowledgeExecutionDeadline } from '../p2/knowledge-operation';

export const BRAIN_V2_ATTESTATIONS = Object.freeze({ routingMoneyStage: 'sol-routing-v1' as const });
/** The only endpoint a Brain V2 credential may reach (identical to the managed Knowledge Sol contract). */
export const MANAGED_OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** Transport cap for one Reference stage; the executor's deadline-derived stage budget (≤ 20 s) aborts earlier. */
export const BRAIN_V2_TIMEOUTS = Object.freeze({ referenceTransportMs: 20_000 });

type Env = Readonly<Record<string, string | undefined>>;
export type ClientOptions = Readonly<{ apiKey: string; baseURL: string; maxRetries: 0 }>;
export type BrainV2WiringDeps = Readonly<{
  /** Constructs the credential-bearing SDK client. Called only after every pre-dispatch check passed, per request, never at boot. */
  createClient: (options: ClientOptions) => ResponsesClient;
  /** Controlled-trial mode (src/runtime/controlled-knowledge-trial.ts trialEnforced): Brain V2 never dispatches inside a trial. */
  trialEnforced: () => boolean;
  routingAuthority: (businessId: number) => RoutingMoneyAuthority | undefined;
  referenceOwner: ReferenceExecutorDeps['owner'];
  now?: () => number;
}>;
export type BrainV2Status = Readonly<{ routing: 'off' | 'not_attested' | 'no_credential' | 'endpoint_refused' | 'installed';
  reference: 'off' | 'no_credential' | 'endpoint_refused' | 'installed'; interpretationCarriage: boolean; routingRequestCapNanoUsd: number; canonicalSpendTenant: number | null }>;
export type BrainV2Wiring = Readonly<{
  routingClassifier: AccountedRoutingClassifier | null;
  /** Per-request routing bound (0 when routing is not installed). */
  routingAllowanceNanoUsd: number;
  /** The single tenant using the canonical per-message spend identity (attested money stage + pilot tenant; independent of mode flags). */
  canonicalSpendTenant: number | null;
  referenceBinding: Pick<ReferenceExecutorDeps, 'owner' | 'transport' | 'remainingMs'> | undefined;
  interpretationCarriage: boolean;
  /** Content-free status for the boot log and deployed-commit verification. */
  status: BrainV2Status;
}>;

/** The managed-endpoint contract: no override, or exactly the official endpoint. */
export function managedEndpointConfigured(env: Env): boolean {
  const base = env.OPENAI_BASE_URL;
  return base === undefined || base === '' || base.replace(/\/$/u, '') === MANAGED_OPENAI_BASE_URL;
}

/** One credential-bearing dispatch under the managed contract. Every check precedes client construction. */
function managedDispatch(env: Env, deps: BrainV2WiringDeps, name: 'routing' | 'reference', timeoutMs: number) {
  return async (body: unknown, signal: AbortSignal, projectId: string): Promise<Readonly<{ status: number; json: any }>> => {
    if (deps.trialEnforced()) throw new Error(`${name}_controlled_trial_refused`);
    if (!managedEndpointConfigured(env)) throw new Error(`${name}_endpoint_mismatch`);
    if (typeof projectId !== 'string' || !/^proj_[A-Za-z0-9_-]+$/u.test(projectId)) throw new Error(`${name}_provider_project_missing`);
    const apiKey = env.OPENAI_API_KEY;
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error(`${name}_credential_missing`);
    signal.throwIfAborted();
    const client = deps.createClient(Object.freeze({ apiKey, baseURL: MANAGED_OPENAI_BASE_URL, maxRetries: 0 as const }));
    const { data, response } = await client.responses.create(body, { signal, timeout: timeoutMs, maxRetries: 0,
      headers: { 'OpenAI-Project': projectId } }).withResponse();
    // The provider must answer for the reserving owner's project; a mismatch is an uncertain outcome (exposure retained by the caller).
    if (response.headers.get('openai-project') !== projectId) throw new Error(`${name}_project_mismatch`);
    return { status: response.status, json: data };
  };
}

export function brainV2ProductionWiring(env: Env, deps: BrainV2WiringDeps): BrainV2Wiring {
  const now = deps.now ?? Date.now;
  const credential = typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim().length > 0;
  const endpointOk = managedEndpointConfigured(env);
  // ---- 1. Sol Understanding V2
  const routingConfig = readSemanticRoutingConfig(env as Record<string, string | undefined>);
  let routing: BrainV2Status['routing'] = 'off';
  let routingClassifier: AccountedRoutingClassifier | null = null;
  if (routingConfig.mode !== 'off') {
    if (env.ODINLINK_SEMANTIC_ROUTING_MONEY_STAGE !== BRAIN_V2_ATTESTATIONS.routingMoneyStage) routing = 'not_attested';
    else if (!credential) routing = 'no_credential';
    else if (!endpointOk) routing = 'endpoint_refused';
    else {
      routing = 'installed';
      routingClassifier = createAccountedRoutingClassifier({ authority: deps.routingAuthority,
        transport: managedDispatch(env, deps, 'routing', routingConfig.timeoutMs) as RoutingTransport });
    }
  }
  // ---- 2. Reference Knowledge Engine (durable NativeKnowledgeRuntime)
  const referenceConfig = referenceEngineConfig(env);
  let reference: BrainV2Status['reference'] = 'off';
  let referenceBinding: BrainV2Wiring['referenceBinding'];
  if (referenceConfig.mode !== 'off') {
    if (!credential) reference = 'no_credential';
    else if (!endpointOk) reference = 'endpoint_refused';
    else {
      reference = 'installed';
      referenceBinding = Object.freeze({
        owner: deps.referenceOwner,
        transport: managedDispatch(env, deps, 'reference', BRAIN_V2_TIMEOUTS.referenceTransportMs) as ReferenceTransport,
        // The worker's real compute deadline (finalization/delivery reserve excluded), never task expiry.
        remainingMs: task => Math.max(0, knowledgeExecutionDeadline(task) - now()),
      });
    }
  }
  const interpretationCarriage = env.ODINLINK_KNOWLEDGE_INTERPRETATION_CARRIAGE === 'true';
  const routingAllowanceNanoUsd = routingClassifier ? ROUTING_MONEY.routingAllowanceNanoUsd : 0;
  // Canonical per-message spend identity: bound to the database fact (money stage attested) and the single pilot tenant, independent of
  // the routing MODE and the Reference flag, so disabling feature flags, restarting or recovering never gives an admitted message a
  // second bucket. Without the attestation (OFF deployment) every key is the baseline key.
  const canonicalSpendTenant = env.ODINLINK_SEMANTIC_ROUTING_MONEY_STAGE === BRAIN_V2_ATTESTATIONS.routingMoneyStage && routingConfig.businessIds.size === 1
    ? [...routingConfig.businessIds][0] : null;
  return Object.freeze({ routingClassifier, routingAllowanceNanoUsd, referenceBinding, interpretationCarriage, canonicalSpendTenant,
    status: Object.freeze({ routing, reference, interpretationCarriage, routingRequestCapNanoUsd: routingAllowanceNanoUsd, canonicalSpendTenant }) });
}
