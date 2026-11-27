/**
 * EXPERIMENTAL — scripted providers for offline validation. They return fixed JSON; they never call a network.
 * Scripted verifiers are NOT an oracle: each test states the verdict it scripts and asserts the pipeline's decision.
 */
import { unitHash, draftHash } from '../pipeline';
import { pinCorpus } from '../corpus';
import { requestSha256 } from '../wire';
import type { AnswerOutput, AnswerUnit, ProviderRequest, ProviderResult, ReferenceProvider, SourceRecord, VerifierOutput } from '../types';

/** A sent unit as a scripted verifier sees it: `id` is the answer unit id (resolved by the TEST harness), `key` the protocol key. */
export type SentUnit = AnswerUnit & { key: string; paragraph?: number };
export type Script = Readonly<{
  answer: AnswerOutput | string | ((request: ProviderRequest) => Promise<ProviderResult>);
  /** Scripted verdicts written against answer unit ids (internal shape). The harness converts them to protocol v2 unit keys.
   * Return a string to send raw wire JSON instead (adversarial protocol tests). */
  verifier: ((sent: readonly SentUnit[], _unused: string, request: ProviderRequest) => VerifierOutput | string) |
    ((request: ProviderRequest) => Promise<ProviderResult>);
  verifierRaw?: boolean;
}>;

export const USAGE = Object.freeze({ inputTokens: 3800, cachedInputTokens: 0, outputTokens: 900, reasoningTokens: 150 });
const content = (u: Readonly<{ text: string; kind?: string }>) => JSON.stringify([u.text, u.kind ?? 'claim']);
const norm = (t: string) => t.normalize('NFC').replace(/\s+/gu, ' ').trim();

/** The passages a model sees in a request, per source block, in order: [{ref, text}]. */
export function renderedPassages(request: Pick<ProviderRequest, 'input'>): { ref: string; text: string }[][] {
  return request.input.split('<source ').slice(1).map(block => block.split('</source>')[0].split('\n')
    .map(line => /^\[(E\d+)\] (.*)$/u.exec(line)).filter(Boolean).map(m => ({ ref: m![1], text: m![2] })));
}
/** Quote → evidence references, as a faithful model would cite it: the run of consecutive passages whose text is the quote.
 * A quote that is not an exact run (or not in the request at all) maps to the unknown reference E9999 (adversarial tests). */
export function refsForQuote(request: Pick<ProviderRequest, 'input'>, quote: string): string[] {
  const q = norm(quote);
  for (const block of renderedPassages(request))
    for (let a = 0; a < block.length; a++) for (let b = a; b < block.length; b++)
      if (block.slice(a, b + 1).map(p => p.text).join(' ') === q) return block.slice(a, b + 1).map(p => p.ref);
  return ['E9999'];
}
/** Paragraph structure of a scripted answer: taken from the unit's own `newParagraph`, else from a scripted `draft` that contains the
 * unit texts in order (a paragraph break between two consecutive units in the draft → newParagraph on the second). */
function paragraphFlags(answer: AnswerOutput): boolean[] {
  const draft = answer.draft ?? '';
  let pos = 0;
  return answer.units.map((u, i) => {
    if (u.newParagraph !== undefined) return u.newParagraph;
    const at = draft.indexOf(u.text.trim(), pos);
    if (at < 0) return false;
    const between = draft.slice(pos, at);
    pos = at + u.text.trim().length;
    return i > 0 && /\n\s*\n/u.test(between);
  });
}
/** Internal-shaped scripted answer (citations) → answer wire protocol v3 (reply segments with evidence references). A unit that already
 * carries `evidence` (adversarial tests) is sent with exactly those references. Scripted drafts are NOT sent: v3 has none. */
export function answerToWire(answer: AnswerOutput, request: ProviderRequest) {
  const flags = paragraphFlags(answer);
  return { language: answer.language, obligations: answer.obligations,
    reply: answer.units.map(({ citations, evidence, kind, newParagraph: _p, ...u }, i) => ({ id: u.id, kind: kind ?? 'claim', text: u.text,
      modality: u.modality, conditions: u.conditions,
      evidence: evidence ? [...evidence] : citations.flatMap(c => refsForQuote(request, c.quote)), addresses: u.addresses, newParagraph: flags[i] })) };
}

/** Recovers the segments the pipeline sent (by parsing the verifier input it built) and, for tests only, their answer unit ids. */
export function sentUnits(request: ProviderRequest, answer?: AnswerOutput): SentUnit[] {
  const line = request.input.split('\n\n').find(part => part.startsWith('Reply segments to verify'))!;
  const byContent = new Map((answer?.units ?? []).map(u => [content({ text: u.text, kind: u.kind ?? 'claim' }), u.id]));
  return JSON.parse(line.slice(line.indexOf(': [') + 2)).map((u: any) => ({ id: byContent.get(content(u)) ?? u.unitKey, key: u.unitKey,
    text: u.text, kind: u.kind, modality: u.modality ?? 'descriptive', conditions: [], citations: [], evidence: u.evidence.map((e: any) => e.ref),
    addresses: [], paragraph: u.paragraph }));
}

/** Internal-shaped scripted verdicts → verifier wire JSON. Ids without a sent unit are passed through unchanged (they then fail binding);
 * conflicting quotes become evidence references as a faithful model would cite them. */
export function toWire(out: VerifierOutput, sent: readonly SentUnit[], request?: ProviderRequest) {
  const key = (id: string) => sent.find(u => u.id === id)?.key ?? id;
  return {
    obligations: out.obligations.map(({ conflictingQuotes, ...o }) => ({ ...o, coveredByUnits: o.coveredByUnits.map(key),
      conflictingEvidence: request ? conflictingQuotes.flatMap(q => refsForQuote(request, q.quote)) : [] })),
    units: out.units.map(({ unitId, ...v }: any) => { const { unitHash: _h, ...rest } = v; return { unitKey: key(unitId), ...rest }; }),
    reply: { misleadingAsWhole: !!out.reply?.misleadingAsWhole },
  };
}

export function scriptedProvider(script: Script, calls: ProviderRequest[] = []): ReferenceProvider {
  const correlate = (request: ProviderRequest, result: ProviderResult): ProviderResult =>
    result.requestSha256 ? result : { ...result, requestSha256: requestSha256(request) };
  return async request => {
    calls.push(request);
    if (request.role === 'answer') {
      if (typeof script.answer === 'function') return correlate(request, await script.answer(request));
      return correlate(request, { text: typeof script.answer === 'string' ? script.answer : JSON.stringify(answerToWire(script.answer, request)), status: 'completed',
        model: 'scripted', usage: USAGE, requestSha256: '' });
    }
    if (script.verifierRaw) return correlate(request, await (script.verifier as (r: ProviderRequest) => Promise<ProviderResult>)(request));
    const sent = sentUnits(request, typeof script.answer === 'object' ? script.answer : undefined);
    const out = (script.verifier as any)(sent, '', request);
    return correlate(request, { text: typeof out === 'string' ? out : JSON.stringify(toWire(out, sent, request)), status: 'completed', model: 'scripted',
      usage: USAGE, requestSha256: '' });
  };
}

/** Pinned revisions for the fixture, so scripted answers can cite them like a real model would. */
export function revisions(sources: readonly SourceRecord[], businessId = 3): Record<string, string> {
  const { corpus } = pinCorpus(businessId, sources);
  return Object.fromEntries(corpus!.sources.map(s => [s.id, s.revision]));
}
export const currentRevalidation = (sources: readonly SourceRecord[]) => {
  const rev = revisions(sources);
  return async (_businessId: number, ids: readonly string[]) => new Map(ids.map(id => [id, rev[id]]));
};

/** A verifier that approves every sent unit and maps obligations as given (internal shape; see toWire). */
type LooseObligation = Omit<VerifierOutput['obligations'][number], 'conflictingQuotes'> & Partial<Pick<VerifierOutput['obligations'][number], 'conflictingQuotes'>>;
export function approvingVerifier(obligations: (sent: readonly SentUnit[]) => readonly LooseObligation[],
  reply: Partial<VerifierOutput['reply']> = {}) {
  return (sent: readonly SentUnit[], _unused?: string): VerifierOutput => ({
    obligations: obligations(sent).map(o => ({ conflictingQuotes: [], ...o })),
    units: sent.map(u => ({ unitId: u.id, verdict: 'ENTAILED', modalityCorrect: true, conditionsPreserved: true, languageCorrect: true,
      unsupportedAdditions: [], independentOfConflicts: true })),
    reply: { misleadingAsWhole: false, ...reply },
  });
}
export { unitHash, draftHash };
