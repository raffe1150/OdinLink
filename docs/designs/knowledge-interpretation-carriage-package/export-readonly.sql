-- READ-ONLY export for the durable resolved-question carriage (no writes, no customer content).
-- Returns the exact deployed bodies (md5, sha256, full prosrc) of every function that validates the durable knowledge input allowlist
-- (question, language, history), plus the inbox/task columns that store it. The forward/rollback SQL is generated from THIS output only.
select jsonb_build_object(
 'identity', jsonb_build_object('database', current_database(), 'role', current_user, 'version', current_setting('server_version'), 'at', clock_timestamp()),
 'functions', (select coalesce(jsonb_agg(jsonb_build_object(
    'signature', p.oid::regprocedure::text, 'md5', md5(p.prosrc), 'sha256', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
    'securityDefiner', p.prosecdef, 'config', p.proconfig::text, 'acl', p.proacl::text, 'owner', pg_get_userbyid(p.proowner),
    'mentionsInputAllowlist', p.prosrc like '%array[''question'',''language'',''history'']%', 'prosrc', p.prosrc) order by p.oid::regprocedure::text), '[]'::jsonb)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('odin_accept_knowledge_turn_v1', 'odin_accept_knowledge_turn_v2', 'odin_native_intake_v1',
     'odin_native_intake_v2', 'odin_transition_knowledge_v1', 'odin_transition_knowledge_v2')),
 'inputColumns', (select coalesce(jsonb_agg(jsonb_build_object('table', table_name, 'column', column_name, 'type', data_type)), '[]'::jsonb)
   from information_schema.columns where table_schema = 'public' and table_name in ('odin_inbox', 'odin_tasks')
     and (column_name like '%input%' or column_name = 'payload')),
 'inputChecks', (select coalesce(jsonb_agg(jsonb_build_object('table', conrelid::regclass::text, 'name', conname, 'definition', pg_get_constraintdef(oid))), '[]'::jsonb)
   from pg_constraint where conrelid in ('public.odin_inbox'::regclass, 'public.odin_tasks'::regclass) and contype = 'c'
     and (pg_get_constraintdef(oid) ilike '%question%' or pg_get_constraintdef(oid) ilike '%payload%' or pg_get_constraintdef(oid) ilike '%input%'))
) as knowledge_interpretation_carriage_export;
