import { AsyncLocalStorage } from 'node:async_hooks';
import type { KnowledgeTask } from './knowledge-lifecycle';

type Turn = Pick<KnowledgeTask, 'turnId' | 'acceptedAt'> & {
  channel: KnowledgeTask['scope']['channel'];
  fence?: number;
  runAttempt?: number;
};
type Timing = Readonly<Record<string, string | number | boolean | undefined>>;
type Trace = { turn: Turn; providerWork: Set<Promise<unknown>> };
const traces = new AsyncLocalStorage<Trace>();

export function emitDurableTiming(turn: Turn, phase: string, timing: Timing = {}) {
  // Only call with fixed labels, timing/count data and validated opaque IDs.
  try {
    const atMs = Date.now();
    console.info('[DurableKnowledgeTiming]', JSON.stringify({
      version: 1, ...turn, phase, atMs, turnAgeMs: atMs - turn.acceptedAt, ...timing,
    }));
  } catch { /* Diagnostics cannot change the outcome. */ }
}

export function durableTraceFor(task: KnowledgeTask): Trace {
  return { turn: { turnId: task.turnId, acceptedAt: task.acceptedAt, channel: task.scope.channel,
    fence: task.fence, runAttempt: task.runAttempts }, providerWork: new Set() };
}

export function inDurableTrace<T>(trace: Trace, work: () => T): T {
  return traces.run(trace, work);
}

export function durableTiming(phase: string, timing?: Timing) {
  const trace = traces.getStore();
  if (trace) emitDurableTiming(trace.turn, phase, timing);
}

export function timeDurableWork<T>(phase: string, work: () => PromiseLike<T>, timing: Timing = {}): Promise<T> {
  if (!traces.getStore()) return Promise.resolve(work());
  return timed();
  async function timed() {
    const started = Date.now();
    let returned = false;
    try {
      const value = await work();
      returned = true;
      return value;
    } finally {
      durableTiming(phase, { ...timing, durationMs: Date.now() - started, returned });
    }
  }
}

export function trackDurableProviderWork<T>(pending: Promise<T>): Promise<T> {
  const work = traces.getStore()?.providerWork;
  if (work) {
    work.add(pending);
    const finished = () => { work.delete(pending); };
    void pending.then(finished, finished);
  }
  return pending;
}

export function hasDurableTrace(): boolean { return traces.getStore() !== undefined; }
