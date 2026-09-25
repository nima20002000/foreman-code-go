/** ENG-04-A proposal. SHELL allocates/registers the migration number and enables
 * semantics 3 separately. No historical JSON, IDs, inputs, checkpoints or results
 * are rewritten. Run in the registry's ordinary transaction, never piecemeal. */
export const repeatOccurrenceMigrationSql = String.raw`
create table run_repeat_occurrences (
  occurrence_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  workspace_id text not null references workspaces(id),
  workflow_id text not null references workflows(id),
  workflow_version_id text not null references workflow_versions(id),
  block_id text not null,
  occurrence_index integer not null check (occurrence_index > 0),
  binding_id text not null unique,
  input_json text not null check (octet_length(input_json) <= 4194304),
  input_digest text not null check (input_digest = 'sha256:' || encode(sha256(convert_to(input_json,'UTF8')),'hex')),
  previous_occurrence_id text,
  previous_occurrence_index integer,
  previous_decision_id text,
  previous_result_digest text,
  record jsonb not null,
  unique (run_id,workflow_version_id,block_id,occurrence_index),
  unique (occurrence_id,run_id),
  unique (occurrence_id,run_id,workflow_version_id,block_id,occurrence_index),
  foreign key (previous_occurrence_id,run_id,workflow_version_id,block_id,previous_occurrence_index)
    references run_repeat_occurrences(occurrence_id,run_id,workflow_version_id,block_id,occurrence_index) deferrable initially deferred,
  check ((occurrence_index=1 and previous_occurrence_id is null and previous_occurrence_index is null
    and previous_decision_id is null and previous_result_digest is null)
    or (occurrence_index>1 and previous_occurrence_id is not null and previous_occurrence_index=occurrence_index-1
    and previous_decision_id is not null and previous_result_digest is not null)),
  check ((record #>> '{identity,occurrenceId}') is not distinct from occurrence_id),
  check ((record #>> '{identity,scope,runId}') is not distinct from run_id),
  check ((record #>> '{identity,scope,workflowVersionId}') is not distinct from workflow_version_id),
  check ((record #>> '{identity,scope,workspaceId}') is not distinct from workspace_id),
  check ((record #>> '{identity,scope,workflowId}') is not distinct from workflow_id),
  check ((record #>> '{identity,scope,executionSemanticsVersion}') is not distinct from '3'),
  check ((record #>> '{identity,blockId}') is not distinct from block_id),
  check ((record #>> '{identity,occurrenceIndex}')::integer is not distinct from occurrence_index),
  check ((record #>> '{input,previous,occurrenceId}') is not distinct from previous_occurrence_id),
  check ((record #>> '{input,previous,occurrenceIndex}')::integer is not distinct from previous_occurrence_index),
  check ((record #>> '{input,previous,decisionId}') is not distinct from previous_decision_id),
  check ((record #>> '{input,previous,acceptedResultDigest}') is not distinct from previous_result_digest),
  check ((record #>> '{input,inputDigest}') is not distinct from input_digest),
  check ((record #>> '{input,bindingId}') is not distinct from binding_id)
);
create index run_repeat_occurrences_head on run_repeat_occurrences
  (run_id,block_id,occurrence_index desc);

-- Keep the old uniqueness on every legacy/outside row. The trigger below
-- forbids using the new column to evade semantics-1/2 uniqueness.
do $$ begin
  if not exists (select 1 from pg_constraint
    where conrelid='harness_executions'::regclass and contype='u'
    and conname='harness_executions_run_id_workflow_node_id_attempt_key'
    and pg_get_constraintdef(oid)='UNIQUE (run_id, workflow_node_id, attempt)') then
    raise exception 'REPEAT_LEGACY_UNIQUENESS_DRIFT';
  end if;
end $$;
alter table harness_executions add column repeat_occurrence_id text;
alter table harness_executions add constraint repeat_execution_occurrence_fk
  foreign key (repeat_occurrence_id,run_id) references run_repeat_occurrences(occurrence_id,run_id) deferrable initially deferred;
alter table harness_executions drop constraint harness_executions_run_id_workflow_node_id_attempt_key;
create unique index harness_executions_legacy_attempt on harness_executions
  (run_id,workflow_node_id,attempt) where repeat_occurrence_id is null;
create unique index harness_executions_repeat_attempt on harness_executions
  (run_id,repeat_occurrence_id,workflow_node_id,attempt) where repeat_occurrence_id is not null;

create table run_repeat_slots (
  slot_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  occurrence_id text,
  workflow_node_id text not null,
  input_json text not null check (octet_length(input_json)<=4194304),
  input_digest text not null check (input_digest = 'sha256:' || encode(sha256(convert_to(input_json,'UTF8')),'hex')),
  foreign key (occurrence_id,run_id) references run_repeat_occurrences(occurrence_id,run_id) deferrable initially deferred,
  occurrence_key text generated always as (coalesce(occurrence_id,'')) stored,
  unique (slot_id,run_id), unique (slot_id,input_digest),
  unique (slot_id,run_id,occurrence_key,workflow_node_id)
);
create unique index run_repeat_slots_outside on run_repeat_slots(run_id,workflow_node_id) where occurrence_id is null;
create unique index run_repeat_slots_occurrence on run_repeat_slots(occurrence_id,workflow_node_id) where occurrence_id is not null;
create table run_repeat_executions (
  execution_id text primary key references harness_executions(id) on delete cascade,
  run_id text not null references runs(id) on delete cascade,
  slot_id text not null,
  occurrence_id text,
  technical_attempt integer not null check (technical_attempt>0),
  previous_execution_id text unique,
  previous_technical_attempt integer generated always as (case when technical_attempt>1 then technical_attempt-1 end) stored,
  identity jsonb not null,
  occurrence_key text generated always as (coalesce(occurrence_id,'')) stored,
  workflow_node_id text generated always as (identity->>'workflowNodeId') stored not null,
  foreign key (slot_id,run_id,occurrence_key,workflow_node_id)
    references run_repeat_slots(slot_id,run_id,occurrence_key,workflow_node_id) deferrable initially deferred,
  foreign key (occurrence_id,run_id) references run_repeat_occurrences(occurrence_id,run_id) deferrable initially deferred,
  unique (slot_id,technical_attempt), unique (execution_id,run_id), unique (execution_id,occurrence_id),
  unique (execution_id,slot_id,technical_attempt), unique (execution_id,slot_id,run_id),
  foreign key (previous_execution_id,slot_id,previous_technical_attempt)
    references run_repeat_executions(execution_id,slot_id,technical_attempt) deferrable initially deferred,
  check ((technical_attempt=1) = (previous_execution_id is null)),
  check ((identity->>'executionId') is not distinct from execution_id),
  check ((identity->>'attempt')::integer is not distinct from technical_attempt)
);
create table run_repeat_results (
  execution_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  occurrence_id text,
  result_json text not null check (octet_length(result_json)<=65536),
  result_digest text not null check (result_digest = 'sha256:' || encode(sha256(convert_to(result_json,'UTF8')),'hex')),
  accepted_at timestamptz not null,
  foreign key (execution_id,run_id) references run_repeat_executions(execution_id,run_id) deferrable initially deferred,
  foreign key (execution_id,occurrence_id) references run_repeat_executions(execution_id,occurrence_id) deferrable initially deferred,
  unique (execution_id,result_digest), unique (run_id,execution_id,result_digest),
  unique (execution_id,occurrence_id,result_digest),
  check ((result_json::jsonb->>'outcome') is not distinct from 'succeeded')
);
create table run_repeat_bindings (
  binding_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  recipient_execution_id text not null,
  source_execution_id text not null,
  source_result_digest text not null,
  input_digest text not null,
  slot_id text not null,
  ordinal integer not null check (ordinal>=0 and ordinal<16001),
  record jsonb not null,
  foreign key (recipient_execution_id,slot_id,run_id) references run_repeat_executions(execution_id,slot_id,run_id) deferrable initially deferred,
  foreign key (run_id,source_execution_id,source_result_digest) references run_repeat_results(run_id,execution_id,result_digest) deferrable initially deferred,
  foreign key (slot_id,input_digest) references run_repeat_slots(slot_id,input_digest) deferrable initially deferred,
  unique (recipient_execution_id,ordinal), check (recipient_execution_id<>source_execution_id),
  check ((record->>'bindingId') is not distinct from binding_id),
  check ((record->>'inputDigest') is not distinct from input_digest),
  check ((record->>'ordinal')::integer is not distinct from ordinal),
  check ((record #>> '{recipient,executionId}') is not distinct from recipient_execution_id),
  check ((record #>> '{source,execution,executionId}') is not distinct from source_execution_id),
  check ((record #>> '{source,acceptedResultDigest}') is not distinct from source_result_digest)
);
create table run_repeat_resolutions (
  run_id text not null references runs(id) on delete cascade,
  -- Empty string is the outside graph namespace, NOT a business occurrence.
  occurrence_key text not null,
  workflow_node_id text not null,
  source_occurrence_id text,
  execution_id text,
  record jsonb not null,
  primary key (run_id,occurrence_key,workflow_node_id),
  foreign key (source_occurrence_id,run_id) references run_repeat_occurrences(occurrence_id,run_id) deferrable initially deferred,
  foreign key (execution_id,run_id) references run_repeat_executions(execution_id,run_id) deferrable initially deferred,
  check (occurrence_key='' or occurrence_key=source_occurrence_id),
  check ((record #>> '{value,workflowNodeId}') is not distinct from workflow_node_id),
  check ((record #>> '{ref,nodeId}') is not distinct from workflow_node_id),
  check ((record #>> '{ref,occurrence,occurrenceId}') is not distinct from source_occurrence_id),
  check ((record #>> '{value,execution,executionId}') is not distinct from execution_id)
);
create table run_repeat_decisions (
  decision_id text primary key,
  occurrence_id text not null unique references run_repeat_occurrences(occurrence_id) on delete cascade,
  exit_execution_id text not null,
  result_digest text not null,
  record jsonb not null,
  foreign key (exit_execution_id,occurrence_id,result_digest) references run_repeat_results(execution_id,occurrence_id,result_digest) deferrable initially deferred,
  unique (decision_id,occurrence_id,result_digest),
  check ((record->>'decisionId') is not distinct from decision_id),
  check ((record #>> '{occurrence,identity,occurrenceId}') is not distinct from occurrence_id),
  check ((record #>> '{exitExecution,occurrence,occurrenceId}') is not distinct from occurrence_id),
  check ((record->>'acceptedResultDigest') is not distinct from result_digest),
  check ((record #>> '{exitExecution,executionId}') is not distinct from exit_execution_id)
);
alter table run_repeat_occurrences add constraint repeat_predecessor_decision_fk
  foreign key (previous_decision_id,previous_occurrence_id,previous_result_digest)
  references run_repeat_decisions(decision_id,occurrence_id,result_digest) deferrable initially deferred;
create table run_repeat_effects (
  run_id text not null references runs(id) on delete cascade,
  effect_kind text not null check (effect_kind in ('occurrence.create','input.bind','terminal.accept','node.inactive','run.complete')),
  entity_id text not null,
  payload_digest text not null check (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  owner_id text not null,
  owner_fence text not null,
  primary key (run_id,effect_kind,entity_id)
);

create function assert_repeat_occurrence_scope() returns trigger language plpgsql as $$
declare pinned jsonb; block jsonb; parent_run runs%rowtype;
begin
  select * into strict parent_run from runs where id=new.run_id;
  select record into strict pinned from workflow_versions where id=parent_run.workflow_version_id;
  if coalesce((pinned->>'executionSemanticsVersion')::integer,1)<>3
    or parent_run.workspace_id<>new.workspace_id or parent_run.workflow_id<>new.workflow_id
    or parent_run.workflow_version_id<>new.workflow_version_id then raise exception 'REPEAT_SCOPE_CONFLICT'; end if;
  select value into strict block from jsonb_array_elements(pinned #> '{definition,repeat,blocks}')
    where value->>'id'=new.block_id;
  if new.occurrence_index>(block->>'maxOccurrences')::integer then raise exception 'REPEAT_LIMIT_EXCEEDED'; end if;
  return new;
end $$;
create trigger repeat_occurrence_scope before insert on run_repeat_occurrences
  for each row execute function assert_repeat_occurrence_scope();

create function assert_repeat_execution_scope() returns trigger language plpgsql as $$
declare pinned jsonb; block jsonb; occ run_repeat_occurrences%rowtype;
begin
  if tg_op='UPDATE' and new.repeat_occurrence_id is distinct from old.repeat_occurrence_id then
    raise exception 'REPEAT_EXECUTION_IDENTITY_IMMUTABLE'; end if;
  select v.record into strict pinned from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=new.run_id;
  if new.repeat_occurrence_id is null and coalesce((pinned->>'executionSemanticsVersion')::integer,1)=3
    and exists (select 1 from jsonb_array_elements(pinned #> '{definition,repeat,blocks}') b where b->'nodeIds' ? new.workflow_node_id) then
    raise exception 'REPEAT_OCCURRENCE_REQUIRED';
  end if;
  if new.repeat_occurrence_id is not null then
    select * into strict occ from run_repeat_occurrences where occurrence_id=new.repeat_occurrence_id;
    select v.record into strict pinned from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=new.run_id;
    select value into strict block from jsonb_array_elements(pinned #> '{definition,repeat,blocks}') where value->>'id'=occ.block_id;
    if occ.run_id<>new.run_id or coalesce((pinned->>'executionSemanticsVersion')::integer,1)<>3
      or not (block->'nodeIds' ? new.workflow_node_id) then raise exception 'REPEAT_EXECUTION_SCOPE_CONFLICT'; end if;
  end if;
  return new;
end $$;
create trigger repeat_execution_scope before insert or update of repeat_occurrence_id,run_id,workflow_node_id on harness_executions
  for each row execute function assert_repeat_execution_scope();

-- Append-only evidence. Run-scoped retention deletion is checked at COMMIT;
-- it must remove the whole dependent Run, never splice historical occurrences.
create function reject_repeat_evidence_update() returns trigger language plpgsql as $$
begin raise exception 'REPEAT_IMMUTABLE_EVIDENCE'; end $$;
do $$ declare name text; begin
  foreach name in array array['run_repeat_occurrences','run_repeat_slots','run_repeat_executions','run_repeat_results',
    'run_repeat_bindings','run_repeat_resolutions','run_repeat_decisions','run_repeat_effects'] loop
    execute format('create trigger repeat_no_update before update on %I for each row execute function reject_repeat_evidence_update()',name);
  end loop;
end $$;
`
