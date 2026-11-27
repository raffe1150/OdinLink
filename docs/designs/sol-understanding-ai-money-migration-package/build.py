"""Builds the Sol Understanding V2 money stage (forward + rollback + manifest). Deterministic; run from anywhere.
Base: the deployed ai_money.transition_core_v2 body, verified byte for byte against the owner's read-only production export
(routing-money-deployed-contract-verification-20261126): Tier B body, md5 cf7773b3a165f6118f91cede0f265b45.
Supersedes docs/designs/semantic-routing-ai-money-migration-package (Luna routing; never applied)."""
import hashlib, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
BASE = os.path.join(R, 'docs/designs/tierb-natural-ai-money-migration-package/tierb-natural-stages-v1.sql')
SIG = ("create or replace function ai_money.transition_core_v2(p_account text,p_approval text,p_command text,p_payload jsonb,p_scope jsonb default null)\n"
       "returns jsonb language plpgsql security definer set search_path=pg_catalog as $$")
FN = "ai_money.transition_core_v2(text,text,text,jsonb,jsonb)"
ALLOWANCE = 100000000  # nano-USD; must equal ROUTING_MONEY.routingAllowanceNanoUsd (src/ai/understanding/routing/money.ts)
md5 = lambda t: hashlib.md5(t.encode()).hexdigest(); sha = lambda t: hashlib.sha256(t.encode()).hexdigest()
def body_of(path):
    s = open(path).read(); a = s.index(SIG) + len(SIG); return s[a:s.index('$$;', a)]
old = body_of(BASE)
assert md5(old) == 'cf7773b3a165f6118f91cede0f265b45', md5(old)
ANCHOR_RATE = " elsif q->>'model'='gpt-5.6-luna' and q->>'stage'='knowledge_natural_validation' and q->>'ratesVersion'='openai-luna-standard-2026-07-30' then\n"
ROW = (" elsif q->>'model'='gpt-6.1-sol' and q->>'stage'='routing' and q->>'ratesVersion'='openai-sol-standard-30m-2026-10-28' then\n"
       "  -- Sol Understanding V2 (semantic routing): the deployed Sol card; output bounded by the request's max_output_tokens (2048).\n"
       "  price_input:=2000;price_read:=100;price_write:=2500;price_output:=10000;output_limit:=2048;\n")
ANCHOR_CAP = "  if maximum>least(request_cap,ai_money.amount((q->>'maximumRequestNanoUsd')::numeric)) then return jsonb_build_object('denied','budget_exhausted'); end if;\n"
CAP = (f"  -- Per-message invariant: the application gives routing and every knowledge stage of one inbound message the SAME canonical\n"
       f"  -- requestKey, so they share one ('turn',business,requestKey) bucket bounded below by least(operator, plan, quote) turn caps.\n"
       f"  -- Routing is additionally capped per request at the fixed routing allowance.\n"
       f"  if q->>'stage'='routing' and maximum>{ALLOWANCE} then return jsonb_build_object('denied','budget_exhausted'); end if;\n")
assert old.count(ANCHOR_RATE) == 1 and old.count(ANCHOR_CAP) == 1 and "'routing'" not in old
new = old.replace(ANCHOR_RATE, ROW + ANCHOR_RATE).replace(ANCHOR_CAP, ANCHOR_CAP + CAP)
head = ("-- Sol Understanding V2 money stage (forward-only, v1). PREPARED 2026-11-26. NOT APPLIED. Outside automatic migration discovery.\n"
        "-- Apply only with separate explicit owner authorization, after the read-only preflight (preflight-readonly.sql) confirms the guards.\n"
        f"-- Replaces ONE function body, {FN}, only if production runs prosrc md5 {md5(old)} (deployed Tier B body, verified 2026-11-26).\n"
        "-- Adds exactly: gpt-6.1-sol / routing / openai-sol-standard-30m-2026-10-28 (deployed Sol prices, output limit 2048), and a routing\n"
        f"-- quote ceiling of {ALLOWANCE} nano-USD (the per-message routing allowance). Sol is already admitted on the production path by model;\n"
        "-- trials never admit 'routing' (stage lists and stage caps unchanged). Supersedes the unapplied Luna routing package.\n"
        "-- Unchanged: tables, columns, grants (verified), owner, security definer, search_path, every other model/stage/rate, operator/period/\n"
        "-- tenant/plan/turn caps and counters, unique(account_id,reservation_key), unique(account_id,business_id,request_key,stage), quote\n"
        "-- envelope, receipt identity (provider project + resp_ id), settle/unknown, append-only events, every existing row. No limit is raised.\n")
fwd = (head + "begin;\nset local lock_timeout='5s';\nset local statement_timeout='30s';\n"
  f"create temp table sol_routing_money_acl on commit drop as\n select proacl::text as acl, proowner, prosecdef, proconfig::text as config from pg_proc\n where oid='{FN}'::regprocedure;\n"
  f"do $guard$\ndeclare core text;\nbegin\n select md5(prosrc) into core from pg_proc where oid='{FN}'::regprocedure;\n"
  f" if core is distinct from '{md5(old)}' then raise exception 'ai_money_sol_routing_unexpected_function_body'; end if;\n"
  " if not exists(select 1 from pg_constraint where conrelid='ai_money.reservations'::regclass and contype='u'\n   and pg_get_constraintdef(oid)='UNIQUE (account_id, business_id, request_key, stage)') then\n  raise exception 'ai_money_sol_routing_missing_stage_uniqueness';\n end if;\n"
  " if exists(select 1 from ai_money.reservations where stage='routing') then raise exception 'ai_money_sol_routing_rows_already_present'; end if;\nend $guard$;\n"
  + SIG + new + "$$;\n"
  "do $post$\nbegin\n"
  f" if (select md5(prosrc) from pg_proc where oid='{FN}'::regprocedure) is distinct from '{md5(new)}' then\n  raise exception 'ai_money_sol_routing_post_install_mismatch';\n end if;\n"
  f" if exists(select 1 from pg_proc p, sol_routing_money_acl a where p.oid='{FN}'::regprocedure\n   and (p.proacl::text is distinct from a.acl or p.proowner<>a.proowner or p.prosecdef<>a.prosecdef or p.proconfig::text is distinct from a.config)) then\n  raise exception 'ai_money_sol_routing_privileges_changed';\n end if;\nend $post$;\ncommit;\n")
rb = (f"-- Rollback for sol-routing-stage-v1. NOT APPLIED. Restores the exact deployed Tier B body (md5 {md5(old)}).\n"
  "-- The restored body has no 'routing' rate row, so it raises ai_money_unapproved_model_stage for EVERY routing command (reserve,\n"
  "-- settle, unknown) before it reads the reservation. A routing row left held or unknown would therefore be stranded: it could never\n"
  "-- settle and its full maximum would stay counted as exposure. The guard therefore refuses while ANY routing row is not settled\n"
  "-- (held or unknown). Procedure: ODINLINK_SEMANTIC_ROUTING_MODE=off, wait for held rows to settle or turn unknown, reconcile each\n"
  "-- unknown row by settling its late receipt under THIS (forward) body, re-run the preflight (routingRowsByState), then roll back.\n"
  "-- If an unknown row cannot be reconciled, do not roll back: the forward body is purely additive and inert while routing is off.\n"
  "-- After rollback a late receipt for an already-settled routing row raises (no row is changed); the application treats that as a\n"
  "-- settlement failure and never dispatches. Rows and events are never deleted or changed; historical evidence is preserved.\n"
  "begin;\nset local lock_timeout='5s';\nset local statement_timeout='30s';\n"
  "do $guard$\nbegin\n"
  f" if (select md5(prosrc) from pg_proc where oid='{FN}'::regprocedure) is distinct from '{md5(new)}' then\n  raise exception 'ai_money_sol_routing_rollback_unexpected_body';\n end if;\n"
  " if exists(select 1 from ai_money.reservations where stage='routing' and state='held') then raise exception 'ai_money_sol_routing_rollback_held_rows'; end if;\n"
  " if exists(select 1 from ai_money.reservations where stage='routing' and state<>'settled') then raise exception 'ai_money_sol_routing_rollback_unsettled_rows'; end if;\nend $guard$;\n"
  + SIG + old + "$$;\n"
  "do $post$\nbegin\n"
  f" if (select md5(prosrc) from pg_proc where oid='{FN}'::regprocedure) is distinct from '{md5(old)}' then\n  raise exception 'ai_money_sol_routing_rollback_post_mismatch';\n end if;\nend $post$;\ncommit;\n")
pre = ("-- READ-ONLY preflight for sol-routing-stage-v1 (no writes, no customer content). Run as a read-only role and attach the output.\n"
  "select jsonb_build_object(\n"
  f" 'coreMd5',(select md5(prosrc) from pg_proc where oid='{FN}'::regprocedure),\n"
  f" 'coreAcl',(select proacl::text from pg_proc where oid='{FN}'::regprocedure),\n"
  f" 'coreSecurityDefiner',(select prosecdef from pg_proc where oid='{FN}'::regprocedure),\n"
  f" 'coreConfig',(select proconfig::text from pg_proc where oid='{FN}'::regprocedure),\n"
  " 'stageUniqueness',exists(select 1 from pg_constraint where conrelid='ai_money.reservations'::regclass and contype='u'\n   and pg_get_constraintdef(oid)='UNIQUE (account_id, business_id, request_key, stage)'),\n"
  " 'stageColumnType',(select format_type(atttypid,atttypmod) from pg_attribute where attrelid='ai_money.reservations'::regclass and attname='stage'),\n"
  " 'stageChecks',(select coalesce(jsonb_agg(pg_get_constraintdef(oid)),'[]'::jsonb) from pg_constraint where conrelid='ai_money.reservations'::regclass and contype='c'\n   and pg_get_constraintdef(oid) ilike '%stage%'),\n"
  " 'routingRows',(select count(*) from ai_money.reservations where stage='routing'),\n"
  " 'routingRowsByState',(select coalesce(jsonb_object_agg(state,n),'{}'::jsonb) from (select state,count(*) n from ai_money.reservations where stage='routing' group by state) s),\n"
  " 'operatorTurnCaps',(select coalesce(jsonb_agg(jsonb_build_object('requestNanoUsd',request_nano_usd,'turnNanoUsd',turn_nano_usd)),'[]'::jsonb) from ai_money.operators where enabled),\n"
  " 'planTurnCaps',(select coalesce(jsonb_agg(jsonb_build_object('requestNanoUsd',request_nano_usd,'turnNanoUsd',turn_nano_usd)),'[]'::jsonb) from ai_money.plans where enabled)\n"
  ") as sol_routing_preflight;\n")
for name, text in [('sol-routing-stage-v1.sql', fwd), ('rollback-sol-routing-stage-v1.sql', rb), ('preflight-readonly.sql', pre)]:
    open(os.path.join(HERE, name), 'w').write(text)
manifest = {'function': FN, 'stage': 'routing', 'model': 'gpt-6.1-sol', 'ratesVersion': 'openai-sol-standard-30m-2026-10-28', 'outputTokenLimit': 2048,
  'routingAllowanceNanoUsd': ALLOWANCE, 'applied': False, 'automaticMigrationDiscovery': False,
  'deployedContractVerified': True, 'deployedContractEvidence': 'brain-v2/routing-money-deployed-contract-verification-20261126.md (owner CSV export, byte-for-byte)',
  'supersedes': 'docs/designs/semantic-routing-ai-money-migration-package (never applied)',
  'baseSource': os.path.relpath(BASE, R), 'expectedCurrentBodyMd5': md5(old), 'expectedCurrentBodySha256': sha(old),
  'newBodyMd5': md5(new), 'newBodySha256': sha(new),
  'payload': 'sol-routing-stage-v1.sql', 'payloadSha256': sha(fwd), 'rollback': 'rollback-sol-routing-stage-v1.sql', 'rollbackSha256': sha(rb),
  'preflight': 'preflight-readonly.sql', 'preflightSha256': sha(pre)}
open(os.path.join(HERE, 'manifest.json'), 'w').write(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=1))
