import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DisposableNativeKnowledgeDatabase } from '../../tests/helpers/disposable-native-knowledge-db';
import type { ResolvedChannelConnection } from '../channels/connections/contracts';
import type { TelegramPreflightMethod } from './knowledge-preflight-diagnostic';
import { safeUnavailableKnowledge } from './knowledge-lifecycle';
import { KNOWLEDGE_OPERATION_LIMITS } from './knowledge-operation';
import { NativeKnowledgeRuntime } from './native-knowledge-runtime';

const account = '123456';
const token = `${account}:synthetic_DO_NOT_LOG_TOKEN`;
const question = 'Var ligger entrén? DO_NOT_LOG_CUSTOMER_CONTENT';
const hidden = 'DO_NOT_LOG_EXCEPTION_OR_BODY';
const connection: ResolvedChannelConnection = {
  id: 'telegram-test-connection', businessId: 3, provider: 'telegram', providerAccountId: account,
  providerConnectionId: null, status: 'connected', reconnectRequired: false, grantedScopes: [],
  tokenExpiresAt: null, connectedAt: null, lastVerifiedAt: null, displayName: null,
  source: 'legacy_manual', credential: { accessToken: token }, metadata: {},
};

type Fault = {
  method: TelegramPreflightMethod;
  category: string;
  respond: (signal: AbortSignal) => Response | Promise<Response>;
  causeCode?: string;
  httpStatus?: number;
  executionError?: boolean;
};
const faults: [name: string, fault: Fault][] = [
  ['getMe fetch rejection', {
    method: 'getMe', category: 'network_rejection', causeCode: 'ECONNRESET', executionError: true,
    respond: () => { throw new TypeError(hidden, { cause: { code: 'ECONNRESET', url: token } }); },
  }],
  ['getChat fetch rejection with private cause', {
    method: 'getChat', category: 'network_rejection', executionError: true,
    respond: () => { throw new TypeError(hidden, { cause: { code: hidden } }); },
  }],
  ['getChatMember fetch rejection with unknown exception', {
    method: 'getChatMember', category: 'unexpected_exception', executionError: true,
    respond: () => { throw Object.assign(new Error(hidden), { name: hidden, code: hidden }); },
  }],
  ['transport timeout', {
    method: 'getMe', category: 'timeout', causeCode: 'UND_ERR_CONNECT_TIMEOUT', executionError: true,
    respond: () => { throw new TypeError(hidden, { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); },
  }],
  ['preflight deadline expires with a pending fetch', {
    method: 'getChat', category: 'timeout',
    respond: signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException(hidden, 'AbortError')), { once: true });
    }),
  }],
  ['HTTP provider denial', {
    method: 'getChatMember', category: 'provider_rejection', httpStatus: 403,
    respond: () => Response.json({ ok: false, description: hidden }, { status: 403 }),
  }],
  ['provider denial in a successful HTTP response', {
    method: 'getMe', category: 'provider_rejection', httpStatus: 200,
    respond: () => Response.json({ ok: false, description: hidden }),
  }],
  ['malformed JSON', {
    method: 'getChat', category: 'malformed_response', httpStatus: 200,
    respond: () => new Response(hidden),
  }],
  ['malformed result shape', {
    method: 'getChatMember', category: 'malformed_response', httpStatus: 200,
    respond: () => Response.json({ ok: true, result: { description: hidden } }),
  }],
  ['valid result denying eligibility', {
    method: 'getChatMember', category: 'eligibility_denial', httpStatus: 200,
    respond: () => Response.json({ ok: true, result: { user: { id: Number(account) }, status: 'left' } }),
  }],
];

test('hosted Telegram eligibility diagnostics with disposable PostgreSQL', async t => {
  const pg = new DisposableNativeKnowledgeDatabase();
  t.after(() => pg.close());
  pg.sql('insert into public.businesses values (3);');
  pg.sql(readFileSync('docs/designs/durable-knowledge-publication-migration-package/durable-publication-v2.sql', 'utf8'));
  const logs: unknown[][] = [];
  t.mock.method(console, 'info', (...args) => { logs.push(args); });
  const events: { stage: string; turnId?: string }[] = [];
  const sends: { chat_id: string; text: string }[] = [];
  const methods: string[] = [];
  let fault: Fault | undefined;
  let faultTriggered = false;
  let executorCalls = 0;
  let recipient = '';
  const runtime = new NativeKnowledgeRuntime({
    db: pg.db, secret: 'synthetic binding secret for offline tests only',
    controls: () => ({
      admission: true, processing: true, delivery: true, publicationV2: true, executionMs: 20_000,
      extended: { executionMs: 75_000, tenants: new Set([3]) },
    }),
    waiting: () => ({ enabled: false, delayMs: 5000 }),
    connections: async (businessId, channel) => businessId === 3 && channel === 'telegram' ? connection : null,
    diagnostic: event => events.push(event),
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.telegram.org');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      const method = url.pathname.split('/').at(-1)!;
      if (method === 'sendMessage') {
        assert.equal(init?.method, 'POST');
        sends.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, result: { message_id: 100, chat: { id: Number(recipient) } } });
      }
      assert.equal(init?.method, 'GET');
      methods.push(method);
      if (!faultTriggered && fault && method === fault.method) {
        faultTriggered = true;
        return fault.respond(init!.signal!);
      }
      switch (method) {
        case 'getMe': return Response.json({ ok: true, result: { id: Number(account), is_bot: true } });
        case 'getChat': return Response.json({ ok: true, result: { id: Number(recipient), type: 'private' } });
        case 'getChatMember': return Response.json({ ok: true, result: { user: { id: Number(account) }, status: 'member' } });
        default: assert.fail('Unexpected Telegram method');
      }
    },
    execute: async (task, _context, current) => {
      executorCalls++;
      assert.equal(await current(), true);
      assert.equal(task.expiresAt - task.acceptedAt, 75_000);
      return safeUnavailableKnowledge('sv');
    },
  });
  t.after(() => runtime.stop());

  let serial = 0;
  async function runCase(injectedFault?: Fault) {
    fault = injectedFault;
    faultTriggered = false;
    executorCalls = 0;
    logs.length = events.length = sends.length = methods.length = 0;
    const eventId = ++serial;
    recipient = String(46700011000 + eventId);
    const { admission, run } = (await runtime.beginIntake({
      businessId: 3, channel: 'telegram', account, recipient, eventId: String(eventId),
      order: { atMs: Math.floor((Date.now() - 1000) / 1000) * 1000, sequence: eventId },
    }, question))!;
    assert.equal(run, true);
    const attached = await runtime.attach(admission, { question, language: 'sv', history: [] });
    const task = attached?.acceptance?.task;
    assert.ok(task?.publicationV2);
    const report = await runtime.tick();
    const final = await runtime.repository.get(task.scope, task.id);
    assert.equal(executorCalls, injectedFault ? 0 : 1);
    assert.equal(faultTriggered, Boolean(injectedFault));
    assert.equal(final?.state, 'FINALIZED');
    assert.equal(final?.modelAttempts, 0);
    assert.equal(final?.checkpoint, null);
    assert.deepEqual(final?.result, safeUnavailableKnowledge('sv'));
    assert.equal(report.deliveries.length, 1);
    assert.equal(report.deliveries[0].result.outcome.kind, 'API_ACCEPTED');
    assert.equal(report.deliveries[0].result.settled, true);
    assert.deepEqual(sends, [{ chat_id: recipient, text: safeUnavailableKnowledge('sv').text }]);
    assert.equal(pg.sql(`select knowledge_state from public.odin_outbox where knowledge_task_id='${task.id}';`), 'SENT');
    await runtime.tick();
    assert.equal(sends.length, 1);
    assert.equal(events.some(event => event.stage === 'execution_error'), Boolean(injectedFault?.executionError));

    const checks = ['getMe', 'getChat', 'getChatMember'];
    const expected = injectedFault ? checks.slice(0, checks.indexOf(injectedFault.method) + 1) : checks;
    assert.deepEqual(methods.slice(0, expected.length + 1), [...expected, 'getMe']);
    const serialized = JSON.stringify([logs, events]);
    for (const privateValue of [token, hidden, question, recipient, 'https://api.telegram.org']) {
      assert.equal(serialized.includes(privateValue), false);
    }
    const failures = logs.filter(([prefix]) => prefix === '[AsyncKnowledgePreflight]')
      .map(([, event]) => JSON.parse(String(event)))
      .filter(event => event.stage === 'telegram_preflight_failed');
    assert.equal(failures.length, injectedFault ? 1 : 0);
    if (!injectedFault) return;
    const { instance, revision, elapsedMs, remainingMs, ...fields } = failures[0];
    assert.deepEqual(fields, {
      stage: 'telegram_preflight_failed', phase: 'execution_eligibility', turnId: task.turnId, channel: 'telegram',
      method: injectedFault.method, category: injectedFault.category,
      ...(injectedFault.causeCode ? { causeCode: injectedFault.causeCode } : {}),
      ...(injectedFault.httpStatus ? { httpStatus: injectedFault.httpStatus } : {}),
    });
    assert.match(instance, /^[a-f0-9-]{36}$/u);
    assert.match(revision, /^(?:[a-f0-9]{7,40}|unknown)$/iu);
    assert.ok(Number.isInteger(elapsedMs) && elapsedMs >= 0);
    assert.ok(Number.isInteger(remainingMs) && remainingMs >= 0 && remainingMs <= KNOWLEDGE_OPERATION_LIMITS.eligibilityMs);
    if (injectedFault.category === 'timeout' && !injectedFault.causeCode) {
      assert.ok(elapsedMs >= KNOWLEDGE_OPERATION_LIMITS.eligibilityMs);
      assert.equal(remainingMs, 0);
    }
  }
  for (const [name, injectedFault] of faults) await t.test(name, () => runCase(injectedFault));
  await t.test('successful eligibility reaches the Knowledge executor', () => runCase());
});
