# Durable resolved-question carriage (Sol Understanding V2 → Reference Engine): database package

**Status: PREPARED as specification + read-only export. No forward/rollback SQL is generated yet, by design.**

## Why no SQL yet
Every durable knowledge intake path validates the stored input with an exact allowlist `(p_input - array['question','language','history']) <> '{}'`
(repository sources: `ordered-v2-migration-package/ordered-admission-v2.sql` lines 97–103, `durable-knowledge-publication-migration-package/durable-publication-v2.sql`
lines 72–77, and the deployed `odin_accept_knowledge_turn_v1`). Which of these bodies production runs today cannot be verified from the repository:
the last production catalogue snapshot in the repository is 2026-10-19 (`progress-safety-migration-package/production-before.json`) and later packages
may or may not have been applied. Generating SQL against an unverified base would violate the release rule "verify actual production schema compatibility first".

## Exact change (to be generated from the export, one function at a time)
For every function whose export shows `mentionsInputAllowlist = true`:
1. allowlist becomes `array['question','language','history','interpretation']`;
2. new check: `p_input ? 'interpretation'` ⇒ `jsonb_typeof(p_input->'interpretation') = 'string' and length(btrim(p_input->>'interpretation')) between 1 and 600`;
3. nothing else (the 40,000-byte payload bound, history bounds, identity, fences, ACL, owner, `security invoker`, `search_path` unchanged).
Guards: md5(prosrc) equals the exported body; post-install md5 equals the generated body; ACL/owner/definer/config unchanged.
Rollback: restore each exported body, refusing while any `PREPARED`/accepted row stores an `interpretation` key that the old body would reject.

## Application side (already implemented, default OFF)
- `KnowledgeInput.interpretation?` (`src/p2/knowledge-lifecycle.ts`, `captureInput` bounds 1–600 characters).
- Attached only when `ODINLINK_KNOWLEDGE_INTERPRETATION_CARRIAGE=true` (`src/ai/brain-v2-production-wiring.ts`); absent → the payload is byte-identical to today's.
- The Reference executor passes it as `interpretation` next to the original words (`src/p2/reference-knowledge-executor.ts`).
- Without carriage the Reference Engine still answers from the customer's own words (the question, or the information span of a mixed request);
  only Sol's history-resolved restatement is lost for follow-up questions.

## Owner action
Run `export-readonly.sql` with a read-only role and attach the JSON. The package (forward, rollback, manifest, static tests) is then generated
deterministically from it, reviewed, and applied only with separate authorization.
