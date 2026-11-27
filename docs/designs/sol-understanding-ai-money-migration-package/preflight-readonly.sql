-- READ-ONLY preflight for sol-routing-stage-v1 (no writes, no customer content). Run as a read-only role and attach the output.
select jsonb_build_object(
 'coreMd5',(select md5(prosrc) from pg_proc where oid='ai_money.transition_core_v2(text,text,text,jsonb,jsonb)'::regprocedure),
 'coreAcl',(select proacl::text from pg_proc where oid='ai_money.transition_core_v2(text,text,text,jsonb,jsonb)'::regprocedure),
 'coreSecurityDefiner',(select prosecdef from pg_proc where oid='ai_money.transition_core_v2(text,text,text,jsonb,jsonb)'::regprocedure),
 'coreConfig',(select proconfig::text from pg_proc where oid='ai_money.transition_core_v2(text,text,text,jsonb,jsonb)'::regprocedure),
 'stageUniqueness',exists(select 1 from pg_constraint where conrelid='ai_money.reservations'::regclass and contype='u'
   and pg_get_constraintdef(oid)='UNIQUE (account_id, business_id, request_key, stage)'),
 'stageColumnType',(select format_type(atttypid,atttypmod) from pg_attribute where attrelid='ai_money.reservations'::regclass and attname='stage'),
 'stageChecks',(select coalesce(jsonb_agg(pg_get_constraintdef(oid)),'[]'::jsonb) from pg_constraint where conrelid='ai_money.reservations'::regclass and contype='c'
   and pg_get_constraintdef(oid) ilike '%stage%'),
 'routingRows',(select count(*) from ai_money.reservations where stage='routing'),
 'routingRowsByState',(select coalesce(jsonb_object_agg(state,n),'{}'::jsonb) from (select state,count(*) n from ai_money.reservations where stage='routing' group by state) s),
 'operatorTurnCaps',(select coalesce(jsonb_agg(jsonb_build_object('requestNanoUsd',request_nano_usd,'turnNanoUsd',turn_nano_usd)),'[]'::jsonb) from ai_money.operators where enabled),
 'planTurnCaps',(select coalesce(jsonb_agg(jsonb_build_object('requestNanoUsd',request_nano_usd,'turnNanoUsd',turn_nano_usd)),'[]'::jsonb) from ai_money.plans where enabled)
) as sol_routing_preflight;
