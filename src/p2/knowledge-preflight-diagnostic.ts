import { randomUUID } from 'node:crypto';
import { runOptionalDiagnostic } from '../ai/business-information-timing';

export const providerRejections = ['BINDING_OR_CONNECTION', 'CONNECTION_CHANGED', 'EVENT_TIME', 'TELEGRAM_CONNECTION_MODE',
  'TELEGRAM_BOT_IDENTITY', 'TELEGRAM_PRIVATE_CHAT', 'TELEGRAM_MEMBERSHIP', 'RESPONSE_WINDOW', 'WHATSAPP_CONNECTION_OR_SCOPE',
  'WHATSAPP_APP_CONFIGURATION', 'WHATSAPP_TOKEN_APP', 'WHATSAPP_TOKEN_VALIDITY', 'WHATSAPP_TOKEN_SCOPE', 'WHATSAPP_TOKEN_EXPIRY', 'WHATSAPP_GRANULAR_SCOPE', 'WHATSAPP_WABA_IDENTITY', 'WHATSAPP_WABA_ASSIGNMENT', 'WHATSAPP_PHONE_MEMBERSHIP', 'WHATSAPP_PHONE_HEALTH_OR_WINDOW',
  'META_SAVED_SCOPE', 'META_IDENTITY', 'META_CONVERSATION_OR_WINDOW'] as const;
export type ProviderRejection = typeof providerRejections[number];
export const entryRejections = ['BUSINESS_SCOPE', 'EVIDENCE_FIRST_ROUTE', 'CANCELLED', 'TURN_CONTEXT'] as const;
type EntryRejection = typeof entryRejections[number];
const instance = randomUUID(); // Per-process opaque identity; no hostname/account/environment dump.
export type TelegramPreflightMethod = 'getMe' | 'getChat' | 'getChatMember';
type TelegramPreflightFailure = 'timeout' | 'cancelled' | 'network_rejection' | 'provider_rejection' |
  'malformed_response' | 'eligibility_denial' | 'unexpected_exception';
export type TelegramPreflightRead = {
  method: TelegramPreflightMethod;
  httpStatus?: number;
  failure?: 'provider_rejection';
  bodyError?: unknown;
};
const timeoutCodes = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const transportCodes = new Set([...timeoutCodes, 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']);

export function telegramPreflightFailed(turnId: string, read: TelegramPreflightRead, startedAt: number, deadlineAt: number,
  failure: TelegramPreflightFailure, error?: unknown): void {
  runOptionalDiagnostic(() => {
    if (!/^[a-f0-9-]{36}$/iu.test(turnId)) return;
    const now = Date.now();
    const exception = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined;
    const causeCode = [exception?.cause?.code, exception?.code].find((code): code is string =>
      typeof code === 'string' && transportCodes.has(code));
    let category = failure;
    if (failure === 'unexpected_exception' || failure === 'malformed_response') {
      if (exception?.name === 'TimeoutError' || (causeCode && timeoutCodes.has(causeCode))) category = 'timeout';
      else if (exception?.name === 'AbortError' || causeCode === 'UND_ERR_ABORTED') category = 'cancelled';
      else if (causeCode || (exception?.name === 'TypeError' && read.httpStatus === undefined)) category = 'network_rejection';
    }
    const status = read.httpStatus;
    const revision = process.env.RENDER_GIT_COMMIT || '';
    console.info('[AsyncKnowledgePreflight]', JSON.stringify({
      stage: 'telegram_preflight_failed', phase: 'execution_eligibility', turnId, channel: 'telegram',
      instance, revision: /^[a-f0-9]{7,40}$/iu.test(revision) ? revision : 'unknown',
      method: read.method, category, ...(causeCode ? { causeCode } : {}),
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
      elapsedMs: Math.max(0, now - startedAt), remainingMs: Math.max(0, deadlineAt - now),
    }));
  });
}

export function preflightRejected(turnId: string, channel: string,
  gate: 'provider' | 'execution_entry', reason: ProviderRejection | EntryRejection,
  observer: (event: Readonly<Record<string, string>>) => unknown = event => console.info('[AsyncKnowledgePreflight]', JSON.stringify(event))): void {
  runOptionalDiagnostic(() => {
    if (!/^[a-f0-9-]{36}$/iu.test(turnId) || !['whatsapp','telegram','instagram','messenger'].includes(channel) ||
      !(gate === 'provider' ? providerRejections : entryRejections).includes(reason as never)) return;
    const revision = process.env.RENDER_GIT_COMMIT || '';
    return observer(Object.freeze({ stage: 'execution_preflight_rejected', gate, reason, turnId, channel,
      instance, revision: /^[a-f0-9]{7,40}$/iu.test(revision) ? revision : 'unknown' }));
  });
}
