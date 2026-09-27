/** FLOW-02 additive evidence. Old WorkflowVersions, Runs and repeat rows are not rewritten. */
export const workHandoffMigration = { version: 269301, sql: String.raw`
create table run_work_activations (
  activation_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  workflow_node_id text not null,
  cause_kind text not null check (cause_kind in ('entry','dependency','work_request','work_return','limit_denial')),
  cause_id text not null,
  state text not null check (state in ('queued','running','waiting','completed','needs_direction','unknown')),
  input_digest text check (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  record jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (run_id,activation_id),
  unique (run_id,cause_kind,cause_id),
  check (record->>'activationId' is not distinct from activation_id),
  check (record #>> '{scope,runId}' is not distinct from run_id),
  check (record #>> '{scope,workflowVersionId}' is not distinct from workflow_version_id),
  check (record->>'workflowNodeId' is not distinct from workflow_node_id),
  check (record #>> '{cause,kind}' is not distinct from cause_kind),
  check (case cause_kind when 'entry' then cause_id=run_id
    when 'dependency' then cause_id=record #>> '{cause,resolutionId}'
    when 'work_request' then cause_id=record #>> '{cause,requestId}'
    when 'work_return' then cause_id=record #>> '{cause,returnId}'
    else cause_id=record #>> '{cause,denialId}' end)
);
create index run_work_activations_node_recent on run_work_activations(run_id,workflow_node_id,created_at desc,activation_id);

create table run_work_connection_usage (
  run_id text not null references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  relationship_id text not null,
  used integer not null default 0 check (used>=0),
  maximum integer check (maximum between 1 and 2147483647),
  primary key (run_id,workflow_version_id,relationship_id),
  check (maximum is null or used<=maximum)
);

create table run_work_requests (
  request_id text primary key,
  run_id text not null,
  workflow_version_id text not null,
  relationship_id text not null,
  ordinal integer not null check (ordinal>0),
  requester_activation_id text not null,
  requester_execution_id text not null references harness_executions(id) on delete cascade deferrable initially deferred,
  destination_activation_id text not null,
  requester_node_id text not null,
  destination_node_id text not null,
  payload_digest text not null check (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  record jsonb not null,
  accepted_at timestamptz not null default clock_timestamp(),
  foreign key (run_id,workflow_version_id,relationship_id)
    references run_work_connection_usage(run_id,workflow_version_id,relationship_id) on delete cascade deferrable initially deferred,
  foreign key (run_id,requester_activation_id)
    references run_work_activations(run_id,activation_id) on delete cascade deferrable initially deferred,
  foreign key (run_id,destination_activation_id)
    references run_work_activations(run_id,activation_id) on delete cascade deferrable initially deferred,
  unique (run_id,request_id),
  unique (run_id,workflow_version_id,relationship_id,ordinal),
  unique (run_id,destination_activation_id),
  check (requester_node_id<>destination_node_id),
  check (record->>'requestId' is not distinct from request_id),
  check (record #>> '{scope,runId}' is not distinct from run_id),
  check (record #>> '{scope,workflowVersionId}' is not distinct from workflow_version_id),
  check (record->>'relationshipId' is not distinct from relationship_id),
  check (record->>'requesterActivationId' is not distinct from requester_activation_id),
  check (record->>'requesterExecutionId' is not distinct from requester_execution_id),
  check (record->>'destinationActivationId' is not distinct from destination_activation_id),
  check (record->>'requesterNodeId' is not distinct from requester_node_id),
  check (record->>'destinationNodeId' is not distinct from destination_node_id),
  check (record->>'payloadDigest' is not distinct from payload_digest),
  check (record->'ordinal' is not distinct from to_jsonb(ordinal))
);
create index run_work_requests_activation on run_work_requests(run_id,requester_activation_id,accepted_at,request_id);

create table run_work_returns (
  return_id text primary key,
  run_id text not null,
  request_id text not null,
  source_activation_id text not null,
  source_execution_id text not null references harness_executions(id) on delete cascade deferrable initially deferred,
  requester_continuation_activation_id text,
  result_digest text not null check (result_digest ~ '^sha256:[0-9a-f]{64}$'),
  outcome text not null check (outcome in ('accepted','needs_changes')),
  record jsonb not null,
  returned_at timestamptz not null default clock_timestamp(),
  foreign key (run_id,request_id) references run_work_requests(run_id,request_id) on delete cascade deferrable initially deferred,
  foreign key (run_id,source_activation_id) references run_work_activations(run_id,activation_id) on delete cascade deferrable initially deferred,
  foreign key (run_id,requester_continuation_activation_id) references run_work_activations(run_id,activation_id) on delete cascade deferrable initially deferred,
  unique (run_id,request_id),
  unique (run_id,requester_continuation_activation_id),
  check (record->>'returnId' is not distinct from return_id),
  check (record #>> '{scope,runId}' is not distinct from run_id),
  check (record->>'requestId' is not distinct from request_id),
  check (record->>'sourceActivationId' is not distinct from source_activation_id),
  check (record->>'sourceExecutionId' is not distinct from source_execution_id),
  check (record->>'continuationActivationId' is not distinct from requester_continuation_activation_id),
  check (record->>'acceptedResultDigest' is not distinct from result_digest),
  check (record->>'outcome' is not distinct from outcome),
  check ((outcome='needs_changes') = (requester_continuation_activation_id is not null))
);

create table run_work_denials (
  denial_id text primary key,
  run_id text not null,
  request_id text not null,
  workflow_version_id text not null,
  relationship_id text not null,
  requester_activation_id text not null,
  payload_digest text not null check (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  record jsonb not null,
  denied_at timestamptz not null default clock_timestamp(),
  foreign key (run_id,workflow_version_id,relationship_id)
    references run_work_connection_usage(run_id,workflow_version_id,relationship_id) on delete cascade deferrable initially deferred,
  foreign key (run_id,requester_activation_id)
    references run_work_activations(run_id,activation_id) on delete cascade deferrable initially deferred,
  unique (run_id,request_id),
  check (record->>'denialId' is not distinct from denial_id),
  check (record #>> '{scope,runId}' is not distinct from run_id),
  check (record->>'requestId' is not distinct from request_id),
  check (record->>'relationshipId' is not distinct from relationship_id),
  check (record->>'payloadDigest' is not distinct from payload_digest)
);

-- The old no-occurrence uniqueness remains exact for old Runs. New activations
-- get an independent attempt namespace; they cannot alias a repeat occurrence.
alter table harness_executions add column work_activation_id text;
alter table harness_executions add constraint work_execution_activation_fk
  foreign key (run_id,work_activation_id) references run_work_activations(run_id,activation_id)
  deferrable initially deferred;
alter table harness_executions add constraint work_execution_not_repeat
  check (work_activation_id is null or repeat_occurrence_id is null);
drop index harness_executions_legacy_attempt;
create unique index harness_executions_legacy_attempt on harness_executions(run_id,workflow_node_id,attempt)
  where repeat_occurrence_id is null and work_activation_id is null;
create unique index harness_executions_work_attempt on harness_executions(run_id,work_activation_id,workflow_node_id,attempt)
  where work_activation_id is not null;

create function protect_work_activation_identity() returns trigger language plpgsql as $$
begin
  if new.work_activation_id is distinct from old.work_activation_id then
    raise exception 'WORK_ACTIVATION_IDENTITY_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger work_activation_native_identity before update on harness_executions
  for each row execute function protect_work_activation_identity();

create function assert_work_handoff_scope() returns trigger language plpgsql as $$
declare pinned jsonb; work_edge jsonb; current_usage run_work_connection_usage%rowtype; actual integer;
begin
  if not exists(select 1 from runs where id=new.run_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or pinned #> '{definition,repeat}' is not null then raise exception 'WORK_POLICY_PIN_CONFLICT'; end if;
  if tg_table_name='run_work_activations' then
    if new.workflow_version_id is distinct from pinned->>'id'
      or (select count(*) from jsonb_array_elements(pinned #> '{definition,nodes}') n
        where n->>'id'=new.workflow_node_id)<>1 then raise exception 'WORK_ACTIVATION_SCOPE_CONFLICT'; end if;
  elsif tg_table_name='run_work_connection_usage' then
    select * into strict current_usage from run_work_connection_usage
      where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
    select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
      where e->>'id'=new.relationship_id and e->>'kind'='execution';
    if new.workflow_version_id is distinct from pinned->>'id'
      or current_usage.maximum is distinct from (work_edge->>'maxWorkHandoffsPerRun')::integer then
      raise exception 'WORK_CONNECTION_PIN_CONFLICT'; end if;
    select count(*) into actual from run_work_requests
      where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
    if actual<>current_usage.used then raise exception 'WORK_COUNTER_EVIDENCE_CONFLICT'; end if;
  end if;
  return null;
end $$;
create constraint trigger work_activation_scope after insert or update on run_work_activations
  deferrable initially deferred for each row execute function assert_work_handoff_scope();
create constraint trigger work_usage_scope after insert or update on run_work_connection_usage
  deferrable initially deferred for each row execute function assert_work_handoff_scope();

create function assert_work_request() returns trigger language plpgsql as $$
declare pinned jsonb; work_edge jsonb; current_usage run_work_connection_usage%rowtype;
  source_activation run_work_activations%rowtype; destination_activation run_work_activations%rowtype;
  source_execution harness_executions%rowtype;
begin
  if not exists(select 1 from run_work_requests where request_id=new.request_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or new.workflow_version_id is distinct from pinned->>'id' then raise exception 'WORK_POLICY_PIN_CONFLICT'; end if;
  select * into strict current_usage from run_work_connection_usage
    where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
  select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
    where e->>'id'=new.relationship_id and e->>'kind'='execution';
  if not ((work_edge->>'source'=new.requester_node_id and work_edge->>'target'=new.destination_node_id)
      or (work_edge->>'workRequestDirection'='both' and work_edge->>'target'=new.requester_node_id
        and work_edge->>'source'=new.destination_node_id))
    or new.ordinal>current_usage.used or current_usage.maximum is not null and new.ordinal>current_usage.maximum then
    raise exception 'WORK_REQUEST_ROUTE_OR_QUOTA_CONFLICT'; end if;
  select * into strict source_activation from run_work_activations where activation_id=new.requester_activation_id;
  select * into strict destination_activation from run_work_activations where activation_id=new.destination_activation_id;
  select * into strict source_execution from harness_executions where id=new.requester_execution_id;
  if source_activation.run_id<>new.run_id or source_activation.workflow_node_id<>new.requester_node_id
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.requester_activation_id
    or source_execution.workflow_node_id<>new.requester_node_id or not source_execution.accepted
    or source_execution.record->>'state'<>'completed'
    or destination_activation.run_id<>new.run_id or destination_activation.workflow_node_id<>new.destination_node_id
    or destination_activation.cause_kind<>'work_request' or destination_activation.cause_id<>new.request_id then
    raise exception 'WORK_REQUEST_ANCESTRY_CONFLICT'; end if;
  if (select count(*) from run_work_requests where run_id=new.run_id
      and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id)<>current_usage.used then
    raise exception 'WORK_COUNTER_EVIDENCE_CONFLICT'; end if;
  return null;
end $$;
create constraint trigger work_request_evidence after insert on run_work_requests
  deferrable initially deferred for each row execute function assert_work_request();

create function assert_work_return() returns trigger language plpgsql as $$
declare work_request run_work_requests%rowtype; source_activation run_work_activations%rowtype;
  source_execution harness_executions%rowtype;
  continuation run_work_activations%rowtype;
begin
  if not exists(select 1 from run_work_returns where return_id=new.return_id) then return null; end if;
  select * into strict work_request from run_work_requests where request_id=new.request_id;
  select * into strict source_activation from run_work_activations where activation_id=new.source_activation_id;
  select * into strict source_execution from harness_executions where id=new.source_execution_id;
  if new.run_id<>work_request.run_id or new.source_activation_id<>work_request.destination_activation_id
    or source_activation.workflow_node_id<>work_request.destination_node_id
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.source_activation_id
    or source_execution.workflow_node_id<>work_request.destination_node_id or not source_execution.accepted
    or source_execution.record->>'state'<>'completed'
    or new.record #>> '{scope,workflowVersionId}' is distinct from work_request.workflow_version_id
    or new.record->>'requesterActivationId' is distinct from work_request.requester_activation_id
    or new.record->'latestDeliverable' is null or new.record->'latestDeliverable'='null'::jsonb
    or jsonb_typeof(new.record->'remainingFindings') is distinct from 'array'
    or octet_length(new.record::text)>65536 then raise exception 'WORK_RETURN_ANCESTRY_CONFLICT'; end if;
  if new.outcome='needs_changes' then
    select * into strict continuation from run_work_activations
      where activation_id=new.requester_continuation_activation_id;
    if continuation.run_id<>new.run_id or continuation.workflow_node_id<>work_request.requester_node_id
      or continuation.cause_kind<>'work_return' or continuation.cause_id<>new.return_id then
      raise exception 'WORK_RETURN_CONTINUATION_CONFLICT'; end if;
  end if;
  return null;
end $$;
create constraint trigger work_return_evidence after insert on run_work_returns
  deferrable initially deferred for each row execute function assert_work_return();

create function assert_work_denial() returns trigger language plpgsql as $$
declare usage run_work_connection_usage%rowtype; pinned jsonb; work_edge jsonb;
  source_activation run_work_activations%rowtype;
begin
  if not exists(select 1 from run_work_denials where denial_id=new.denial_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  select * into strict usage from run_work_connection_usage
    where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
  select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
    where e->>'id'=new.relationship_id and e->>'kind'='execution';
  select * into strict source_activation from run_work_activations where activation_id=new.requester_activation_id;
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or usage.maximum is null or usage.used<>usage.maximum
    or new.record->'used' is distinct from to_jsonb(usage.used)
    or new.record->'maxWorkHandoffsPerRun' is distinct from to_jsonb(usage.maximum)
    or new.workflow_version_id<>pinned->>'id' or source_activation.run_id<>new.run_id
    or new.record->>'requesterActivationId' is distinct from new.requester_activation_id
    or new.record->>'destinationNodeId' is distinct from
      (case when work_edge->>'source'=source_activation.workflow_node_id then work_edge->>'target'
        when work_edge->>'workRequestDirection'='both' and work_edge->>'target'=source_activation.workflow_node_id
          then work_edge->>'source' else null end)
    or exists(select 1 from run_work_requests where request_id=new.request_id) then
    raise exception 'WORK_DENIAL_ANCESTRY_CONFLICT'; end if;
  return null;
end $$;
create constraint trigger work_denial_evidence after insert on run_work_denials
  deferrable initially deferred for each row execute function assert_work_denial();

create function assert_work_native_activation() returns trigger language plpgsql as $$
declare pinned jsonb; activation run_work_activations%rowtype; semantics smallint;
begin
  if not exists(select 1 from harness_executions where id=new.id) then return null; end if;
  select v.execution_semantics_version into strict semantics from runs r
    join workflow_versions v on v.id=r.workflow_version_id where r.id=new.run_id;
  if semantics<>3 then
    if new.work_activation_id is not null then raise exception 'WORK_ACTIVATION_ON_OLD_RUN'; end if;
    return null;
  end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb then
    if new.work_activation_id is not null then raise exception 'WORK_ACTIVATION_ON_OLD_RUN'; end if;
    return null;
  end if;
  if new.work_activation_id is null or new.repeat_occurrence_id is not null then
    raise exception 'WORK_NATIVE_ACTIVATION_REQUIRED'; end if;
  select * into strict activation from run_work_activations where activation_id=new.work_activation_id;
  if activation.run_id<>new.run_id or activation.workflow_node_id<>new.workflow_node_id
    or activation.workflow_version_id<>pinned->>'id' then raise exception 'WORK_NATIVE_ACTIVATION_CONFLICT'; end if;
  return null;
end $$;
create constraint trigger work_native_activation after insert or update on harness_executions
  deferrable initially deferred for each row execute function assert_work_native_activation();
` } as const
