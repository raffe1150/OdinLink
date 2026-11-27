/** EXPERIMENTAL — Knowledge Answer reference path. Not wired into production. */
import type { Reason } from './reasons';

export const LANGUAGES = ['sv', 'en', 'de', 'es', 'fa', 'ar'] as const;
export type Language = typeof LANGUAGES[number];
export const isLanguage = (value: unknown): value is Language => typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);

/** A Knowledge source row as the host would read it (tenant-scoped, READY). */
export type SourceRecord = Readonly<{
  /** Host-authoritative revision (production: knowledgeSourceRevision). When present it is the pinned revision; otherwise the module
   * derives one from content + updatedAt. Revalidation must use the same authority. */
  revision?: string;
  id: string;
  businessId: number;
  title: string;
  type: string;
  status: string;
  content: string;
  updatedAt: string;
}>;

/** A source pinned for one turn. `revision` is a content hash; it is what citations must name. */
export type PinnedSource = Readonly<{
  id: string;
  businessId: number;
  title: string;
  revision: string;
  /** Original bytes (revision basis). */
  content: string;
  /** What the models see: content with protected internal information redacted (secrets.ts). Quotes must come from this. */
  modelContent: string;
}>;

export type HistoryTurn = Readonly<{ role: 'user' | 'assistant'; content: string }>;

export type ReferenceInput = Readonly<{
  businessId: number;
  question: string;
  /** Response language, decided by the host (the existing language authority). */
  language: Language;
  /** Most recent turns, oldest first. Context only, never evidence. */
  history: readonly HistoryTurn[];
  /** Optional standalone restatement of the latest message from the conversation-understanding stage. An aid for resolving references
   * only: the customer's own message stays authoritative, it is never evidence, and numbers in it are never customer-supplied. */
  interpretation?: string;
  sources: readonly SourceRecord[];
  /** Additional owner-declared terms that must never be disclosed (e.g. internal codes). */
  protectedTerms?: readonly string[];
}>;

export const MODALITIES = ['descriptive', 'recommended', 'required', 'not_required', 'permitted', 'prohibited', 'not_offered'] as const;
export type Modality = typeof MODALITIES[number];

export type Citation = Readonly<{ sourceId: string; revision: string; quote: string }>;

/** Call 1 output. Answer protocol v3 (2026-11-25): the customer reply is authored ONCE, as an ordered list of segments. */
export const SEGMENT_KINDS = ['claim', 'limitation'] as const;
export type SegmentKind = typeof SEGMENT_KINDS[number];
export type AnswerUnit = Readonly<{
  id: string;
  /** Customer-visible text: one self-contained sentence (or two) in the response language. This is exactly what is published. */
  text: string;
  modality: Modality;
  /** The answerer's declaration of the conditions/exceptions/thresholds its TEXT states. Internal metadata: never published, never
   * shown to the verifier, and never sufficient on its own (every number it names must also be in the text). */
  conditions: readonly string[];
  citations: readonly Citation[];
  /** Answerer's own obligation ids this unit addresses (measurement only, plus limitation eligibility). */
  addresses: readonly string[];
  /** Evidence references the model cited (citation protocol v2); `citations` are their software resolution. */
  evidence?: readonly string[];
  /** claim (default): a sourced statement. limitation: says plainly that some asked information is not available; no evidence. */
  kind?: SegmentKind;
  /** The segment starts a new paragraph of the reply (default false). */
  newParagraph?: boolean;
}>;
export type AnswererObligation = Readonly<{ id: string; description: string; status: 'answered' | 'partially_answered' | 'not_in_sources' }>;
/** What the answer model returns (answer protocol v3 + citation protocol v2): the reply as ordered segments with evidence references. */
export type AnswerSegmentWire = Readonly<{ id: string; kind: SegmentKind; text: string; modality: Modality; conditions: readonly string[];
  evidence: readonly string[]; addresses: readonly string[]; newParagraph: boolean }>;
export type AnswerWire = Readonly<{ language: Language; obligations: readonly AnswererObligation[]; reply: readonly AnswerSegmentWire[] }>;
/** @deprecated answer protocol v2 unit shape (kept for historical conversion only). */
export type AnswerUnitWire = Readonly<{ id: string; text: string; modality: Modality; conditions: readonly string[]; evidence: readonly string[];
  addresses: readonly string[] }>;
export type AnswerOutput = Readonly<{
  language: Language;
  obligations: readonly AnswererObligation[];
  units: readonly AnswerUnit[];
  /** The authored reply. Under protocol v3 it is assembled by software from the segments (assembleReply), never sent separately. */
  draft: string;
}>;

/** Call 2 output. */
export const UNIT_VERDICTS = ['ENTAILED', 'PARTIALLY_ENTAILED', 'NOT_ENTAILED', 'CONTRADICTED'] as const;
type VerdictFields = Readonly<{
  verdict: typeof UNIT_VERDICTS[number];
  modalityCorrect: boolean;
  conditionsPreserved: boolean;
  languageCorrect: boolean;
  unsupportedAdditions: readonly string[];
  /** The unit relies on no source statement that the verifier reported as conflicting. */
  independentOfConflicts: boolean;
}>;
/** Internal verdict, bound by software (manifest.ts) to an answer unit id. */
export type UnitVerdict = Readonly<{ unitId: string }> & VerdictFields;
export const OBLIGATION_STATUSES = ['complete', 'incomplete', 'not_addressed'] as const;
export type VerifierObligation = Readonly<{
  id: string;
  description: string;
  kind: 'information' | 'recommendation' | 'requirement' | 'permission' | 'location' | 'other';
  /** Whether the pinned sources contain information that answers this obligation (fully or partly). */
  availableInSources: boolean;
  /** Sources contain mutually inconsistent statements about this obligation. */
  sourcesConflict: boolean;
  /** When sourcesConflict: the exact, mutually inconsistent source excerpts (verbatim, at least two). */
  conflictingQuotes: readonly Readonly<{ sourceId: string; quote: string }>[];
  status: typeof OBLIGATION_STATUSES[number];
  coveredByUnits: readonly string[];
  /** Relevant source facts the units leave out (short paraphrases, for diagnostics only). */
  missingInformation: readonly string[];
}>;
/** Reply-level judgment (verifier protocol v4). The reply has no separate draft any more, so the former draft judgments
 * (faithful, unsupported additions, omitted units, language) are per-segment verdicts; one whole-reply judgment remains. */
export type ReplyVerdict = Readonly<{
  /** Read as a whole, in order, the segments would mislead the customer (for example by juxtaposition or ordering). */
  misleadingAsWhole: boolean;
}>;
/** Internal (bound) verifier output: unit ids are answer unit ids. */
export type VerifierOutput = Readonly<{
  obligations: readonly VerifierObligation[];
  units: readonly UnitVerdict[];
  reply: ReplyVerdict;
}>;
/** What the model returns (binding protocol v2 + evidence references): software-assigned unit keys (U1..Un) and evidence
 * references (E1..En) instead of hashes, source ids or quotes. */
export type VerifierWireObligation = Readonly<Omit<VerifierObligation, 'conflictingQuotes'> & { conflictingEvidence: readonly string[] }>;
export type VerifierWireOutput = Readonly<{
  obligations: readonly VerifierWireObligation[];
  units: readonly (Readonly<{ unitKey: string }> & VerdictFields)[];
  reply: ReplyVerdict;
}>;

export type ProviderUsage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Input tokens written to the prompt cache, priced at the cache-write rate (the settlement convention). Default 0. */
  cacheWriteTokens?: number;
}>;
export type ProviderRequest = Readonly<{
  role: 'answer' | 'verifier';
  instructions: string;
  input: string;
  schemaName: string;
  schema: Readonly<Record<string, unknown>>;
  maxOutputTokens: number;
  signal: AbortSignal;
}>;
export type ProviderResult = Readonly<{
  /** Raw JSON text returned by the model. */
  text: string;
  status: 'completed' | 'incomplete';
  model: string;
  usage?: ProviderUsage;
  /** SHA-256 of the exact request body the transport sent (software-computed). The pipeline rejects a result for another request. */
  requestSha256: string;
}>;
/** Injected. The Phase 1 module ships no network implementation. */
export type ReferenceProvider = (request: ProviderRequest) => Promise<ProviderResult>;

export type StageMetrics = Readonly<{
  role: 'answer' | 'verifier';
  model?: string;
  latencyMs: number;
  requestBytes: number;
  outcome: 'ok' | 'error' | 'timeout' | 'truncated' | 'malformed';
  usage?: ProviderUsage;
  costUsd?: number;
}>;

/** complete_*: every obligation answered. partial_draft / partial_units: everything the sources contain is answered and the rest is
 * genuinely absent from them. *_draft: the authored reply (all segments, in order, with their paragraphs) is published verbatim;
 * *_units: only the approved segments are published, still in authored order and paragraphs, and fixed copy closes any gap. partial_verified_recovery: some available information could NOT be verified and was withheld,
 * which makes it INCOMPLETE (see eval/metrics.ts). */
export type PublicationKind = 'complete_draft' | 'complete_units' | 'partial_draft' | 'partial_units' | 'partial_verified_recovery' | 'not_in_sources' | 'fallback';

export type ReferenceResult = Readonly<{
  publication: PublicationKind;
  /** The only text that may reach a customer. For 'fallback' this is the fixed safe copy. */
  text: string;
  publishedUnitIds: readonly string[];
  limitationObligationIds: readonly string[];
  /** Sources (id + pinned revision) cited by the published segments, from the frozen manifest snapshots. Empty for fallback and
   * limitation-only replies (a verified absence cites nothing; the host binds it to the whole pinned corpus). */
  citedSources: readonly Readonly<{ id: string; revision: string }>[];
  reasons: readonly Reason[];
  metrics: Readonly<{ totalMs: number; stages: readonly StageMetrics[]; costUsd?: number }>;
  /** Local, secret-redacted evidence for authorized evaluations only (ReferenceOptions.captureEvidence). Never sent anywhere. */
  evidence?: Readonly<{
    answer?: AnswerOutput;
    /** The answer exactly as the model returned it (evidence references), before software resolution. */
    answerWire?: AnswerWire;
    evidenceMapId?: string;
    deterministic: readonly Readonly<{ unitId: string; code: string; detail?: string }>[];
    verifier?: VerifierWireOutput;
    manifest?: Readonly<{ id: string; entries: readonly Readonly<{ key: string; unitId: string; hash: string }>[]; draftHash: string }>;
  }>;
  /** Content-free trace for owner review: obligation shapes and per-unit decisions. */
  trace: Readonly<{
    answererObligations: number;
    verifierObligations: readonly Readonly<{ id: string; kind: string; availableInSources: boolean; status: string; approvedUnits: number }>[];
    units: readonly Readonly<{ id: string; modality: Modality; deterministic: 'pass' | 'fail'; verifier?: string; approved: boolean }>[];
  }>;
}>;
