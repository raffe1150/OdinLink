# Knowledge Answer reference path (EXPERIMENTAL, Phase 1)

An isolated experiment that tests whether a simpler path can beat the current OdinLink Knowledge pipeline:
two independent Sol calls plus deterministic checks. It is **not** a second AI brain.

- Nothing in production imports it. `isolation.test.ts` fails if `server.ts` or anything under `src/` outside this folder does.
- It has no network, database or environment access. It does not use `fetch`, Supabase or `process.env`, and it ships no provider implementation.
- It is not connected to webhooks, channel adapters, the durable worker, the inbox/outbox, leases, checkpoints or AI Money.
- No production file was changed to build it.

## Flow

```
pin corpus (tenant 3 only, READY, revision = hash(updated_at + content))
  → evidence map:     software splits each pinned source into sentence passages and numbers them E1..En (evidence.ts);
                       redacted passages get no reference; the map is deep-frozen and bound to tenant + revisions
  → Call 1  answer:   numbered passages (static, first: cacheable prefix) + language + history + question → obligations and the
                       REPLY, written once as ordered segments (answer protocol v3, reply.ts): claims (text, modality, conditions,
                       evidence references, paragraph flag) and limitations (what is not available; no evidence). No draft.
  → resolve:          software resolves each reference to {sourceId, revision, verbatim passage}; unknown/malformed → refused
                       (EVIDENCE_REF_UNKNOWN); a map not rebuilt identically from this pinned corpus → EVIDENCE_MAP_MISMATCH
  → deterministic:    OBJECTIVE invariants only, re-checked on the resolved citations: protected information, source id and
                       revision, verbatim passage (≥ 15 chars), numbers ⊆ cited passages ∪ customer-supplied numbers, every
                       QUANTITY declared in `conditions` also stated in the text (CONDITION_NOT_IN_TEXT), language/script
                       (objective script errors and positive other-language evidence only; uncertain text goes to the verifier).
                       Limitations: no evidence/conditions/numbers, addressed to an obligation marked not (fully) answered.
                       Meaning (modality, negation, conditions, qualifiers, entailment) is judged only by the verifier (binding).
  → manifest:         software freezes the passing segments (order, kind, paragraph flags, text, citations) and the assembled
                       reply, and assigns each segment a short key U1..Un. Binding protocol v2: the model never copies hashes.
  → Call 2  verifier: passages + language + history + question + the keyed segments (customer-visible text only; the answerer's
                       `conditions` metadata is NOT sent). Verdicts by key per segment, obligations, and one whole-reply judgment
                       (misleadingAsWhole). Software binds keys, checks correlation and integrity, and publishes from snapshots.
                       It does NOT receive the answerer's obligations: it derives its own.
  → coverage:         one decision per verifier obligation (see below)
  → revalidate:       the host reports current revisions of the cited sources; any change → STALE_SOURCE
  → publish:          approved segments in AUTHORED order and paragraphs (never rewritten); fixed copy only to close a gap
```

**Owner policy (2026-11-24).**
- **Address:** state that it is provided with the booking confirmation when a source says so. Never invent one.
- **Optional items** (for example the water bottle) are included when relevant and stay explicitly optional.
- **Conflicting sources:** the conflicting claims are withheld. Unrelated information is published only when its independence is established: the verifier says it is independent, it covers no conflicting obligation, and none of its citations overlaps the verbatim conflicting excerpts.
- **Internal codes and secrets** (`secrets.ts`) are redacted from both model inputs and blocked deterministically in every unit, draft and final reply.
- **Unavailable information:** natural, localized `REMAINING` / `NOT_IN_SOURCES` copy. It needs native review.

**Coverage rules.** These are at least as strict as production's source-exhaustive v2.
- **Complete obligation:** published only when it is `complete` and every covering unit is approved.
- **Answer available but not fully published** (`missingInformation`, a rejected covering unit, or `not_addressed` while available): the whole turn falls back. The codes are `AVAILABLE_SOURCE_FACT_OMITTED` and `OBLIGATION_INCOMPLETE`. This is the GUARD_04 equivalent.
- **Conflicting sources:** withheld as described above. If the conflict cannot be proven with verbatim excerpts, the whole turn falls back with `SOURCE_CONFLICT`.
- **Genuinely absent from the sources:** the approved segments are published; a verified limitation segment names what is missing naturally, otherwise the fixed `REMAINING` copy closes the reply. A limitation for an obligation the verifier finds available is dropped (`LIMITATION_NOT_VERIFIED_ABSENT`). If nothing at all is available, verified limitation segments (or the fixed `NOT_IN_SOURCES` copy) are the reply.

**Publication outcomes** (`eval/metrics.ts` classifies them for evaluation):

| Outcome | Meaning | Evaluation class |
|---|---|---|
| `complete_draft` / `complete_units` | Every obligation answered | complete |
| `partial_draft` / `partial_units` | Everything in the sources answered; the rest is verified absent | complete relative to sources |
| `partial_verified_recovery` | Some available information could not be verified. That whole obligation is withheld, the complete obligations are published, and a notice says the rest could not be verified (it does not claim absence) | **incomplete** |
| `not_in_sources` | Nothing asked is in the sources | not in sources |
| `fallback` | Turn-level failure | fallback |

**The authored reply is published verbatim (`complete_draft` / `partial_draft`) only when** every segment passed the deterministic
checks and was approved by the verifier, nothing was withheld, conflicting or dropped, and every unavailable subject is stated by a
verified limitation segment for an obligation the verifier independently found absent. Otherwise only the approved segments are
published (`*_units`), still in authored order and paragraphs, and fixed copy (`REMAINING` / `NOT_IN_SOURCES` /
`VERIFICATION_REMAINING`) closes any gap. Nothing outside the segments can be sent, verified or published.

Every non-publication and every dropped unit carries a code from `reasons.ts`.

## Files

| File | Role |
|---|---|
| `types.ts` | Contracts |
| `reasons.ts` | Reason codes |
| `corpus.ts` | Tenant pinning and revisions |
| `text-checks.ts` | Objective checks: verbatim quotes, numbers in 6 languages, script/language plausibility |
| `contracts.ts` | Strict JSON schemas and validators |
| `prompts.ts` | Instructions and inputs for both calls |
| `localization.ts` | Fixed copy |
| `wire.ts` | Request body, size and cost (no network) |
| `pipeline.ts` | `runReferenceAnswer` |
| `manifest.ts` | Software-owned verifier binding (protocol v2); the manifest id also binds evidence refs, the evidence map id, segment order, kind and paragraph flags |
| `reply.ts` | Answer protocol v3: assembly of the reply from its segments (verbatim, authored order and paragraphs) |
| `evidence.ts` | Citation protocol v2: passage splitting, the per-turn evidence map, reference resolution |
| `eval/dataset-v1.json` | 60 cases with facts, conditions and prohibited claims |
| `eval/dataset.ts` | Loader |
| `eval/scripted.ts` | Scripted providers |
| `eval/dry-run.ts` | Request sizes and a cost envelope, with zero calls |
| `secrets.ts` | Deterministic redaction and disclosure guard |
| `eval/openai-adapter.ts` | One POST per call: no retries, `store: false`, reserve → dispatch → settle, unknown usage retained |
| `eval/pilot.ts` | Owner launcher: `plan` / `budget` / `execute` (the only file that can reach the network) |
| `eval/metrics.ts` | Outcome classification (recovery counts as incomplete) |
| `eval/genuine/…`, `eval/replay.test.ts` | Unmodified genuine outputs of Pilots 2–5 (Pilot 5 files are byte-identical copies of the owner's artifacts) and their offline replay. The harness CONVERTS historical answers into the current protocols only when exact (quotes = whole passages; draft = exactly the unit texts; verdicts bound; same unit set) and REFUSES otherwise: 10 of 17 are exercised, 7 are refused with a stated reason. A converted replay is not a genuine new-protocol result. |
| `eval/financial.test.ts` | Internal cost metric ≡ settlement convention (cache writes at $2.50/M); reproduces the Pilot 4 Δ $0.0083525 |
| `eval/pilot-v1.json` | The 8 pilot cases with expected facts, conditions, prohibited claims, reference answers and grading criteria |

## Run the offline tests (no network, no cost)

```
cd /Users/raffe/Documents/OdinLink-oversized-empty-release
node --experimental-transform-types --no-warnings --import <ts-extension-resolver> --test \
  $(find src/experimental/knowledge-reference -name '*.test.ts')
node --experimental-transform-types --no-warnings --import <ts-extension-resolver> src/experimental/knowledge-reference/eval/dry-run.ts
```

The resolver only maps extensionless relative imports to `.ts`. It is the same approach as the 17 Nov replay harness, because `tsx` cannot run on Linux with the macOS esbuild binary.

## Owner review checklist

1. **Dataset** (`eval/dataset-v1.json`):
   - Are the expected facts, required conditions and prohibited claims right for each case?
   - The Persian and Arabic questions, and every non-English `NOT_IN_SOURCES` line, need native review.
   - Owner decisions:
     - `sv-10` (address): is "the address is sent with the booking confirmation" an acceptable complete answer?
     - `fa-08`: should the reply also list the optional water bottle?
2. **Copy:** `localization.ts`. `NOT_IN_SOURCES` is new copy and needs native review.
3. **Policy decisions:**
   - (a) Conflicting sources currently stop the whole turn. Should they instead produce a limitation notice?
   - (c) The internal test code in `odinlink-test.txt`. The prompts tell both models never to reveal codes, but no deterministic guard exists yet.
4. **Paid evaluation:** approve or decline the plan in the project doc `brain-v2/knowledge-reference-path-phase1-20261124.md`.

## Phase 2: real Sol pilot (owner-run, explicitly authorized)

Limits: $0.15 per request; $7.00 cumulative experimental ceiling (owner authorization 2026-11-24 for $5.00, raised to $7.00 by explicit
owner authorization on 2026-11-25; Reference Knowledge experiments only, passed explicitly to `ExperimentLedger`; other experiment
writers keep the $4.00 default); $1.440355 total exposure per approved pilot run. Run on the Mac from the worktree root:

```
L=~/.codex/worktrees/odinlink-p0-answer-recovery/docs/validation/shared-core-2026-10-22
FLAGS="--ledger $L/source-aware-usage.json --other $L/budget-resumed-usage.json --historical-rows 594 --carry 0.0000078"
npx tsx src/experimental/knowledge-reference/eval/pilot.ts plan                 # free: planSha256, maxRunUsd
npx tsx src/experimental/knowledge-reference/eval/pilot.ts budget $FLAGS --credential-root ~/.config/odinlink   # read-only
npx tsx src/experimental/knowledge-reference/eval/pilot.ts approve --id ref-pilot-20261124-1 --approval approval.json $FLAGS   # no network
npx tsx src/experimental/knowledge-reference/eval/pilot.ts execute --approval approval.json --out "Claude outputs/reference-pilot/ref-pilot-20261124-1" $FLAGS
```

`approve` re-verifies the plan, the ledger headroom and the credential, then writes a single-use approval file that expires 30 minutes later. `execute` runs the 8 cases in order, once each, and stops on the first unknown outcome. It writes one JSON file per case plus `summary.json`. Grade the cases against `eval/pilot-v1.json`.
