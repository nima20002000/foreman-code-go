--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: langgraph; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA langgraph;


--
-- Name: a2_entry_committed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.a2_entry_committed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare item record; kind text;
begin
  if TG_TABLE_NAME='workflow_native_entries' then
    select e.phase,e.run_id,e.source_id,1::bigint as source_revision,e.source_digest into item
      from workflow_native_entries e where e.execution_id=NEW.execution_id;
    kind:='execution';
  else
    select e.phase,e.run_id,e.source_id,e.source_revision,e.source_digest into item
      from review_native_entries e where e.job_id=NEW.job_id;
    kind:=case when item.phase='not_submitted' then 'cleanup' else 'review' end;
  end if;
  if item.phase<>'reserved' and not exists(select 1 from run_graph_sources s join run_graph_heads h on h.run_id=s.run_id
    where s.run_id=item.run_id and s.source_kind=kind and s.source_id=item.source_id and s.source_revision=item.source_revision
      and s.source_digest=item.source_digest and s.first_sequence between 1 and h.head_sequence) then
    raise exception 'CURRENT_NATIVE_ENTRY_RECEIPT_REQUIRED' using errcode='P2602';
  end if;
  return NEW;
end $$;


--
-- Name: a2_native_entry_monotonic(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.a2_native_entry_monotonic() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if TG_OP<>'UPDATE' then raise exception 'CURRENT_NATIVE_ENTRY_IMMUTABLE' using errcode='P2602'; end if;
  if TG_TABLE_NAME='workflow_native_entries' then
    if (to_jsonb(NEW)-array['phase','transition','source_id','source_digest'])
        is distinct from (to_jsonb(OLD)-array['phase','transition','source_id','source_digest'])
      or not ((OLD.phase='reserved' and NEW.phase in ('prepared','not_submitted'))
        or (OLD.phase='prepared' and NEW.phase in ('entered','not_submitted'))) then
      raise exception 'CURRENT_NATIVE_ENTRY_IMMUTABLE' using errcode='P2602';
    end if;
  else
    if (to_jsonb(NEW)-array['phase','entry_proof_id','source_id','source_revision','source_digest'])
        is distinct from (to_jsonb(OLD)-array['phase','entry_proof_id','source_id','source_revision','source_digest'])
      or OLD.phase<>'reserved' or NEW.phase not in ('entered','not_submitted') then
      raise exception 'CURRENT_NATIVE_ENTRY_IMMUTABLE' using errcode='P2602';
    end if;
  end if;
  return NEW;
end $$;


--
-- Name: a2_native_record_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.a2_native_record_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'CURRENT_NATIVE_RECORD_IMMUTABLE' using errcode='P2602'; end $$;


--
-- Name: a2_proof_committed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.a2_proof_committed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare current_row jsonb; r_id text; p_id text; digest text;
begin
  -- Deferred to canonical G1's finalizer. A fixture row without its actual
  -- source publication is not durable positive native proof.
  if TG_TABLE_NAME in ('workflow_native_proofs','review_native_proofs') then
    r_id:=NEW.run_id; p_id:=NEW.proof_id; digest:=NEW.source_digest;
    if not exists(select 1 from harness_executions e join runs r on r.id=e.run_id
      join workflow_versions v on v.id=r.workflow_version_id where e.id=NEW.execution_id and e.run_id=r_id
      and v.execution_semantics_version=3 and r.record->'executionSemanticsVersion'='3'::jsonb
      and NEW.record#>>'{scope,workflowVersionId}'=r.workflow_version_id
      and NEW.record#>>'{scope,workspaceId}'=r.workspace_id and NEW.record#>>'{scope,workflowId}'=r.workflow_id) then
      raise exception 'CURRENT_NATIVE_PROOF_PIN_CONFLICT' using errcode='P2602';
    end if;
    -- Use a nested branch: workflow proof rows have no job_id field. Do not
    -- rely on SQL AND evaluation order for a polymorphic trigger record.
    if TG_TABLE_NAME='review_native_proofs' then
      if not exists(select 1 from review_jobs j where j.id=NEW.job_id
        and j.execution_id=NEW.execution_id and j.interaction_id=NEW.record#>>'{job,interactionId}'
        and j.reviewer_agent_id=NEW.record#>>'{job,reviewerAgentId}') then
        raise exception 'CURRENT_REVIEW_PROOF_PIN_CONFLICT' using errcode='P2602';
      end if;
    end if;
    if not exists(select 1 from run_graph_sources s join run_graph_heads h on h.run_id=s.run_id
      where s.run_id=r_id and s.source_kind='native_event' and s.source_id=p_id and s.source_revision=1
        and s.source_digest=digest and s.first_sequence between 1 and h.head_sequence) then
      raise exception 'CURRENT_NATIVE_RECEIPT_REQUIRED' using errcode='P2602';
    end if;
  end if;
  return NEW;
end $$;


--
-- Name: a2_public_projection_committed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.a2_public_projection_committed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare item run_graph_public_projection%rowtype;
begin
  select * into item from run_graph_public_projection where run_id=NEW.run_id;
  if not exists(select 1 from run_graph_sources s join run_graph_heads h on h.run_id=s.run_id
    where s.run_id=item.run_id and s.source_kind='run' and s.source_id=item.source_id and s.source_revision=item.sequence
      and s.source_digest=item.source_digest and s.semantic_digest=item.semantic_digest
      and s.first_sequence=item.sequence and item.sequence<=h.head_sequence) then
    raise exception 'CURRENT_PUBLIC_PROJECTION_RECEIPT_REQUIRED' using errcode='P2602';
  end if;
  return NEW;
end $$;


--
-- Name: a2_stop_intent_committed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.a2_stop_intent_committed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists(select 1 from runs r where r.id=NEW.run_id and r.workspace_id=NEW.workspace_id
    and r.record->'executionSemanticsVersion'='3'::jsonb
    and ((NEW.record#>>'{receipt,status}'='accepted' and r.stop_requested_at is not null)
      or (NEW.record#>>'{receipt,status}'='already_terminal' and r.execution_state='completed')))
    or not exists(select 1 from run_graph_sources s join run_graph_heads h on h.run_id=s.run_id
      where s.run_id=NEW.run_id and s.source_kind='cleanup' and s.source_id=NEW.source_id
        and s.source_revision=1 and s.source_digest=NEW.source_digest
        and s.first_sequence between 1 and h.head_sequence) then
    raise exception 'CURRENT_STOP_INTENT_RECEIPT_REQUIRED' using errcode='P2602';
  end if;
  return NEW;
end $$;


--
-- Name: advance_activity_record_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.advance_activity_record_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if (to_jsonb(new)-'activity_record_revision'-'text_provenance') is distinct from (to_jsonb(old)-'activity_record_revision'-'text_provenance') then
        new.activity_record_revision := old.activity_record_revision+1;
      else new.activity_record_revision := old.activity_record_revision; end if;
      return new;
    end $$;


--
-- Name: advance_ci_activity_record_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.advance_ci_activity_record_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    NEW.activity_record_revision := OLD.activity_record_revision;
    -- Compare fields directly so a log refresh does not serialize stored test results.
    if NEW.log_tail is distinct from OLD.log_tail or NEW is distinct from OLD then
      NEW.activity_record_revision := OLD.activity_record_revision+1;
    end if;
    return NEW;
  end $$;


--
-- Name: append_harness_native_event(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.append_harness_native_event(p_event jsonb) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
    declare
      v_execution_id text := p_event->>'executionId';
      v_connection_id text := p_event->>'connectionId';
      v_source_sequence integer := (p_event->>'sequence')::integer;
      v_sequence integer;
      v_run_id text;
      v_existing jsonb;
      v_record jsonb;
    begin
      if v_execution_id is null or v_source_sequence is null or v_source_sequence < 0 then
        raise exception using errcode='22023', message='Invalid native event identity.';
      end if;

      select e.run_id into v_run_id from harness_executions e
        where e.id=v_execution_id for update;
      if not found then
        raise exception using errcode='23503', message='The native event execution does not exist.';
      end if;

      if v_connection_id is not null then
        select n.record into v_existing from harness_native_events n
          where n.execution_id=v_execution_id and n.connection_id=v_connection_id
            and n.source_sequence=v_source_sequence;
        if found then
          if (v_existing - 'sequence') is distinct from (p_event - 'sequence') then
            raise exception using errcode='PNE01', message='Native event identity conflicts with stored history.';
          end if;
          -- Exact source replay is a no-op, including the durable allocator.
          return false;
        end if;
        update harness_executions set native_event_next_sequence=native_event_next_sequence+1
          where id=v_execution_id returning (native_event_next_sequence-1)::integer into v_sequence;
        v_record := jsonb_set(p_event, '{sequence}', to_jsonb(v_sequence));
      else
        -- Pre-connection history uses its original execution sequence as identity.
        -- Keep its replay and conflict rules; never overwrite or renumber it.
        select n.record into v_existing from harness_native_events n
          where n.execution_id=v_execution_id and n.sequence=v_source_sequence;
        if found then
          if v_existing is distinct from p_event then
            raise exception using errcode='PNE01', message='Native event identity conflicts with stored history.';
          end if;
          return false;
        end if;
        v_sequence := v_source_sequence;
        v_record := p_event;
        update harness_executions set native_event_next_sequence=greatest(native_event_next_sequence, v_sequence::bigint+1)
          where id=v_execution_id;
      end if;

      insert into harness_native_events(execution_id,sequence,record,connection_id,source_sequence)
        values (v_execution_id,v_sequence,v_record,v_connection_id,
          case when v_connection_id is not null then v_source_sequence end);
      -- Stream deltas and token/rate-limit bookkeeping stay native evidence only. Their item's
      -- started/completed events carry the Activity; one row per chunk buried every Run's history.
      if coalesce(p_event#>>'{payload,nativeMethod}',p_event#>>'{payload,method}','') not in (
        'item/agentMessage/delta','item/commandExecution/outputDelta','item/fileChange/outputDelta',
        'item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded',
        'item/mcpToolCall/progress','thread/tokenUsage/updated','account/rateLimits/updated') then
        insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
          values (v_run_id,'harness','harness_output',v_execution_id,(p_event->>'occurredAt')::timestamptz,
            jsonb_build_object('nativeEventSequence',v_sequence,'nativeEventType',p_event->>'type'));
      end if;
      return true;
    end $$;


--
-- Name: artifact_edge_fact_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.artifact_edge_fact_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'Artifact edge pins and read provenance are append-only.';
end $$;


--
-- Name: assert_execution_dispatch_complete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_execution_dispatch_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
 if exists(select 1 from run_node_placements p where p.run_id=NEW.run_id and p.node_id=NEW.workflow_node_id)
   and not exists(select 1 from execution_dispatch_intents d where d.execution_id=NEW.id) then
   raise exception 'EXECUTION_DISPATCH_EVIDENCE_MISSING' using errcode='P2844';
 end if;
 return NEW;
end $$;


--
-- Name: assert_frozen_work_notice(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_frozen_work_notice(input_notice jsonb, current_notice jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  if input_notice is null or current_notice is null
    or (input_notice - array['delivery','acknowledgementId','updatedAt'])
      is distinct from (current_notice - array['delivery','acknowledgementId','updatedAt'])
    or input_notice->>'delivery'<>'queued'
    or input_notice->>'acknowledgementId' is not null
    or input_notice->>'updatedAt' is distinct from current_notice->>'createdAt' then
    raise exception 'WORK_NOTICE_INPUT_CONFLICT'; end if;
end $$;


--
-- Name: assert_repeat_accepted_result(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_accepted_result() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare native harness_executions%rowtype;
  job_record jsonb; result jsonb; data jsonb;
begin

  if exists(select 1 from run_repeat_executions x where x.execution_id=new.execution_id and x.executor_kind='job') then
    select j.record into strict job_record from job_executions j where j.id=new.execution_id;
    result:=new.result_json::jsonb; data:=coalesce(result #> '{output,data}',result->'output');
    if job_record #>> '{workflow,runId}' is distinct from new.run_id
      or job_record #>> '{process,phase}' is distinct from 'terminal' or job_record #> '{process,processStopped}' is distinct from 'true'::jsonb
      or job_record->>'publication' not in ('complete','failed','expired') or result->>'outcome' is distinct from 'succeeded'
      or data #>> '{latestDeliverable,jobExecutionId}' is distinct from new.execution_id
      or data #> '{latestDeliverable,process}' is distinct from jsonb_build_object('outcome',job_record #>> '{process,outcome}','exitCode',job_record #> '{process,exitCode}','signal',job_record #> '{process,signal}')
      or not exists(select 1 from workflow_job_executions w where w.run_id=new.run_id and w.job_execution_id=new.execution_id and w.accepted)
      then raise exception 'JOB_WORKFLOW_RESULT_NOT_ACCEPTED'; end if;
    return null;
  end if;

  if not exists(select 1 from run_repeat_results where execution_id=new.execution_id) then return null; end if;
  select * into strict native from harness_executions where id=new.execution_id;
  if native.run_id<>new.run_id or native.repeat_occurrence_id is distinct from new.occurrence_id
    or not native.accepted or native.record->>'state' is distinct from 'completed'
    or native.record->'result' is distinct from new.result_json::jsonb then raise exception 'REPEAT_RESULT_NOT_ACCEPTED'; end if;
  return null;
end $$;


--
-- Name: assert_repeat_binding(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare recipient run_repeat_executions%rowtype; source run_repeat_executions%rowtype;
  slot_input jsonb; pinned jsonb; edge jsonb; expected_source jsonb; expected_kind text; n integer; entry jsonb;
begin
  if not exists(select 1 from run_repeat_bindings where binding_id=new.binding_id) then return null; end if;
  select * into strict recipient from run_repeat_executions where execution_id=new.recipient_execution_id;
  select * into strict source from run_repeat_executions where execution_id=new.source_execution_id;
  select input_json::jsonb into strict slot_input from run_repeat_slots where slot_id=new.slot_id;
  n := jsonb_array_length(slot_input->'predecessors');
  entry := slot_input->'entry';
  if new.ordinal<n then expected_kind := 'predecessor'; expected_source := slot_input->'predecessors'->new.ordinal;
  elsif entry is not null and entry<>'null'::jsonb and new.ordinal-n<jsonb_array_length(entry->'external') then
    expected_kind := 'external'; expected_source := entry->'external'->(new.ordinal-n);
  elsif entry is not null and entry<>'null'::jsonb and new.ordinal=n+jsonb_array_length(entry->'external') then
    expected_kind := 'carry'; expected_source := entry->'carry';
  else raise exception 'REPEAT_BINDING_ORDINAL_CONFLICT'; end if;
  if new.record->>'kind' is distinct from expected_kind or expected_source is null or expected_source='null'::jsonb
    or new.record->'source' is distinct from expected_source
    or new.record->'recipient' is distinct from recipient.identity-'occurrence'
    or new.record->'recipientOccurrence' is distinct from coalesce(recipient.identity->'occurrence','null'::jsonb)
    or new.record #> '{source,acceptedResult}' is distinct from (select result_json::jsonb from run_repeat_results where execution_id=source.execution_id) then
    raise exception 'REPEAT_BINDING_IDENTITY_CONFLICT';
  end if;
  if expected_kind='carry' then
    if new.record #> '{source,execution}' is distinct from source.identity then raise exception 'REPEAT_CARRY_CONFLICT'; end if;
    -- The occurrence and slot checks already bind this exact carry to the
    -- preceding same-block decision, not an arbitrary successful body result.
  else
    if new.record #> '{source,execution}' is distinct from source.identity-'occurrence'
      or new.record #> '{source,occurrence}' is distinct from coalesce(source.identity->'occurrence','null'::jsonb) then
      raise exception 'REPEAT_BINDING_IDENTITY_CONFLICT';
    end if;
    pinned := repeat_pinned_version(new.run_id);
    select value into strict edge from jsonb_array_elements(pinned #> '{definition,edges}')
      where value->>'id'=new.record #>> '{source,relationshipId}';
    if edge->>'kind' is distinct from 'execution' or edge->>'source' is distinct from source.workflow_node_id
      or edge->>'target' is distinct from recipient.workflow_node_id then raise exception 'REPEAT_BINDING_EDGE_CONFLICT'; end if;
    if expected_kind='predecessor' and recipient.occurrence_id is not null
      and source.occurrence_id is distinct from recipient.occurrence_id then raise exception 'REPEAT_CROSS_OCCURRENCE_JOIN'; end if;
    if expected_kind='external' and source.occurrence_id is not distinct from recipient.occurrence_id then
      raise exception 'REPEAT_EXTERNAL_SOURCE_CONFLICT';
    end if;
    if source.occurrence_id is not null and source.occurrence_id is distinct from recipient.occurrence_id
      and not exists(select 1 from run_repeat_resolutions r where r.run_id=new.run_id and r.occurrence_key=''
        and r.workflow_node_id=source.workflow_node_id and r.source_occurrence_id=source.occurrence_id and r.execution_id=source.execution_id) then
      raise exception 'REPEAT_EGRESS_UNRESOLVED';
    end if;
  end if;
  return null;
end $$;


--
-- Name: assert_repeat_decision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_decision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare occ run_repeat_occurrences%rowtype; execution run_repeat_executions%rowtype;
  pinned jsonb; block jsonb; exit_node jsonb; accepted jsonb; envelope jsonb; outcome text;
  reason text; target jsonb; declaration jsonb; member text;
begin
  if not exists(select 1 from run_repeat_decisions where decision_id=new.decision_id) then return null; end if;
  select * into strict occ from run_repeat_occurrences where occurrence_id=new.occurrence_id;
  pinned := repeat_pinned_version(occ.run_id); block := repeat_saved_block(pinned,occ.block_id);
  select * into strict execution from run_repeat_executions where execution_id=new.exit_execution_id;
  select result_json::jsonb into strict accepted from run_repeat_results where execution_id=new.exit_execution_id;
  select value into strict exit_node from jsonb_array_elements(pinned #> '{definition,nodes}') where value->>'id'=block->>'exitNodeId';
  -- Parsing-only view, exactly as the pinned parseRepeatExitResultV1: direct
  -- object, entire JSON string, or the exact single-key native {text} carrier.
  -- Original result text/digest/carry remain untouched.
  envelope := accepted->'output';
  if jsonb_typeof(envelope)='object' and envelope-'text'='{}'::jsonb and jsonb_typeof(envelope->'text')='string' then
    envelope := (envelope->>'text')::jsonb;
  elsif jsonb_typeof(envelope)='string' then envelope := (envelope #>> '{}')::jsonb; end if;
  if jsonb_typeof(envelope) is distinct from 'object' or envelope-array['routing','data']<>'{}'::jsonb
    or jsonb_typeof(envelope->'routing') is distinct from 'object' or (envelope->'routing')-'outcome'<>'{}'::jsonb
    or jsonb_typeof(envelope #> '{routing,outcome}') is distinct from 'string'
    or jsonb_typeof(envelope->'data') is distinct from 'object'
    or (envelope->'data')-array['latestDeliverable','remainingFindings']<>'{}'::jsonb
    or envelope #> '{data,latestDeliverable}' is null or envelope #> '{data,latestDeliverable}'='null'::jsonb
    or jsonb_typeof(envelope #> '{data,remainingFindings}') is distinct from 'array' then raise exception 'REPEAT_EXIT_ENVELOPE_INVALID'; end if;
  outcome := envelope #>> '{routing,outcome}';
  if outcome not in (block->>'earlyExitOutcome',block->>'repeatOutcome') then raise exception 'REPEAT_OUTCOME_UNDECLARED'; end if;
  if jsonb_array_length(exit_node #> '{choice,outcomes}') is distinct from 2 then raise exception 'REPEAT_EXIT_CHOICE_INVALID'; end if;
  select value into strict declaration from jsonb_array_elements(exit_node #> '{choice,outcomes}') where value->>'outcome'=block->>'repeatOutcome';
  if declaration->'target' is distinct from block->'limitExit' then raise exception 'REPEAT_LIMIT_ROUTE_CONFLICT'; end if;
  select value into strict declaration from jsonb_array_elements(exit_node #> '{choice,outcomes}') where value->>'outcome'=outcome;
  reason := case when outcome=block->>'earlyExitOutcome' then 'early_exit'
    when occ.occurrence_index=(block->>'maxOccurrences')::integer then 'limit_exit' else 'repeat' end;
  target := case when reason='early_exit' then declaration->'target' when reason='limit_exit' then block->'limitExit'
    else jsonb_build_object('kind','next_occurrence','entryNodeId',block->>'entryNodeId','occurrenceIndex',occ.occurrence_index+1) end;
  if reason<>'repeat' then
    if ((target=jsonb_build_object('kind','branch_end')) or
      (target->>'kind'='edge' and target=jsonb_build_object('kind','edge','relationshipId',target->>'relationshipId')
        and exists(select 1 from jsonb_array_elements(pinned #> '{definition,edges}') e where e->>'id'=target->>'relationshipId'
          and e->>'kind'='execution' and e->>'source'=execution.workflow_node_id))) is not true then
      raise exception 'REPEAT_EXIT_TARGET_INVALID';
    end if;
  end if;
  if new.record->'contractVersion' is distinct from '1'::jsonb
    or execution.occurrence_id is distinct from occ.occurrence_id or execution.run_id<>occ.run_id
    or execution.workflow_node_id is distinct from block->>'exitNodeId'
    or new.record->'occurrence' is distinct from occ.record or new.record->'exitExecution' is distinct from execution.identity
    or new.record->>'outcome' is distinct from outcome or new.record->>'reason' is distinct from reason
    or new.record->'target' is distinct from target or new.record->'resultData' is distinct from envelope->'data' then
    raise exception 'REPEAT_DECISION_PROVENANCE_CONFLICT';
  end if;
  for member in select jsonb_array_elements_text(block->'nodeIds') loop
    if not exists(select 1 from run_repeat_resolutions r where r.run_id=occ.run_id and r.occurrence_key=occ.occurrence_id
      and r.workflow_node_id=member and r.record #>> '{value,resolution}' in ('succeeded','skipped')) then
      raise exception 'REPEAT_BODY_UNRESOLVED';
    end if;
  end loop;
  if not exists(select 1 from run_repeat_resolutions r where r.run_id=occ.run_id and r.occurrence_key=occ.occurrence_id
    and r.workflow_node_id=execution.workflow_node_id and r.execution_id=new.exit_execution_id
    and r.record #>> '{value,resolution}'='succeeded' and r.record #>> '{value,acceptedResultDigest}'=new.result_digest) then
    raise exception 'REPEAT_EXIT_NOT_ACCEPTED';
  end if;
  if reason='repeat' then
    if not exists(select 1 from run_repeat_occurrences o where o.previous_decision_id=new.decision_id
      and o.previous_occurrence_id=occ.occurrence_id and o.occurrence_index=occ.occurrence_index+1) then
      raise exception 'REPEAT_SUCCESSOR_MISSING';
    end if;
  elsif not exists(select 1 from run_repeat_resolutions r where r.run_id=occ.run_id and r.occurrence_key=''
    and r.workflow_node_id=execution.workflow_node_id and r.execution_id=new.exit_execution_id
    and r.source_occurrence_id=occ.occurrence_id) then raise exception 'REPEAT_FINAL_EXPORT_MISSING'; end if;
  return null;
end $$;


--
-- Name: assert_repeat_effect_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_effect_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if exists(select 1 from run_repeat_effects where run_id=new.run_id and effect_kind=new.effect_kind and entity_id=new.entity_id) then
    perform repeat_pinned_version(new.run_id);
  end if;
  return null;
end $$;


--
-- Name: assert_repeat_evidence_retention(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_evidence_retention() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if exists(select 1 from runs where id=old.run_id) then raise exception 'REPEAT_RETAIN_WITH_RUN'; end if;
  return null;
end $$;


--
-- Name: assert_repeat_execution_evidence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_execution_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare native harness_executions%rowtype; expected jsonb; input jsonb; expected_bindings integer;
  job_record jsonb; job_node jsonb; job_input jsonb;
begin

  if new.executor_kind='job' then
    perform repeat_node_scope(new.run_id,new.workflow_node_id,new.occurrence_id);
    select j.record into strict job_record from job_executions j where j.id=new.execution_id;
    select n into strict job_node from jsonb_array_elements(repeat_pinned_version(new.run_id) #> '{definition,nodes}') n where n->>'id'=new.workflow_node_id;
    expected := jsonb_build_object('kind','job','executionId',new.execution_id,'workflowNodeId',new.workflow_node_id,
      'jobDefinitionId',job_node->>'jobDefinitionId','jobDefinitionVersionId',job_node->>'jobDefinitionVersionId','attempt',1);
    if new.occurrence_id is not null then expected:=expected||jsonb_build_object('occurrence',(select record->'identity' from run_repeat_occurrences where occurrence_id=new.occurrence_id)); end if;
    select input_json::jsonb into strict input from run_repeat_slots where slot_id=new.slot_id;
    if job_node->>'kind' is distinct from 'job' or new.technical_attempt<>1 or new.previous_execution_id is not null
      or new.identity is distinct from expected or job_record #>> '{workflow,runId}' is distinct from new.run_id
      or job_record #>> '{workflow,nodeId}' is distinct from new.workflow_node_id
      or job_record #>> '{workflow,nodeExecutionId}' is distinct from new.execution_id
      or job_record #>> '{acceptedSpec,definitionId}' is distinct from job_node->>'jobDefinitionId'
      or job_record #>> '{acceptedSpec,definitionVersionId}' is distinct from job_node->>'jobDefinitionVersionId'
      or job_record #> '{acceptedSpec,workflowInput}' is distinct from input
      or not exists(select 1 from workflow_job_executions w where w.run_id=new.run_id and w.node_execution_id=new.execution_id and w.job_execution_id=new.execution_id and w.input_json::jsonb=input)
      then raise exception 'JOB_WORKFLOW_EXECUTION_PIN_CONFLICT'; end if;
    expected_bindings:=jsonb_array_length(input->'predecessors');
    if input->'entry'<>'null'::jsonb then expected_bindings:=expected_bindings+jsonb_array_length(input #> '{entry,external}')+case when input #> '{entry,carry}'<>'null'::jsonb then 1 else 0 end; end if;
    if expected_bindings is null or (select count(*) from run_repeat_bindings where recipient_execution_id=new.execution_id)<>expected_bindings
      or exists(select 1 from run_repeat_bindings where recipient_execution_id=new.execution_id and ordinal>=expected_bindings) then raise exception 'JOB_WORKFLOW_INPUTS_INCOMPLETE'; end if;
    return null;
  end if;

  if not exists(select 1 from run_repeat_executions where execution_id=new.execution_id) then return null; end if;
  perform repeat_node_scope(new.run_id,new.workflow_node_id,new.occurrence_id);
  select * into strict native from harness_executions where id=new.execution_id;
  expected := jsonb_build_object('executionId',native.id,'workflowNodeId',native.workflow_node_id,
    'agentId',native.agent_id,'agentConfigurationVersionId',native.record->>'agentConfigurationVersionId','attempt',native.attempt);
  if new.occurrence_id is not null then
    expected := expected || jsonb_build_object('occurrence',(select record->'identity' from run_repeat_occurrences where occurrence_id=new.occurrence_id));
  end if;
  if native.run_id<>new.run_id or native.repeat_occurrence_id is distinct from new.occurrence_id
    or native.workflow_node_id<>new.workflow_node_id or native.attempt<>new.technical_attempt
    or new.identity is distinct from expected then raise exception 'REPEAT_EXECUTION_IDENTITY_CONFLICT'; end if;
  select input_json::jsonb into strict input from run_repeat_slots where slot_id=new.slot_id;
  if native.record->'input' is distinct from input then raise exception 'REPEAT_EXECUTION_INPUT_CONFLICT'; end if;
  expected_bindings := jsonb_array_length(input->'predecessors');
  if input->'entry'<>'null'::jsonb then
    expected_bindings := expected_bindings + jsonb_array_length(input #> '{entry,external}')
      + case when input #> '{entry,carry}'<>'null'::jsonb then 1 else 0 end;
  end if;
  if expected_bindings is null or (select count(*) from run_repeat_bindings where recipient_execution_id=new.execution_id)<>expected_bindings
    or exists(select 1 from run_repeat_bindings where recipient_execution_id=new.execution_id and ordinal>=expected_bindings) then
    raise exception 'REPEAT_INPUT_BINDINGS_INCOMPLETE';
  end if;
  return null;
end $$;


--
-- Name: assert_repeat_execution_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_execution_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare pinned jsonb; node jsonb; current_execution harness_executions%rowtype;
begin
  select * into current_execution from harness_executions where id=new.id;
  if not found then return null; end if;
  select v.record into strict pinned from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=current_execution.run_id;
  if pinned->>'executionSemanticsVersion' is distinct from '3' then
    if current_execution.repeat_occurrence_id is not null then raise exception 'REPEAT_LEGACY_SCOPE_CONFLICT'; end if;
    return null;
  end if;
  perform repeat_node_scope(current_execution.run_id,current_execution.workflow_node_id,current_execution.repeat_occurrence_id);
  select value into strict node from jsonb_array_elements(pinned #> '{definition,nodes}') where value->>'id'=current_execution.workflow_node_id;
  if current_execution.agent_id is distinct from node->>'agentId'
    or current_execution.record->>'id' is distinct from current_execution.id
    or current_execution.record->>'runId' is distinct from current_execution.run_id
    or current_execution.record->>'workflowNodeId' is distinct from current_execution.workflow_node_id
    or current_execution.record->>'agentId' is distinct from current_execution.agent_id
    or current_execution.record->'attempt' is distinct from to_jsonb(current_execution.attempt)
    or current_execution.record->>'agentConfigurationVersionId' is null
    or current_execution.record->>'agentConfigurationVersionId' is distinct from
      pinned #>> array['agentConfigurationVersionIds',current_execution.agent_id] then raise exception 'REPEAT_EXECUTION_PIN_CONFLICT'; end if;
  return null;
end $$;


--
-- Name: assert_repeat_frozen_sources(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_frozen_sources() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare input jsonb; pinned jsonb; block jsonb; source jsonb; recipient_node text; sources jsonb; source_kind text;
begin
  if tg_table_name='run_repeat_occurrences' then
    if not exists(select 1 from run_repeat_occurrences where occurrence_id=new.occurrence_id) then return null; end if;
    pinned := repeat_pinned_version(new.run_id); block := repeat_saved_block(pinned,new.block_id);
    input := new.input_json::jsonb; sources := input->'external'; recipient_node := block->>'entryNodeId'; source_kind := 'external';
  else
    if not exists(select 1 from run_repeat_slots where slot_id=new.slot_id) then return null; end if;
    input := new.input_json::jsonb; sources := input->'predecessors'; recipient_node := new.workflow_node_id; source_kind := 'predecessor';
  end if;
  if jsonb_typeof(sources) is distinct from 'array' or jsonb_array_length(sources)>8000
    or jsonb_array_length(sources)<>(select count(distinct s->>'relationshipId') from jsonb_array_elements(sources) s) then
    raise exception 'REPEAT_SOURCE_SET_INVALID';
  end if;
  for source in select value from jsonb_array_elements(sources) loop
    perform repeat_assert_selected_source(new.run_id,recipient_node,new.occurrence_id,source,source_kind);
  end loop;
  return null;
end $$;


--
-- Name: assert_repeat_occurrence_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_occurrence_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare pinned jsonb; block jsonb; prior run_repeat_occurrences%rowtype;
  decision run_repeat_decisions%rowtype; accepted jsonb; expected_carry jsonb;
begin
  -- A complete Run may have been deleted later in this transaction. Retention
  -- checks below still reject any splice which leaves that Run present.
  if not exists(select 1 from run_repeat_occurrences where occurrence_id=new.occurrence_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  block := repeat_saved_block(pinned,new.block_id);
  if new.workspace_id is distinct from pinned->>'workspaceId'
    or new.workflow_id is distinct from pinned->>'workflowId'
    or new.workflow_version_id is distinct from pinned->>'id' then raise exception 'REPEAT_SCOPE_CONFLICT'; end if;
  if new.occurrence_index>(block->>'maxOccurrences')::integer then raise exception 'REPEAT_LIMIT_EXCEEDED'; end if;
  if new.input_json::jsonb->'runInput' is distinct from (select record->'input' from runs where id=new.run_id) then
    raise exception 'REPEAT_RUN_INPUT_CONFLICT';
  end if;
  if new.previous_occurrence_id is not null then
    select * into strict prior from run_repeat_occurrences where occurrence_id=new.previous_occurrence_id;
    select * into strict decision from run_repeat_decisions where decision_id=new.previous_decision_id;
    select result_json::jsonb into strict accepted from run_repeat_results where execution_id=decision.exit_execution_id;
    expected_carry := jsonb_build_object('decisionId',decision.decision_id,'execution',decision.record->'exitExecution',
      'acceptedResultDigest',decision.result_digest,'acceptedResult',accepted);
    if decision.record->>'reason' is distinct from 'repeat'
      or decision.record->'target' is distinct from jsonb_build_object('kind','next_occurrence',
        'entryNodeId',block->>'entryNodeId','occurrenceIndex',new.occurrence_index)
      or new.input_json::jsonb->'external' is distinct from prior.input_json::jsonb->'external'
      or new.input_json::jsonb->'runInput' is distinct from prior.input_json::jsonb->'runInput'
      or new.input_json::jsonb->'carry' is distinct from expected_carry then
      raise exception 'REPEAT_LINEAGE_CONFLICT';
    end if;
  end if;
  return null;
end $$;


--
-- Name: assert_repeat_resolution(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_resolution() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare pinned jsonb; block jsonb; execution run_repeat_executions%rowtype; decision run_repeat_decisions%rowtype;
  source_identity jsonb; kind text; target jsonb; selected jsonb; unselected jsonb;
begin
  if not exists(select 1 from run_repeat_resolutions where run_id=new.run_id and occurrence_key=new.occurrence_key
    and workflow_node_id=new.workflow_node_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if (select count(*) from jsonb_array_elements(pinned #> '{definition,nodes}') n where n->>'id'=new.workflow_node_id)<>1 then
    raise exception 'REPEAT_NODE_SCOPE_CONFLICT';
  end if;
  kind := new.record #>> '{value,resolution}';
  if kind is null or kind not in ('succeeded','failed','canceled','skipped','excluded') then raise exception 'REPEAT_RESOLUTION_INVALID'; end if;
  if new.source_occurrence_id is not null then
    perform repeat_node_scope(new.run_id,new.workflow_node_id,new.source_occurrence_id);
    select record->'identity' into strict source_identity from run_repeat_occurrences where occurrence_id=new.source_occurrence_id;
    if new.record #> '{ref,occurrence}' is distinct from source_identity then raise exception 'REPEAT_RESOLUTION_SCOPE_CONFLICT'; end if;
  elsif new.record #> '{ref,occurrence}' is distinct from 'null'::jsonb then raise exception 'REPEAT_RESOLUTION_SCOPE_CONFLICT'; end if;
  if kind in ('skipped','excluded') then
    if new.execution_id is not null or new.record #>> '{value,acceptedResultDigest}' is not null then raise exception 'REPEAT_RESOLUTION_INVALID'; end if;
  else
    select * into strict execution from run_repeat_executions where execution_id=new.execution_id;
    if execution.run_id<>new.run_id or execution.workflow_node_id<>new.workflow_node_id
      or execution.occurrence_id is distinct from new.source_occurrence_id
      or new.record #> '{value,execution}' is distinct from execution.identity-'occurrence' then
      raise exception 'REPEAT_RESOLUTION_EXECUTION_CONFLICT';
    end if;
    if kind='succeeded' and not exists(select 1 from run_repeat_results where execution_id=new.execution_id
      and result_digest=new.record #>> '{value,acceptedResultDigest}') then raise exception 'REPEAT_RESOLUTION_RESULT_CONFLICT'; end if;
    if kind<>'succeeded' and new.record #>> '{value,acceptedResultDigest}' is not null then raise exception 'REPEAT_RESOLUTION_INVALID'; end if;
  end if;
  if new.occurrence_key='' then
    select value into block from jsonb_array_elements(pinned #> '{definition,repeat,blocks}') b where b->'nodeIds' ? new.workflow_node_id;
    if block is not null then
      if block->>'exitNodeId' is distinct from new.workflow_node_id then raise exception 'REPEAT_EXPORT_SCOPE_CONFLICT'; end if;
      if new.source_occurrence_id is null then
        if kind not in ('skipped','excluded') then raise exception 'REPEAT_EXPORT_SCOPE_CONFLICT'; end if;
      else
        select * into strict decision from run_repeat_decisions where occurrence_id=new.source_occurrence_id;
        if decision.exit_execution_id is distinct from new.execution_id or kind<>'succeeded'
          or decision.record->>'reason' not in ('early_exit','limit_exit') then raise exception 'REPEAT_EGRESS_UNRESOLVED'; end if;
        target := decision.record->'target';
        selected := case when target->>'kind'='edge' then jsonb_build_array(target->>'relationshipId') else '[]'::jsonb end;
        select coalesce(jsonb_agg(e->>'id' order by (e->>'id') collate "C"),'[]'::jsonb) into unselected
          from jsonb_array_elements(pinned #> '{definition,edges}') e where e->>'kind'='execution'
            and e->>'source'=new.workflow_node_id and not (selected ? (e->>'id'));
        if new.record->'deferredRelationshipIds' is distinct from '[]'::jsonb
          or new.record #> '{value,selectedRelationshipIds}' is distinct from selected
          or new.record #> '{value,unselectedRelationshipIds}' is distinct from unselected
          or new.record #> '{value,branchEnded}' is distinct from to_jsonb(target->>'kind'='branch_end')
          or new.record #>> '{value,outcome}' is distinct from decision.record->>'outcome' then raise exception 'REPEAT_EXPORT_ROUTE_CONFLICT'; end if;
      end if;
    end if;
  end if;
  return null;
end $$;


--
-- Name: assert_repeat_run_pin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_run_pin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if exists(select 1 from runs r join workflow_versions v on v.id=r.workflow_version_id
    where r.id=new.id and (r.record->>'executionSemanticsVersion'='3' or v.execution_semantics_version=3)) then
    perform repeat_pinned_version(new.id);
  end if;
  return null;
end $$;


--
-- Name: assert_repeat_slot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_slot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare block jsonb; occ run_repeat_occurrences%rowtype; input jsonb;
begin
  if not exists(select 1 from run_repeat_slots where slot_id=new.slot_id) then return null; end if;
  block := repeat_node_scope(new.run_id,new.workflow_node_id,new.occurrence_id);
  input := new.input_json::jsonb;
  if input->'executionSemanticsVersion' is distinct from '3'::jsonb
    or input->'runInput' is distinct from (select record->'input' from runs where id=new.run_id)
    or jsonb_typeof(input->'predecessors') is distinct from 'array' then raise exception 'REPEAT_SLOT_INPUT_CONFLICT'; end if;
  if new.occurrence_id is not null then
    select * into strict occ from run_repeat_occurrences where occurrence_id=new.occurrence_id;
    if input->'occurrence' is distinct from occ.record
      or input->'entry' is distinct from (case when block->>'entryNodeId'=new.workflow_node_id
        then occ.input_json::jsonb else 'null'::jsonb end) then raise exception 'REPEAT_SLOT_INPUT_CONFLICT'; end if;
  elsif input->'occurrence' is distinct from 'null'::jsonb or input->'entry' is distinct from 'null'::jsonb then
    raise exception 'REPEAT_SLOT_INPUT_CONFLICT';
  end if;
  return null;
end $$;


--
-- Name: assert_repeat_version_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_repeat_version_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if exists(select 1 from workflow_versions where id=new.id and execution_semantics_version=3)
    and not exists(select 1 from workflows where id=new.workflow_id and workspace_id=new.workspace_id) then
    raise exception 'REPEAT_VERSION_SCOPE_CONFLICT';
  end if;
  return null;
end $$;


--
-- Name: assert_run_placement_complete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_run_placement_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare nodes jsonb;
begin
 select coalesce(jsonb_agg(n),'[]'::jsonb) into nodes from workflow_versions v,
   lateral jsonb_array_elements(v.record#>'{definition,nodes}') n
   where v.id=NEW.workflow_version_id and coalesce(n->>'kind','agent')='agent';
 if exists(select 1 from jsonb_array_elements(nodes) n where n ? 'placement')
   or exists(select 1 from run_node_placements where run_id=NEW.id) then
  if exists(select 1 from jsonb_array_elements(nodes) n where not exists(select 1 from run_node_placements p
    where p.run_id=NEW.id and p.node_id=n->>'id' and p.record#>>'{payload,agentId}'=n->>'agentId'))
   or (select count(*) from run_node_placements where run_id=NEW.id)<>jsonb_array_length(nodes) then
   raise exception 'RUN_PLACEMENT_EVIDENCE_MISSING' using errcode='P2843';
  end if;
 end if;
 return NEW;
end $$;


--
-- Name: assert_work_accepted_result(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_accepted_result() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare native harness_executions%rowtype; activation run_work_activations%rowtype;
begin
  if not exists(select 1 from run_work_results where execution_id=new.execution_id) then return null; end if;
  select * into strict native from harness_executions where id=new.execution_id;
  select * into strict activation from run_work_activations where activation_id=new.activation_id;
  if native.run_id<>new.run_id or native.work_activation_id<>new.activation_id
    or activation.run_id<>new.run_id or activation.workflow_node_id<>native.workflow_node_id
    or not native.accepted or native.record->>'state' is distinct from 'completed'
    or native.record->'result' is distinct from new.result_json::jsonb then
    raise exception 'WORK_RESULT_NOT_ACCEPTED'; end if;
  return null;
end $$;


--
-- Name: assert_work_attempt_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_attempt_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare slot run_repeat_slots%rowtype; native harness_executions%rowtype; pinned jsonb; job_record jsonb;
begin
  if not exists(select 1 from run_repeat_executions where execution_id=new.execution_id) then return null; end if;
  select * into strict slot from run_repeat_slots where slot_id=new.slot_id;
  pinned := repeat_pinned_version(new.run_id);
  if new.executor_kind='job' then
    select record into strict job_record from job_executions where id=new.execution_id;
    if new.work_activation_id is not null or slot.work_activation_id is not null
      or pinned #> '{definition,handoffs}' = '{"contractVersion":1}'::jsonb
      or slot.run_id is distinct from new.run_id
      or slot.workflow_node_id is distinct from new.workflow_node_id
      or slot.occurrence_id is distinct from new.occurrence_id
      or job_record #>> '{workflow,runId}' is distinct from new.run_id
      or job_record #>> '{workflow,nodeId}' is distinct from new.workflow_node_id
      or job_record #>> '{workflow,nodeExecutionId}' is distinct from new.execution_id then
      raise exception 'JOB_WORKFLOW_EXECUTION_PIN_CONFLICT';
    end if;
    return null;
  end if;
  select * into strict native from harness_executions where id=new.execution_id;
  if slot.tick_index is not null or native.tick_index is not null then
    if new.work_activation_id is not null or new.occurrence_id is not null
      or native.tick_index is distinct from slot.tick_index then raise exception 'TICK_ATTEMPT_CONFLICT'; end if;
    return null;
  end if;
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb then
    if new.work_activation_id is not null then raise exception 'WORK_ATTEMPT_ON_OLD_RUN'; end if;
    return null;
  end if;
  if new.work_activation_id is null or new.occurrence_id is not null
    or new.work_activation_id<>slot.work_activation_id or new.work_activation_id<>native.work_activation_id
    or new.run_id<>slot.run_id or new.run_id<>native.run_id then
    raise exception 'WORK_ATTEMPT_ACTIVATION_CONFLICT';
  end if;
  return null;
end $$;


--
-- Name: assert_work_denial(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_denial() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare usage run_work_connection_usage%rowtype; pinned jsonb; work_edge jsonb;
  source_activation run_work_activations%rowtype; source_execution harness_executions%rowtype;
  accepted_digest text;
begin
  if not exists(select 1 from run_work_denials where denial_id=new.denial_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  select * into strict usage from run_work_connection_usage
    where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
  select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
    where e->>'id'=new.relationship_id and e->>'kind'='execution';
  select * into strict source_activation from run_work_activations where activation_id=new.requester_activation_id;
  select * into strict source_execution from harness_executions where id=new.requester_execution_id;
  select result_digest into strict accepted_digest from run_work_results
    where run_id=new.run_id and execution_id=new.requester_execution_id and activation_id=new.requester_activation_id;
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or usage.maximum is null or usage.used<>usage.maximum
    or new.record->'used' is distinct from to_jsonb(usage.used)
    or new.record->'maxWorkHandoffsPerRun' is distinct from to_jsonb(usage.maximum)
    or new.workflow_version_id<>pinned->>'id' or source_activation.run_id<>new.run_id
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.requester_activation_id
    or not source_execution.accepted or accepted_digest<>new.payload_digest
    or new.record->>'requesterActivationId' is distinct from new.requester_activation_id
    or new.record->>'destinationNodeId' is distinct from
      (case when work_edge->>'source'=source_activation.workflow_node_id then work_edge->>'target'
        when work_edge->>'workRequestDirection'='both' and work_edge->>'target'=source_activation.workflow_node_id
          then work_edge->>'source' else null end)
    or exists(select 1 from run_work_requests where request_id=new.request_id
      or (run_id=new.run_id and requester_execution_id=new.requester_execution_id
        and relationship_id=new.relationship_id)) then
    raise exception 'WORK_DENIAL_ANCESTRY_CONFLICT'; end if;
  return null;
end $$;


--
-- Name: assert_work_direction_wait(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_direction_wait() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare pinned jsonb; ids jsonb;
begin
  if not exists(select 1 from run_work_direction_waits where run_id=new.run_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  select coalesce(jsonb_agg(unresolved_id order by unresolved_id),'[]'::jsonb) into ids
    from run_work_unresolved where run_id=new.run_id;
  if pinned->>'id' is distinct from new.workflow_version_id
    or pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or ids is distinct from new.unresolved_ids
    or not exists(select 1 from runs where id=new.run_id and execution_state='waiting'
      and record->>'executionState'='waiting' and record->>'outcome'='pending'
      and stop_requested_at is null) then raise exception 'WORK_DIRECTION_WAIT_CONFLICT'; end if;
  return null;
end $$;


--
-- Name: assert_work_evidence_retention(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_evidence_retention() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if exists(select 1 from runs where id=old.run_id) then raise exception 'WORK_RETAIN_WITH_RUN'; end if;
  return null;
end $$;


--
-- Name: assert_work_handoff_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_handoff_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    if new.cause_kind='entry' and (new.workflow_node_id<>pinned->>'entryNodeId'
      or new.lineage_id<>new.run_id) then raise exception 'WORK_ENTRY_PIN_CONFLICT'; end if;
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


--
-- Name: assert_work_join_dispatch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_join_dispatch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists(select 1 from run_work_activations a
    where a.run_id=new.run_id and a.activation_id=new.activation_id and a.cause_kind='join')
    or not exists(select 1 from run_work_results x
      where x.run_id=new.run_id and x.activation_id=new.source_activation_id) then
    raise exception 'WORK_JOIN_DISPATCH_CONFLICT';
  end if;
  return null;
end $$;


--
-- Name: assert_work_native_activation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_native_activation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: assert_work_notice_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_notice_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare pinned jsonb; requester run_work_activations%rowtype; continuation run_work_activations%rowtype;
  work_edge jsonb; destination jsonb; parent_return run_work_returns%rowtype;
  denial run_work_denials%rowtype; request run_work_requests%rowtype;
  alternative jsonb; alt_edge jsonb; alt_node jsonb; options jsonb;
  alt_used integer; alt_maximum integer;
begin
  if not exists(select 1 from run_work_notices where notice_id=new.notice_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or new.workflow_version_id<>pinned->>'id' then raise exception 'WORK_NOTICE_PIN_CONFLICT'; end if;
  select * into strict requester from run_work_activations where activation_id=new.requester_activation_id;
  select * into strict continuation from run_work_activations where activation_id=new.continuation_activation_id;
  select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
    where e->>'id'=new.relationship_id and e->>'kind'='execution';
  select value into strict destination from jsonb_array_elements(pinned #> '{definition,nodes}') n
    where n->>'id'=new.destination_node_id;
  if requester.run_id<>new.run_id or continuation.run_id<>new.run_id
    or continuation.workflow_node_id<>requester.workflow_node_id
    or continuation.lineage_id<>requester.lineage_id
    or destination->>'agentId' is distinct from new.record->>'destinationAgentId'
    or coalesce(destination->>'name',destination->>'label',destination->>'agentId')
      is distinct from new.record->>'destinationName'
    or new.record->>'message' is distinct from
      ('The maximum number of work handoffs to agent ' || (new.record->>'destinationName')
        || ' has been reached (' || new.used::text || ' of ' || new.maximum::text
        || ' for this Run). Choose another available agent or finish with the remaining findings.')
    or (work_edge->>'source'<>requester.workflow_node_id and
      not (coalesce(work_edge->>'workRequestDirection'='both',false)
        and work_edge->>'target'=requester.workflow_node_id)) then
    raise exception 'WORK_NOTICE_CONTENT_CONFLICT'; end if;
  if new.cause_kind='last_return' then
    select * into strict parent_return from run_work_returns where return_id=new.cause_id;
    select * into strict request from run_work_requests where request_id=parent_return.request_id;
    if parent_return.run_id<>new.run_id or parent_return.outcome<>'needs_changes'
      or parent_return.requester_continuation_activation_id<>new.continuation_activation_id
      or request.relationship_id<>new.relationship_id
      or request.requester_activation_id<>new.requester_activation_id
      or continuation.cause_kind<>'work_return' or continuation.cause_id<>new.cause_id
      or new.record->'latestDeliverable' is distinct from parent_return.record->'latestDeliverable'
      or new.record->'remainingFindings' is distinct from parent_return.record->'remainingFindings' then
      raise exception 'WORK_NOTICE_RETURN_CONFLICT'; end if;
  else
    select * into strict denial from run_work_denials where denial_id=new.cause_id;
    if denial.run_id<>new.run_id or denial.relationship_id<>new.relationship_id
      or denial.requester_activation_id<>new.requester_activation_id
      or (denial.record->>'used')::integer<>new.used
      or denial.record->>'maxWorkHandoffsPerRun'<>new.maximum::text
      or continuation.cause_kind<>'limit_denial' or continuation.cause_id<>new.cause_id then
      raise exception 'WORK_NOTICE_DENIAL_CONFLICT'; end if;
  end if;
  if not exists(select 1 from run_work_connection_usage u where u.run_id=new.run_id
    and u.workflow_version_id=new.workflow_version_id and u.relationship_id=new.relationship_id
    and u.used=new.used and u.maximum=new.maximum) then raise exception 'WORK_NOTICE_CAP_CONFLICT'; end if;
  if tg_op='INSERT' then
    if jsonb_typeof(new.record->'alternatives') is distinct from 'array' then
      raise exception 'WORK_NOTICE_ALTERNATIVES_INVALID'; end if;
    for alternative in select value from jsonb_array_elements(new.record->'alternatives') loop
      select value into strict alt_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
        where e->>'id'=alternative->>'relationshipId' and e->>'kind'='execution';
      select value into strict alt_node from jsonb_array_elements(pinned #> '{definition,nodes}') n
        where n->>'id'=alternative->>'destinationNodeId';
      select coalesce(jsonb_agg(c->>'outcome' order by c->>'outcome'),'[]'::jsonb) into options
        from jsonb_array_elements((select n->'choice'->'outcomes' from jsonb_array_elements(pinned #> '{definition,nodes}') n
          where n->>'id'=requester.workflow_node_id)) c
        where c #>> '{target,kind}'='edge' and c #>> '{target,relationshipId}'=alternative->>'relationshipId';
      select u.used,u.maximum into alt_used,alt_maximum from run_work_connection_usage u
        where u.run_id=new.run_id and u.workflow_version_id=new.workflow_version_id
          and u.relationship_id=alternative->>'relationshipId';
      alt_used := coalesce(alt_used,0);
      if alternative->>'relationshipId'=new.relationship_id
        or alternative->>'destinationNodeId'=new.destination_node_id
        or not coalesce((alt_edge->>'source'=requester.workflow_node_id
          and alt_edge->>'target'=alternative->>'destinationNodeId'
          or coalesce(alt_edge->>'workRequestDirection'='both',false)
            and alt_edge->>'target'=requester.workflow_node_id
            and alt_edge->>'source'=alternative->>'destinationNodeId'),false)
        or alt_node->>'agentId' is distinct from alternative->>'destinationAgentId'
        or coalesce(alt_node->>'name',alt_node->>'label',alt_node->>'agentId')
          is distinct from alternative->>'destinationName'
        or options='[]'::jsonb and (alt_edge->>'source'<>requester.workflow_node_id
          or exists(select 1 from jsonb_array_elements(pinned #> '{definition,nodes}') n
            where n->>'id'=requester.workflow_node_id and n->'choice' is not null))
        or alternative->'outcomes' is distinct from options
        or alternative->'used' is distinct from to_jsonb(alt_used)
        or alternative->'maxWorkHandoffsPerRun' is distinct from coalesce(alt_edge->'maxWorkHandoffsPerRun','null'::jsonb)
        or (alt_edge->>'maxWorkHandoffsPerRun')::integer is not null
          and alt_used>=(alt_edge->>'maxWorkHandoffsPerRun')::integer
        or alt_maximum is not null and alt_maximum is distinct from (alt_edge->>'maxWorkHandoffsPerRun')::integer then
        raise exception 'WORK_NOTICE_ALTERNATIVE_CONFLICT'; end if;
    end loop;
  end if;
  if new.delivery_state='delivered' and not exists(select 1 from run_work_results x
    join harness_executions e on e.id=x.execution_id where x.run_id=new.run_id
      and x.activation_id=new.continuation_activation_id and e.id=new.acknowledgement_execution_id
      and e.accepted and e.record->>'state'='completed') then raise exception 'WORK_NOTICE_ACK_MISSING'; end if;
  return null;
end $$;


--
-- Name: assert_work_parent_input(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_parent_input() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare parent_id text; parent_record jsonb; input_record jsonb;
begin
  if new.work_activation_id is null then return null; end if;
  input_record := new.input_json::jsonb;
  if input_record #>> '{work,kind}' not in ('work_return','limit_denial') then return null; end if;
  parent_id := work_parent_request(new.run_id,new.work_activation_id);
  if parent_id is not null then
    select record into strict parent_record from run_work_requests where run_id=new.run_id and request_id=parent_id;
  end if;
  if input_record->'parentRequest' is distinct from parent_record then raise exception 'WORK_PARENT_INPUT_CONFLICT'; end if;
  return null;
end $$;


--
-- Name: assert_work_request(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare pinned jsonb; work_edge jsonb; current_usage run_work_connection_usage%rowtype;
  source_activation run_work_activations%rowtype; destination_activation run_work_activations%rowtype;
  source_execution harness_executions%rowtype; accepted_digest text;
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
  select result_digest into strict accepted_digest from run_work_results
    where run_id=new.run_id and execution_id=new.requester_execution_id
      and activation_id=new.requester_activation_id;
  if source_activation.run_id<>new.run_id or source_activation.workflow_node_id<>new.requester_node_id
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.requester_activation_id
    or source_execution.workflow_node_id<>new.requester_node_id or not source_execution.accepted
    or source_execution.record->>'state'<>'completed'
    or accepted_digest<>new.payload_digest
    or destination_activation.run_id<>new.run_id or destination_activation.workflow_node_id<>new.destination_node_id
    or destination_activation.lineage_id<>source_activation.lineage_id
    or not (destination_activation.cause_kind='work_request' and destination_activation.cause_id=new.request_id
      or destination_activation.cause_kind='join'
        and destination_activation.cause_id=destination_activation.activation_id) then
    raise exception 'WORK_REQUEST_ANCESTRY_CONFLICT'; end if;
  if (select count(*) from run_work_requests where run_id=new.run_id
      and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id)<>current_usage.used then
    raise exception 'WORK_COUNTER_EVIDENCE_CONFLICT'; end if;
  return null;
end $$;


--
-- Name: assert_work_return(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_return() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare work_request run_work_requests%rowtype; source_activation run_work_activations%rowtype;
  source_execution harness_executions%rowtype; accepted_digest text;
  continuation run_work_activations%rowtype;
begin
  if not exists(select 1 from run_work_returns where return_id=new.return_id) then return null; end if;
  select * into strict work_request from run_work_requests where request_id=new.request_id;
  select * into strict source_activation from run_work_activations where activation_id=new.source_activation_id;
  select * into strict source_execution from harness_executions where id=new.source_execution_id;
  select result_digest into strict accepted_digest from run_work_results
    where run_id=new.run_id and execution_id=new.source_execution_id and activation_id=new.source_activation_id;
  if new.run_id<>work_request.run_id
    or work_return_request(new.run_id,new.source_activation_id,new.request_id) is distinct from new.request_id
    or source_activation.workflow_node_id<>work_request.destination_node_id
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.source_activation_id
    or source_execution.workflow_node_id<>work_request.destination_node_id or not source_execution.accepted
    or source_execution.record->>'state'<>'completed'
    or accepted_digest<>new.result_digest
    or new.record #>> '{scope,workflowVersionId}' is distinct from work_request.workflow_version_id
    or new.record->>'requesterActivationId' is distinct from work_request.requester_activation_id
    or new.record->'latestDeliverable' is null or new.record->'latestDeliverable'='null'::jsonb
    or jsonb_typeof(new.record->'remainingFindings') is distinct from 'array'
    or work_json_bytes(new.record)>65536 then raise exception 'WORK_RETURN_ANCESTRY_CONFLICT'; end if;
  if new.outcome='needs_changes' then
    select * into strict continuation from run_work_activations
      where activation_id=new.requester_continuation_activation_id;
    if continuation.run_id<>new.run_id or continuation.workflow_node_id<>work_request.requester_node_id
      or continuation.lineage_id<>source_activation.lineage_id
      or continuation.cause_kind<>'work_return' or continuation.cause_id<>new.return_id then
      raise exception 'WORK_RETURN_CONTINUATION_CONFLICT'; end if;
  end if;
  return null;
end $$;


--
-- Name: assert_work_slot_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_slot_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare pinned jsonb; activation run_work_activations%rowtype; request run_work_requests%rowtype;
  returned run_work_returns%rowtype; denial run_work_denials%rowtype;
  source_result jsonb; work_input jsonb; joined jsonb; expected integer; notice jsonb; required_edges text[];
begin
  if not exists(select 1 from run_repeat_slots where slot_id=new.slot_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb then
    if new.work_activation_id is not null then raise exception 'WORK_SLOT_ON_OLD_RUN'; end if;
    return null;
  end if;
  if new.work_activation_id is null or new.occurrence_id is not null
    or new.input_json::jsonb #>> '{work,activation,activationId}' is distinct from new.work_activation_id then
    raise exception 'WORK_SLOT_ACTIVATION_CONFLICT'; end if;
  select * into strict activation from run_work_activations where activation_id=new.work_activation_id;
  if activation.run_id<>new.run_id or activation.workflow_node_id<>new.workflow_node_id
    or activation.workflow_version_id<>pinned->>'id' then raise exception 'WORK_SLOT_ACTIVATION_CONFLICT'; end if;
  work_input := new.input_json::jsonb->'work';
  if work_input->>'kind' is distinct from activation.cause_kind
    or work_input->'activation' is distinct from activation.record then
    raise exception 'WORK_SLOT_INPUT_CONFLICT'; end if;
  if activation.cause_kind='entry' then
    if activation.workflow_node_id<>pinned->>'entryNodeId' then raise exception 'WORK_ENTRY_NODE_CONFLICT'; end if;
  elsif activation.cause_kind='work_request' then
    select * into strict request from run_work_requests where request_id=activation.cause_id;
    select result_json::jsonb into strict source_result from run_work_results
      where run_id=new.run_id and execution_id=request.requester_execution_id;
    if request.run_id<>new.run_id or request.destination_activation_id<>activation.activation_id
      or work_input->'request' is distinct from request.record
      or work_input->'acceptedSourceResult' is distinct from source_result then
      raise exception 'WORK_SLOT_INPUT_CONFLICT'; end if;
  elsif activation.cause_kind='work_return' then
    select * into strict returned from run_work_returns where return_id=activation.cause_id;
    select result_json::jsonb into strict source_result from run_work_results
      where run_id=new.run_id and execution_id=returned.source_execution_id;
    select record into notice from run_work_notices where run_id=new.run_id
      and cause_kind='last_return' and cause_id=returned.return_id;
    if returned.run_id<>new.run_id or returned.requester_continuation_activation_id<>activation.activation_id
      or work_input->'returned' is distinct from returned.record
      or work_input->'acceptedSourceResult' is distinct from source_result then
      raise exception 'WORK_SLOT_INPUT_CONFLICT'; end if;
    if notice is not null then perform assert_frozen_work_notice(work_input->'notice',notice);
    elsif work_input ? 'notice' then raise exception 'WORK_NOTICE_INPUT_CONFLICT'; end if;
  elsif activation.cause_kind='limit_denial' then
    select * into strict denial from run_work_denials where denial_id=activation.cause_id;
    select result_json::jsonb into strict source_result from run_work_results
      where run_id=new.run_id and execution_id=denial.requester_execution_id;
    select record into strict notice from run_work_notices where run_id=new.run_id
      and cause_kind='limit_denial' and cause_id=denial.denial_id;
    if denial.run_id<>new.run_id or work_input->'denial' is distinct from denial.record
      or work_input->'acceptedSourceResult' is distinct from source_result then
      raise exception 'WORK_DENIAL_INPUT_CONFLICT'; end if;
    perform assert_frozen_work_notice(work_input->'notice',notice);
  elsif activation.cause_kind='join' then
    select coalesce(jsonb_agg(jsonb_build_object('request',r.record,'acceptedSourceResult',x.result_json::jsonb)
      order by r.relationship_id),'[]'::jsonb) into joined
      from run_work_requests r join run_work_results x on x.run_id=r.run_id
        and x.execution_id=r.requester_execution_id
      where r.run_id=new.run_id and r.destination_activation_id=new.work_activation_id;
    required_edges := work_join_required_edges(new.run_id,
      work_round_id(new.run_id,new.work_activation_id),new.workflow_node_id);
    expected := cardinality(required_edges);
    if activation.state<>'queued' or expected<1 or jsonb_array_length(joined)<>expected
      or (select count(distinct r.relationship_id) from run_work_requests r
        where r.run_id=new.run_id and r.destination_activation_id=new.work_activation_id)<>expected
      or exists(select 1 from run_work_requests r where r.run_id=new.run_id
        and r.destination_activation_id=new.work_activation_id and not (r.relationship_id=any(required_edges)))
      or work_input->'sources' is distinct from joined then
      raise exception 'WORK_JOIN_INPUT_CONFLICT'; end if;
  else
    raise exception 'WORK_SLOT_CAUSE_UNSUPPORTED';
  end if;
  return null;
end $$;


--
-- Name: assert_work_unresolved(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_work_unresolved() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare accepted run_work_results%rowtype; activation run_work_activations%rowtype;
  payload jsonb; pinned jsonb; node jsonb;
begin
  if not exists(select 1 from run_work_unresolved where unresolved_id=new.unresolved_id) then return null; end if;
  select * into strict accepted from run_work_results where run_id=new.run_id and execution_id=new.execution_id;
  select * into strict activation from run_work_activations where run_id=new.run_id and activation_id=new.activation_id;
  if accepted.activation_id<>new.activation_id or accepted.result_digest<>new.result_digest then
    raise exception 'WORK_UNRESOLVED_RESULT_CONFLICT'; end if;
  payload := accepted.result_json::jsonb->'output';
  if jsonb_typeof(payload)='string' then payload := (accepted.result_json::jsonb->>'output')::jsonb;
  elsif payload->>'text' is not null and payload->'routing' is null then payload := (payload->>'text')::jsonb;
  end if;
  if new.reason='finish_with_findings' then
    if payload #>> '{routing,kind}' is distinct from 'finish'
        and (payload #>> '{routing,kind}' is distinct from 'return'
          or payload #>> '{routing,outcome}' is distinct from 'accepted')
      or jsonb_typeof(payload #> '{data,remainingFindings}') is distinct from 'array'
      or jsonb_array_length(payload #> '{data,remainingFindings}')=0 then
      raise exception 'WORK_UNRESOLVED_FINISH_CONFLICT'; end if;
    if payload #>> '{routing,kind}'='return' and not exists(
      select 1 from run_work_returns r where r.run_id=new.run_id and r.source_execution_id=new.execution_id
        and r.source_activation_id=new.activation_id
        and r.request_id=work_return_request(new.run_id,new.activation_id,payload #>> '{routing,requestId}')
        and r.outcome='accepted' and r.result_digest=new.result_digest
        and r.record->'latestDeliverable'=payload #> '{data,latestDeliverable}'
        and r.record->'remainingFindings'=payload #> '{data,remainingFindings}') then
      raise exception 'WORK_UNRESOLVED_RETURN_CONFLICT'; end if;
  else
    pinned := repeat_pinned_version(new.run_id);
    select value into strict node from jsonb_array_elements(pinned #> '{definition,nodes}') n
      where n->>'id'=activation.workflow_node_id;
    if not (new.relationship_id=any(work_saved_routes(pinned,node,payload)))
      or not exists(select 1 from run_work_denials d join run_work_activations a
        on a.run_id=d.run_id and a.activation_id=d.requester_activation_id
        where d.run_id=new.run_id and d.relationship_id=new.relationship_id
          and a.lineage_id=activation.lineage_id) then
      raise exception 'WORK_UNRESOLVED_DENIAL_CONFLICT'; end if;
  end if;
  return null;
end $$;


--
-- Name: audit_interaction_delivery_attempt(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_interaction_delivery_attempt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if TG_OP='INSERT' or NEW.state is distinct from OLD.state or NEW.error is distinct from OLD.error
        or NEW.evidence is distinct from OLD.evidence then
        insert into run_activity (run_id,source,kind,harness_execution_id,occurred_at,payload)
          select i.run_id,'backend','interaction_delivery_state',i.execution_id,clock_timestamp(),
            jsonb_strip_nulls(jsonb_build_object('interactionId',NEW.interaction_id,'stage','attempt',
              'attempt',NEW.attempt,'deliveryState',NEW.state,'deliveryFence',NEW.delivery_fence,
              'nativeSessionId',NEW.native_session_id,'nativeRequestId',NEW.native_request_id,
              'correlationId',NEW.correlation_id,'error',NEW.error,'evidence',NEW.evidence))
            from durable_interactions i where i.id=NEW.interaction_id;
      end if;
      return NEW;
    end $$;


--
-- Name: audit_interaction_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_interaction_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    declare previous jsonb; activity_payload jsonb; activity_kind text;
    begin
      previous := case when TG_OP='INSERT' then '{}'::jsonb else OLD.record end;
      activity_payload := jsonb_strip_nulls(jsonb_build_object(
        'interactionId',NEW.id,'revision',NEW.revision,'harness',NEW.harness,
        'nativeSessionId',NEW.native_session_id,'nativeRequestId',NEW.native_request_id,
        'handler',NEW.record->'approval'->>'handler','status',NEW.status,
        'previousStatus',previous->>'status','deliveryState',NEW.record->>'deliveryState',
        'previousDeliveryState',previous->>'deliveryState','deliveryFence',NEW.delivery_fence,
        'selectedOptionId',NEW.record->>'selectedOptionId','selectedSemantic',NEW.record->>'selectedSemantic',
        'auditReference',NEW.record->>'auditReference','error',NEW.last_delivery_error,
        'reconciliationStatus',NEW.reconciliation_status));
      foreach activity_kind in array array[
        case when TG_OP='INSERT' and NEW.status='pending' then 'interaction_pending' end,
        case when NEW.record->>'selectedOptionId' is not null and previous->>'selectedOptionId' is null
          then 'interaction_decided' end,
        case when TG_OP='UPDATE' and (NEW.record->>'deliveryState' is distinct from previous->>'deliveryState'
          or NEW.last_delivery_error is distinct from OLD.last_delivery_error
          or NEW.reconciliation_status is distinct from OLD.reconciliation_status) then 'interaction_delivery_state' end,
        case when NEW.status in ('delivered','delivery_failed','canceled')
          and NEW.status is distinct from previous->>'status' then 'interaction_resolved' end
      ] loop
        if activity_kind is not null then
          insert into run_activity (run_id,source,kind,harness_execution_id,occurred_at,payload)
            values (NEW.run_id,'backend',activity_kind,NEW.execution_id,clock_timestamp(),activity_payload);
        end if;
      end loop;
      if NEW.status='delivered' then
        insert into interaction_graph_resumes
          (interaction_id,run_id,execution_id,graph_thread_id,graph_interrupt_id,delivery_revision)
          values (NEW.id,NEW.run_id,NEW.execution_id,NEW.record->>'graphThreadId',
            NEW.record->>'graphInterruptId',NEW.revision) on conflict do nothing;
        update interaction_graph_resumes set graph_interrupt_id=NEW.record->>'graphInterruptId',
          revision=revision+1,updated_at=clock_timestamp()
          where interaction_id=NEW.id and graph_interrupt_id is null and NEW.record->>'graphInterruptId' is not null;
      elsif NEW.status='canceled' then
        update interaction_graph_resumes set state='canceled',revision=revision+1,lease_fence=lease_fence+1,
          lease_owner=null,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp(),
          error=jsonb_build_object('code','INTERACTION_CANCELED','message','The interaction was canceled before graph resume completed.')
          where interaction_id=NEW.id and state not in ('resumed','canceled');
      end if;
      return NEW;
    end $$;


--
-- Name: audit_review_job_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_review_job_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if TG_OP='INSERT' or NEW.state is distinct from OLD.state or NEW.lease_fence is distinct from OLD.lease_fence
        or NEW.record->'error' is distinct from OLD.record->'error'
        or NEW.recovery_evidence is distinct from OLD.recovery_evidence then
        insert into run_activity (run_id,source,kind,harness_execution_id,occurred_at,payload)
          select i.run_id,'backend','review_job_state',NEW.execution_id,clock_timestamp(),
            jsonb_strip_nulls(jsonb_build_object('interactionId',NEW.interaction_id,'reviewJobId',NEW.id,
              'reviewerAgentId',NEW.reviewer_agent_id,'state',NEW.state,'revision',NEW.revision,
              'attempt',NEW.record->'attempt','harness',NEW.record->>'provider',
              'nativeSessionId',NEW.record->>'nativeSessionId','correlationId',NEW.record->>'correlationId',
              'providerTurnOrMessageId',NEW.record->>'providerTurnOrMessageId',
              'leaseFence',NEW.lease_fence,'error',NEW.record->'error','recoveryEvidence',NEW.recovery_evidence))
            from durable_interactions i where i.id=NEW.interaction_id;
      end if;
      return NEW;
    end $$;


--
-- Name: create_run_activity_stream(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_run_activity_stream() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    insert into run_activity_streams(run_id) values(NEW.id);
    return NEW;
  end $$;


--
-- Name: current_approval_requires_publication(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_approval_requires_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  declare target_run text; target_id text; target_revision bigint; kinds text[];
  begin
    if TG_TABLE_NAME='durable_interactions' then
      target_run=NEW.run_id; target_id=NEW.id; target_revision=NEW.revision;
      kinds=array['interaction','delivery','native_event'];
      if TG_OP='UPDATE' and NEW.record is not distinct from OLD.record and NEW.status=OLD.status
        and NEW.revision=OLD.revision then return NEW; end if;
    else
      select run_id into target_run from durable_interactions where id=NEW.interaction_id;
      target_id=NEW.id; target_revision=NEW.revision; kinds=array['review','cleanup','native_event'];
      if TG_OP='UPDATE' and NEW.state=OLD.state and
        (NEW.record - array['leaseOwner','leaseToken','leaseExpiresAt','updatedAt','retryAfter']) is not distinct from
        (OLD.record - array['leaseOwner','leaseToken','leaseExpiresAt','updatedAt','retryAfter']) then return NEW; end if;
    end if;
    if not exists(select 1 from runs r join workflow_versions v on v.id=r.workflow_version_id
      where r.id=target_run and v.execution_semantics_version=3) then return NEW; end if;
    if not exists(select 1 from run_graph_sources s join run_graph_batches b
        on b.run_id=s.run_id and b.sequence=s.first_sequence
      where s.run_id=target_run and s.source_id=target_id and s.source_revision=target_revision
        and s.source_kind=any(kinds) and b.publication_xid=pg_current_xact_id()) then
      raise exception 'APPROVAL_ATOMIC_PUBLICATION_REQUIRED' using errcode='PGA03';
    end if;
    return NEW;
  end $$;


--
-- Name: eng04_check_current_publication(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_check_current_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  workflow workflows%rowtype; candidate workflow_versions%rowtype; base workflow_versions%rowtype;
  principal management_principals%rowtype; config agent_configuration_versions%rowtype; pin record;
  graph jsonb; action text; authority text := NEW.principal_id; seen text[] := array[]::text[];
  staged jsonb; journal jsonb; updated_agent agents%rowtype; prior_config agent_configuration_versions%rowtype;
  all_grants jsonb[] := array[]::jsonb[]; grants jsonb; location_revision bigint;
begin
  if NEW.publication_xid<>pg_current_xact_id() then raise exception 'CURRENT_TYPED_WRITER_REQUIRED' using errcode='PGC01'; end if;
  perform pg_advisory_xact_lock(hashtext('command:'||NEW.principal_id||':workflow.save.v3:'||NEW.command_id));
  while authority is not null loop
    if authority=any(seen) or cardinality(seen)>=16 then raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05'; end if;
    seen := array_append(seen,authority);
    select * into principal from management_principals where id=authority for share;
    if not found or principal.audience<>'operator' or principal.revoked_at is not null or principal.expires_at<=clock_timestamp() then
      raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
    end if;
    foreach action in array array['workflows:read','workflows:update','graph:read','graph:edit','graph:save','agents:read'] loop
      if not eng04_repeat_granted(principal.grants,action,NEW.workspace_id,NEW.workflow_id) then
        raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
      end if;
    end loop;
    if not eng04_repeat_granted(principal.grants,'workspace_locations:read',NEW.workspace_id,null) then
      raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
    end if;
    all_grants := array_append(all_grants,principal.grants); authority := principal.delegated_from;
  end loop;
  perform pg_advisory_xact_lock(hashtext('admission:workspace:'||NEW.workspace_id));
  select w.location_revision into location_revision from workspaces w where w.id=NEW.workspace_id and w.archived_at is null for share;
  if not found then
    raise exception 'CURRENT_LOCATION_CONFLICT' using errcode='PGC02';
  end if;
  select * into workflow from workflows where id=NEW.workflow_id and workspace_id=NEW.workspace_id for update;
  if not found or workflow.archived_at is not null or workflow.revision<>NEW.expected_revision
    or workflow.current_version_id is distinct from NEW.base_version_id or workflow.record->'executionSemanticsVersion' is distinct from '3'::jsonb then
    raise exception 'CURRENT_BASE_CONFLICT' using errcode='PGC02';
  end if;
  if NEW.base_version_id is not null then
    select * into base from workflow_versions where id=NEW.base_version_id for share;
    if not found or base.execution_semantics_version<>3 or base.workspace_id<>NEW.workspace_id or base.workflow_id<>NEW.workflow_id
      or eng04_repeat_executable_graph(workflow.record) is distinct from eng04_repeat_executable_graph(base.record->'definition') then
      raise exception 'CURRENT_BASE_CONFLICT' using errcode='PGC02';
    end if;
  elsif exists(select 1 from workflow_versions where workflow_id=NEW.workflow_id and id<>NEW.workflow_version_id)
    or workflow.record->'nodes' is distinct from '[]'::jsonb or workflow.record->'edges' is distinct from '[]'::jsonb then
    raise exception 'CURRENT_BASE_CONFLICT' using errcode='PGC02';
  end if;
  if exists(select 1 from management_command_receipts where principal_id=NEW.principal_id and operation='workflow.save.v3' and command_id=NEW.command_id) then
    raise exception 'CURRENT_RECEIPT_ALREADY_EXISTS' using errcode='PGC04';
  end if;
  select * into candidate from workflow_versions where id=NEW.workflow_version_id for share;
  if not found then raise exception 'CURRENT_VERSION_INVALID' using errcode='PGC02'; end if;
  graph := candidate.record->'definition';
  if (candidate.execution_semantics_version=3 and candidate.workspace_id=NEW.workspace_id and candidate.workflow_id=NEW.workflow_id
    and candidate.id is distinct from NEW.base_version_id
    and candidate.version=(select coalesce(max(version),0)+1 from workflow_versions where workflow_id=NEW.workflow_id and id<>candidate.id)
    and candidate.record->>'id'=candidate.id and candidate.record->>'workspaceId'=NEW.workspace_id and candidate.record->>'workflowId'=NEW.workflow_id
    and candidate.record->'executionSemanticsVersion'='3'::jsonb and candidate.record->'version'=to_jsonb(candidate.version)
    and candidate.record->>'entryNodeId'=candidate.entry_node_id and graph->>'entryNodeId'=candidate.entry_node_id
    and graph->>'id'=NEW.workflow_id and graph->>'workspaceId'=NEW.workspace_id and graph->'version'=to_jsonb(candidate.version)
    and graph->'approval'=candidate.record->'approval'
    and graph->'createdAt' is not distinct from workflow.record->'createdAt' and graph->'updatedAt'=candidate.record->'createdAt'
    and NEW.input->'expectedRevision'=to_jsonb(NEW.expected_revision)
    and NEW.input->'expectedWorkflowVersionId'=coalesce(to_jsonb(NEW.base_version_id),'null'::jsonb)
    and NEW.input->'executionSemanticsVersion'='3'::jsonb and NEW.input->>'commandId'=NEW.command_id
    and NEW.input->>'workspaceId'=NEW.workspace_id and NEW.input->>'workflowId'=NEW.workflow_id
    and (NEW.input - array['workspaceId','workflowId','executionSemanticsVersion','expectedRevision','expectedWorkflowVersionId',
      'expectedAgentConfigurationVersionIds','graph','commandId','stagedAgents','resultantAgentConfigurationVersionIds'])='{}'::jsonb
    and NEW.input #> '{graph,version}' is not distinct from workflow.record->'version'
    and (eng04_preserve_current_geometry(NEW.input->'graph',workflow.record) - array['version','updatedAt'])=(graph - array['version','updatedAt'])
    and coalesce(NEW.input->'resultantAgentConfigurationVersionIds',NEW.input->'expectedAgentConfigurationVersionIds')=candidate.record->'agentConfigurationVersionIds'
    and NEW.content_json::jsonb=jsonb_build_object('definition',graph,'configurations',candidate.record->'agentConfigurationVersionIds','entryNodeId',candidate.entry_node_id)
    and candidate.record->>'contentHash'='sha256:'||encode(sha256(convert_to(NEW.content_json,'UTF8')),'hex')) is not true then
    raise exception 'CURRENT_VERSION_INVALID' using errcode='PGC02';
  end if;
  if NEW.input ? 'stagedAgents' and jsonb_array_length(NEW.input->'stagedAgents')>0 then
    select i.record into journal from graph_edit_intents i where i.principal_id=NEW.principal_id
      and i.workspace_id=NEW.workspace_id and i.workflow_id=NEW.workflow_id and i.state='saving'
      and i.record->>'kind'='current' and i.record->'saveAttempted'='true'::jsonb
      and i.record->'saveInput'=NEW.input and i.record->>'saveInputHash'=NEW.input_hash for share;
    if not found or journal #> '{stagedDraft,resultantAgentConfigurationVersionIds}' is distinct from candidate.record->'agentConfigurationVersionIds'
      or journal #> '{stagedDraft,agentConfigurationVersionIds}' is distinct from NEW.input->'expectedAgentConfigurationVersionIds'
      or journal #> '{stagedDraft,stagedAgents}' is distinct from NEW.input->'stagedAgents'
      or not exists(select 1 from management_audit audit where audit.principal_id=NEW.principal_id
        and audit.action='graph.edit_stop_tracking' and audit.target_key='edit-intent:'||(journal->>'id')) then
      raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
    end if;
    if jsonb_array_length(NEW.input->'stagedAgents')<>(select count(distinct x #>> '{agent,id}') from jsonb_array_elements(NEW.input->'stagedAgents') x) then
      raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
    end if;
    for staged in select value from jsonb_array_elements(NEW.input->'stagedAgents') loop
      select * into updated_agent from agents where id=staged #>> '{agent,id}' and workspace_id=NEW.workspace_id for share;
      if not found or updated_agent.archived_at is not null
        or updated_agent.current_configuration_version_id is distinct from candidate.record->'agentConfigurationVersionIds'->>(staged #>> '{agent,id}')
        or updated_agent.record->>'name' is distinct from staged #>> '{agent,name}'
        or updated_agent.metadata_revision<>coalesce((staged->>'baseRevision')::bigint,0)+1
        or updated_agent.current_configuration_version_id<>'staged-config-'||encode(sha256(convert_to(NEW.command_id||':'||updated_agent.id,'UTF8')),'hex')
        or not exists(select 1 from jsonb_array_elements(journal->'agentPins') p where p->>'agentId'=updated_agent.id
          and p->'metadataRevision'=staged->'baseRevision'
          and p->'configurationVersionId'=coalesce(NEW.input->'expectedAgentConfigurationVersionIds'->updated_agent.id,'null'::jsonb)) then
        raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
      end if;
      if staged->'baseRevision'='null'::jsonb then
        if NEW.input->'expectedAgentConfigurationVersionIds' ? updated_agent.id or staged->'agent' ? 'configurationVersionId' then
          raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
        end if;
      else
        select * into prior_config from agent_configuration_versions where id=NEW.input->'expectedAgentConfigurationVersionIds'->>updated_agent.id
          and workspace_id=NEW.workspace_id and agent_id=updated_agent.id;
        if not found or staged #>> '{agent,configurationVersionId}' is distinct from prior_config.id then
          raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
        end if;
      end if;
      foreach grants in array all_grants loop
        if not eng04_repeat_granted(grants,case when staged->'baseRevision'='null'::jsonb then 'agents:create' else 'agents:update' end,NEW.workspace_id,null)
          or (updated_agent.record #>> '{harnessConfiguration,harness}'='codex'
            and updated_agent.record #>> '{harnessConfiguration,sandbox}'='danger-full-access'
            and not eng04_repeat_granted(grants,'harnesses:update',NEW.workspace_id,null))
          or exists(select 1 from workflows w where w.workspace_id=NEW.workspace_id and exists(
            select 1 from jsonb_array_elements(w.record->'nodes') n where n->>'agentId'=updated_agent.id)
            and (not eng04_repeat_granted(grants,'graph:read',NEW.workspace_id,w.id)
              or not eng04_repeat_granted(grants,'graph:edit',NEW.workspace_id,w.id))) then
          raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
        end if;
      end loop;
    end loop;
    if exists(select 1 from jsonb_each_text(candidate.record->'agentConfigurationVersionIds') p
      where not exists(select 1 from jsonb_array_elements(NEW.input->'stagedAgents') x where x #>> '{agent,id}'=p.key)
        and p.value is distinct from NEW.input->'expectedAgentConfigurationVersionIds'->>p.key)
      or exists(select 1 from jsonb_object_keys(NEW.input->'expectedAgentConfigurationVersionIds') k
        where not (candidate.record->'agentConfigurationVersionIds' ? k)) then
      raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
    end if;
  elsif NEW.input ? 'resultantAgentConfigurationVersionIds' then
    raise exception 'CURRENT_STAGED_AGENTS_INVALID' using errcode='PGC02';
  end if;
  perform eng04_validate_current_graph(graph);
  if (select count(*) from jsonb_object_keys(candidate.record->'agentConfigurationVersionIds'))<>(select count(distinct n->>'agentId') from jsonb_array_elements(graph->'nodes') n where coalesce(n->>'kind','agent')='agent') then
    raise exception 'CURRENT_CONFIGURATION_CONFLICT' using errcode='PGC02';
  end if;
  for pin in select key,value from jsonb_each_text(candidate.record->'agentConfigurationVersionIds') order by key loop
    select c.* into config from agent_configuration_versions c join agents a on a.id=c.agent_id and a.workspace_id=c.workspace_id
      where c.id=pin.value and c.agent_id=pin.key and c.workspace_id=NEW.workspace_id
        and a.archived_at is null for share of c,a;
    if not found or config.record->>'id' is distinct from config.id or config.record->>'agentId' is distinct from pin.key
      or config.record->>'workspaceId' is distinct from NEW.workspace_id or config.record->'version' is distinct from to_jsonb(config.version)
      or not exists(select 1 from jsonb_array_elements(graph->'nodes') n where n->>'agentId'=pin.key) then
      raise exception 'CURRENT_CONFIGURATION_CONFLICT' using errcode='PGC02';
    end if;
    foreach grants in array all_grants loop
      if jsonb_array_length(coalesce(config.record->'assignedSkills','[]'::jsonb))>0 and not eng04_repeat_granted(grants,'skills:read',NEW.workspace_id,null)
        or (config.record #>> '{harness,harness}'='codex' and config.record #>> '{harness,sandbox}'='danger-full-access'
          and not eng04_repeat_granted(grants,'harnesses:update',NEW.workspace_id,NEW.workflow_id)) then
        raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
      end if;
    end loop;
  end loop;
  -- Authoritative closure/approval settlement is checked by saveAdmission.ts on
  -- this locked transaction. This additional guard cannot replace that proof.
  if exists(select 1 from runs r where r.workspace_id=NEW.workspace_id and (r.workflow_id=NEW.workflow_id or exists(select 1 from jsonb_array_elements(coalesce(NEW.input->'stagedAgents','[]'::jsonb)) x
      where r.record->'agentConfigurationVersionIds' ? (x #>> '{agent,id}')))
    and (r.execution_state<>'completed' or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending))) then
    raise exception 'CURRENT_RUNS_UNSETTLED' using errcode='PGC02';
  end if;
  return NEW;
end $$;


--
-- Name: eng04_check_repeat_publication(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_check_repeat_publication() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
declare
  current_workflow workflows%rowtype; base workflow_versions%rowtype; candidate workflow_versions%rowtype;
  principal management_principals%rowtype; config agent_configuration_versions%rowtype; pin record;
  graph jsonb; action text; authority_id text := NEW.principal_id; seen text[] := array[]::text[];
  authority_grants jsonb[] := array[]::jsonb[]; grants jsonb;
begin
  if new.publication_xid<>pg_current_xact_id() then
    raise exception 'REPEAT_TYPED_WRITER_REQUIRED' using errcode='PGR01';
  end if;
  -- Same command namespace/order as PostgresCommandCoordinator; no new receipt
  -- can be confused with a historical replay. The service reauthorizes replay.
  perform pg_advisory_xact_lock(hashtext('command:'||new.principal_id||':repeat.save:'||new.command_id));
  -- Requiring each ancestor's grant for this exact resource is equivalent to
  -- the live service's scope intersection, without persisting derived authority.
  while authority_id is not null loop
    if authority_id=any(seen) or cardinality(seen)>=16 then
      raise exception 'REPEAT_PUBLICATION_ACCESS_DENIED' using errcode='PGR05';
    end if;
    seen := array_append(seen,authority_id);
    select * into principal from management_principals where id=authority_id for share;
    if not found or principal.audience<>'operator' or principal.revoked_at is not null
      or principal.expires_at<=clock_timestamp() or jsonb_typeof(principal.grants) is distinct from 'array' then
      raise exception 'REPEAT_PUBLICATION_ACCESS_DENIED' using errcode='PGR05';
    end if;
    foreach action in array array['workflows:read','workflows:update','graph:read','graph:edit','graph:save','agents:read'] loop
      if not eng04_repeat_granted(principal.grants,action,new.workspace_id,new.workflow_id) then
        raise exception 'REPEAT_PUBLICATION_ACCESS_DENIED' using errcode='PGR05';
      end if;
    end loop;
    authority_grants := array_append(authority_grants,principal.grants);
    authority_id := principal.delegated_from;
  end loop;
  if exists(select 1 from management_command_receipts where principal_id=new.principal_id
    and operation='repeat.save' and command_id=new.command_id) then
    raise exception 'REPEAT_RECEIPT_ALREADY_EXISTS' using errcode='PGR04';
  end if;
  perform 1 from workspaces where id=new.workspace_id and archived_at is null for share;
  if not found then raise exception 'REPEAT_BASE_CONFLICT' using errcode='PGR02'; end if;
  select * into current_workflow from workflows where id=new.workflow_id and workspace_id=new.workspace_id for update;
  if not found or current_workflow.archived_at is not null
    or current_workflow.revision<>new.expected_revision or current_workflow.current_version_id is distinct from new.base_version_id then
    raise exception 'REPEAT_BASE_CONFLICT' using errcode='PGR02';
  end if;
  select * into base from workflow_versions where id=new.base_version_id for share;
  if not found or base.execution_semantics_version not in (2,3)
    or base.workspace_id<>new.workspace_id or base.workflow_id<>new.workflow_id
    or (base.record->'executionSemanticsVersion'=to_jsonb(base.execution_semantics_version)
      and base.record->>'id'=base.id and base.record->>'workspaceId'=base.workspace_id and base.record->>'workflowId'=base.workflow_id
      and base.record->'version'=to_jsonb(base.version) and base.record->>'entryNodeId'=base.entry_node_id
      and base.record #> '{definition,version}'=to_jsonb(base.version)
      and base.record #> '{definition,executionSemanticsVersion}'=to_jsonb(base.execution_semantics_version)
      and base.record #>> '{definition,id}'=base.workflow_id and base.record #>> '{definition,workspaceId}'=base.workspace_id
      and base.record #>> '{definition,entryNodeId}'=base.entry_node_id
      and base.record #> '{definition,approval}'=base.record->'approval'
      and jsonb_typeof(base.record->'agentConfigurationVersionIds')='object') is not true then
    raise exception 'REPEAT_BASE_CONFLICT' using errcode='PGR02';
  end if;
  select * into candidate from workflow_versions where id=new.workflow_version_id for share;
  if not found then raise exception 'REPEAT_IMMUTABLE_VERSION_MISMATCH' using errcode='PGR02'; end if;
  graph := candidate.record->'definition';
  if (candidate.execution_semantics_version=3 and candidate.id<>base.id
    and candidate.workspace_id=base.workspace_id and candidate.workflow_id=base.workflow_id
    and candidate.entry_node_id=base.entry_node_id and candidate.version>base.version
    and candidate.version=(select coalesce(max(version),0)+1 from workflow_versions where workflow_id=new.workflow_id and id<>candidate.id)
    and candidate.record->'executionSemanticsVersion'='3'::jsonb
    and candidate.record->>'id'=candidate.id and candidate.record->>'workspaceId'=candidate.workspace_id
    and candidate.record->>'workflowId'=candidate.workflow_id and candidate.record->>'entryNodeId'=candidate.entry_node_id
    and candidate.record->'version'=to_jsonb(candidate.version)
    and graph->'executionSemanticsVersion'='3'::jsonb and graph->'version'=to_jsonb(candidate.version)
    and graph->>'id'=new.workflow_id and graph->>'workspaceId'=new.workspace_id and graph->>'entryNodeId'=candidate.entry_node_id
    and graph->'approval'=candidate.record->'approval'
    and (candidate.record - array['id','version','definition','createdAt','contentHash','executionSemanticsVersion'])
      =(base.record - array['id','version','definition','createdAt','contentHash','executionSemanticsVersion'])
    and current_workflow.record->'version'=to_jsonb(base.version)
    and eng04_repeat_executable_graph(current_workflow.record)=eng04_repeat_executable_graph(base.record->'definition')
    and (graph - array['version','executionSemanticsVersion','repeat','createdAt','updatedAt'])
      =(current_workflow.record - array['version','executionSemanticsVersion','repeat','createdAt','updatedAt'])
    and graph->'createdAt' is not distinct from base.record #> '{definition,createdAt}'
    and graph->'updatedAt'=candidate.record->'createdAt') is not true then
    raise exception 'REPEAT_IMMUTABLE_VERSION_MISMATCH' using errcode='PGR02';
  end if;
  if new.input is distinct from jsonb_build_object(
    'workspaceId',new.workspace_id,'workflowId',new.workflow_id,'commandId',new.command_id,
    'expectedRevision',new.expected_revision,'expectedWorkflowVersionId',new.base_version_id,
    'executionSemanticsVersion',3,'repeat',graph->'repeat')
    or new.content_json::jsonb is distinct from jsonb_build_object('definition',graph,
      'configurations',candidate.record->'agentConfigurationVersionIds','entryNodeId',candidate.entry_node_id)
    or candidate.record->>'contentHash' is distinct from 'sha256:'||encode(sha256(convert_to(new.content_json,'UTF8')),'hex') then
    raise exception 'REPEAT_IMMUTABLE_VERSION_MISMATCH' using errcode='PGR02';
  end if;
  perform eng04_validate_repeat_plan(graph);
  if (select count(*) from jsonb_object_keys(candidate.record->'agentConfigurationVersionIds'))<>jsonb_array_length(graph->'nodes') then
    raise exception 'REPEAT_CONFIGURATION_PIN_MISMATCH' using errcode='PGR02';
  end if;
  for pin in select key,value from jsonb_each_text(candidate.record->'agentConfigurationVersionIds') order by value loop
    select * into config from agent_configuration_versions where id=pin.value and agent_id=pin.key and workspace_id=new.workspace_id for share;
    if not found or config.record->>'id' is distinct from config.id or config.record->>'workspaceId' is distinct from config.workspace_id
      or config.record->>'agentId' is distinct from config.agent_id
      or not exists(select 1 from jsonb_array_elements(graph->'nodes') n where n->>'agentId'=pin.key) then
      raise exception 'REPEAT_CONFIGURATION_PIN_MISMATCH' using errcode='PGR02';
    end if;
    foreach grants in array authority_grants loop
      if jsonb_array_length(coalesce(config.record->'assignedSkills','[]'::jsonb))>0
        and not eng04_repeat_granted(grants,'skills:read',new.workspace_id,null) then
        raise exception 'REPEAT_PUBLICATION_ACCESS_DENIED' using errcode='PGR05';
      end if;
      if config.record #>> '{harness,harness}'='codex' and config.record #>> '{harness,sandbox}'='danger-full-access'
        and not eng04_repeat_granted(grants,'harnesses:update',new.workspace_id,new.workflow_id) then
        raise exception 'REPEAT_PUBLICATION_ACCESS_DENIED' using errcode='PGR05';
      end if;
    end loop;
  end loop;
  return new;
end $$;


--
-- Name: eng04_current_publication_committed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_current_publication_committed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
declare principal management_principals%rowtype; authority text := NEW.principal_id; seen text[] := array[]::text[];
begin
  -- Row locks prevent concurrent grant changes; wall-clock expiry still needs
  -- a deferred check before the atomic publication can commit.
  while authority is not null loop
    if authority=any(seen) or cardinality(seen)>=16 then raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05'; end if;
    seen := array_append(seen,authority);
    select * into principal from management_principals where id=authority for share;
    if not found or principal.audience<>'operator' or principal.revoked_at is not null or principal.expires_at<=clock_timestamp() then
      raise exception 'CURRENT_ACCESS_DENIED' using errcode='PGC05';
    end if;
    authority := principal.delegated_from;
  end loop;
  if not exists(select 1 from management_command_receipts r join workflow_versions v on v.id=NEW.workflow_version_id
    join workflows w on w.id=NEW.workflow_id and w.workspace_id=NEW.workspace_id
    where r.principal_id=NEW.principal_id and r.operation='workflow.save.v3' and r.command_id=NEW.command_id
      and r.target_key='workflow:'||NEW.workflow_id||':definition' and r.input_hash=NEW.input_hash and r.xmin=NEW.publication_xid::xid
      and r.result=jsonb_build_object('workspaceId',NEW.workspace_id,'workflowId',NEW.workflow_id,
        'revision',NEW.expected_revision+1,'currentVersionId',v.id,'version',v.record) ||
        case when jsonb_array_length(coalesce(NEW.input->'stagedAgents','[]'::jsonb))>0 then
          jsonb_build_object('agents',(select jsonb_agg(jsonb_build_object('agent',a.record,'metadataRevision',a.metadata_revision) order by x.ordinal)
            from jsonb_array_elements(NEW.input->'stagedAgents') with ordinality x(value,ordinal)
            join agents a on a.id=x.value #>> '{agent,id}' and a.workspace_id=NEW.workspace_id))
        else '{}'::jsonb end
      and w.current_version_id=v.id and w.revision=NEW.expected_revision+1 and w.record=v.record->'definition')
    or not exists(select 1 from management_audit a where a.principal_id=NEW.principal_id and a.source=NEW.source
      and a.action='workflow.save.v3' and a.target_key='workflow:'||NEW.workflow_id||':definition' and a.outcome='succeeded'
      and a.details->>'commandId'=NEW.command_id and a.xmin=NEW.publication_xid::xid) then
    raise exception 'CURRENT_ATOMIC_RECEIPT_REQUIRED' using errcode='PGC04';
  end if;
  return NEW;
end $$;


--
-- Name: eng04_preserve_current_geometry(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_preserve_current_geometry(authored jsonb, current_graph jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  select authored || jsonb_build_object('nodes', (
    select coalesce(jsonb_agg(case when p.node is null then n.node else
      (n.node - array['position','width','height']) ||
      (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p.node)
        where key in ('position','width','height')) end order by n.ordinal),'[]'::jsonb)
    from jsonb_array_elements(authored->'nodes') with ordinality as n(node,ordinal)
    left join jsonb_array_elements(current_graph->'nodes') as p(node) on p.node->>'id'=n.node->>'id'
  ))
$$;


--
-- Name: eng04_publish_current_workflow(text, text, jsonb, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_publish_current_workflow(principal text, source text, input jsonb, input_hash text, version_id text, content_json text) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
declare revision bigint;
begin
  insert into current_workflow_publications(workflow_version_id,workspace_id,workflow_id,base_version_id,expected_revision,
    principal_id,command_id,source,input_hash,input,content_json)
  values(version_id,input->>'workspaceId',input->>'workflowId',input->>'expectedWorkflowVersionId',(input->>'expectedRevision')::bigint,
    principal,input->>'commandId',source,input_hash,input,content_json);
  update workflows w set record=(select v.record->'definition' from workflow_versions v where v.id=version_id),
    current_version_id=version_id,revision=w.revision+1
    where w.workspace_id=input->>'workspaceId' and w.id=input->>'workflowId'
      and w.revision=(input->>'expectedRevision')::bigint and w.current_version_id is not distinct from input->>'expectedWorkflowVersionId'
    returning w.revision into revision;
  if not found then raise exception 'CURRENT_BASE_CONFLICT' using errcode='PGC02'; end if;
  return revision;
end $$;


--
-- Name: eng04_publish_repeat_workflow(text, text, jsonb, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_publish_repeat_workflow(principal text, source text, input jsonb, input_hash text, version_id text, content_json text) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
declare published_revision bigint;
begin
  insert into repeat_workflow_publications(workflow_version_id,workspace_id,workflow_id,base_version_id,
    expected_revision,principal_id,command_id,source,input_hash,input,content_json)
  values(version_id,input->>'workspaceId',input->>'workflowId',input->>'expectedWorkflowVersionId',
    (input->>'expectedRevision')::bigint,principal,input->>'commandId',source,input_hash,input,content_json);
  update workflows set current_version_id=version_id,
    record=(select record->'definition' from workflow_versions where id=version_id),revision=revision+1
    where id=input->>'workflowId' and workspace_id=input->>'workspaceId'
      and current_version_id=input->>'expectedWorkflowVersionId' and revision=(input->>'expectedRevision')::bigint
    returning revision into published_revision;
  if not found then raise exception 'REPEAT_BASE_CONFLICT' using errcode='PGR02'; end if;
  return published_revision;
end $$;


--
-- Name: eng04_repeat_executable_graph(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_repeat_executable_graph(graph jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  select (graph - array['name','description','version','createdAt','updatedAt','nodes'])
    || jsonb_build_object('nodes', (select coalesce(jsonb_agg(
      node - array['name','label','position','width','height'] order by ordinal),'[]'::jsonb)
      from jsonb_array_elements(graph->'nodes') with ordinality as n(node,ordinal)))
$$;


--
-- Name: eng04_repeat_granted(jsonb, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_repeat_granted(grants jsonb, action text, workspace text, workflow text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  select exists(select 1 from jsonb_array_elements(grants) g
    where jsonb_typeof(g->'actions')='array' and g->'actions' ? action and jsonb_typeof(g->'scope')='object'
      and (not (g->'scope' ? 'workspaceIds') or (workspace is not null and jsonb_typeof(g #> '{scope,workspaceIds}')='array' and g #> '{scope,workspaceIds}' ? workspace))
      and (not (g->'scope' ? 'workflowIds') or (workflow is not null and jsonb_typeof(g #> '{scope,workflowIds}')='array' and g #> '{scope,workflowIds}' ? workflow))
      and not (g->'scope' ? 'runIds'))
$$;


--
-- Name: eng04_repeat_publication_committed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_repeat_publication_committed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
begin
  if not exists(select 1 from management_command_receipts r join workflow_versions v on v.id=NEW.workflow_version_id
    join workflows w on w.id=NEW.workflow_id and w.workspace_id=NEW.workspace_id
    where r.principal_id=NEW.principal_id and r.operation='repeat.save' and r.command_id=NEW.command_id
      and r.target_key='workflow:'||NEW.workflow_id||':repeat' and r.input_hash=NEW.input_hash
      and r.xmin=NEW.publication_xid::xid
      and r.result=jsonb_build_object('workspaceId',NEW.workspace_id,'workflowId',NEW.workflow_id,
        'revision',NEW.expected_revision+1,'currentVersionId',v.id,'version',v.record)
      and w.current_version_id=v.id and w.revision=NEW.expected_revision+1 and w.record=v.record->'definition')
    or not exists(select 1 from management_audit a where a.principal_id=NEW.principal_id and a.source=NEW.source
      and a.action='repeat.save' and a.target_key='workflow:'||NEW.workflow_id||':repeat' and a.outcome='succeeded'
      and a.details->>'commandId'=NEW.command_id and a.xmin=NEW.publication_xid::xid) then
    raise exception 'REPEAT_ATOMIC_RECEIPT_REQUIRED' using errcode='PGR04';
  end if;
  return NEW;
end $$;


--
-- Name: eng04_repeat_publication_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_repeat_publication_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
begin raise exception 'REPEAT_PUBLICATION_IMMUTABLE' using errcode='PGR06'; end $$;


--
-- Name: eng04_validate_current_graph(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_validate_current_graph(graph jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare edge jsonb; node jsonb; declaration jsonb; entry text := graph->>'entryNodeId';
begin
  if (graph->'executionSemanticsVersion'='3'::jsonb and jsonb_typeof(graph->'nodes')='array'
    and jsonb_typeof(graph->'edges')='array' and jsonb_typeof(graph->'entryNodeId')='string') is not true then
    raise exception 'CURRENT_GRAPH_INVALID' using errcode='PGC03';
  end if;
  if jsonb_array_length(graph->'nodes') not between 1 and 1000 or jsonb_array_length(graph->'edges')>8000 then
    raise exception 'CURRENT_GRAPH_INVALID' using errcode='PGC03';
  end if;
  if (jsonb_typeof(graph->'executionPolicy')='object'
    and jsonb_typeof(graph #> '{executionPolicy,maxParallelism}')='number'
    and jsonb_typeof(graph #> '{executionPolicy,maxNodeExecutions}')='number') is not true then
    raise exception 'CURRENT_EXECUTION_POLICY_INVALID' using errcode='PGC03';
  end if;
  if (graph #>> '{executionPolicy,maxParallelism}')::numeric<1
    or (graph #>> '{executionPolicy,maxParallelism}')::numeric<>trunc((graph #>> '{executionPolicy,maxParallelism}')::numeric)
    or (graph #>> '{executionPolicy,maxNodeExecutions}')::numeric<jsonb_array_length(graph->'nodes')
    or (graph #>> '{executionPolicy,maxNodeExecutions}')::numeric<>trunc((graph #>> '{executionPolicy,maxNodeExecutions}')::numeric) then
    raise exception 'CURRENT_EXECUTION_POLICY_INVALID' using errcode='PGC03';
  end if;

  for node in select value from jsonb_array_elements(graph->'nodes') loop
    if coalesce(node->>'kind','agent') not in ('agent','job') then raise exception 'CURRENT_EXECUTOR_KIND_INVALID' using errcode='PGC03'; end if;
    if node->>'kind'='job' then
      if node ? 'agentId' or node ? 'initialPrompt' or node ? 'graphqlTools' or graph ? 'handoffs'
        or not exists(select 1 from job_definition_versions j where j.id=node->>'jobDefinitionVersionId'
          and j.definition_id=node->>'jobDefinitionId' and j.workspace_id=graph->>'workspaceId'
          and to_jsonb(j.revision)=node->'jobDefinitionRevision' and j.record->>'versionId'=j.id
          and j.record->>'id'=j.definition_id and j.record->>'workspaceId'=j.workspace_id and j.record->'revision'=node->'jobDefinitionRevision')
        then raise exception 'JOB_VERSION_PIN_CONFLICT' using errcode='PGC03'; end if;
    elsif jsonb_typeof(node->'agentId') is distinct from 'string' then raise exception 'CURRENT_AGENT_ID_INVALID' using errcode='PGC03'; end if;
  end loop;
  if graph ? 'repeat' then perform eng04_validate_repeat_plan(graph); end if;

  if jsonb_array_length(graph->'nodes')<>(select count(distinct n->>'id') from jsonb_array_elements(graph->'nodes') n)
    or jsonb_array_length(graph->'edges')<>(select count(distinct e->>'id') from jsonb_array_elements(graph->'edges') e)
    or not exists(select 1 from jsonb_array_elements(graph->'nodes') n where n->>'id'=entry) then
    raise exception 'CURRENT_GRAPH_INVALID' using errcode='PGC03';
  end if;
  for edge in select value from jsonb_array_elements(graph->'edges') loop
    if (edge->>'kind' in ('execution','approval') and edge->>'source'<>edge->>'target'
      and exists(select 1 from jsonb_array_elements(graph->'nodes') n where n->>'id'=edge->>'source')
      and exists(select 1 from jsonb_array_elements(graph->'nodes') n where n->>'id'=edge->>'target')) is not true
      or (edge->>'kind'='execution' and edge->>'target'=entry) then
      raise exception 'CURRENT_GRAPH_INVALID' using errcode='PGC03';
    end if;
  end loop;
  -- UNION terminates even for malformed cycles. No execution back-edge is a repeat.
  if exists(with recursive reach(source,target) as (
    select e->>'source',e->>'target' from jsonb_array_elements(graph->'edges') e where e->>'kind'='execution'
    union select r.source,e->>'target' from reach r join jsonb_array_elements(graph->'edges') e
      on e->>'source'=r.target and e->>'kind'='execution'
  ) select 1 from reach where source=target) then
    raise exception 'CURRENT_GRAPH_CYCLE' using errcode='PGC03';
  end if;
  for node in select value from jsonb_array_elements(graph->'nodes') loop
    if node ? 'choice' then
      for declaration in select value from jsonb_array_elements(node #> '{choice,outcomes}') loop
        if declaration #>> '{target,kind}'='edge' and not exists(
          select 1 from jsonb_array_elements(graph->'edges') e where e->>'kind'='execution'
            and e->>'source'=node->>'id' and e->>'id'=declaration #>> '{target,relationshipId}') then
          raise exception 'CURRENT_GRAPH_CHOICE_INVALID' using errcode='PGC03';
        end if;
      end loop;
      if exists(select 1 from jsonb_array_elements(graph->'edges') e where e->>'kind'='execution' and e->>'source'=node->>'id'
        and not exists(select 1 from jsonb_array_elements(node #> '{choice,outcomes}') d where d #>> '{target,relationshipId}'=e->>'id')) then
        raise exception 'CURRENT_GRAPH_CHOICE_INVALID' using errcode='PGC03';
      end if;
    end if;
  end loop;
end $$;


--
-- Name: eng04_validate_repeat_plan(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.eng04_validate_repeat_plan(graph jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
declare
  plan jsonb := graph->'repeat'; block jsonb; members text[];
  seen_blocks text[] := array[]::text[]; seen_members text[] := array[]::text[];
  outcomes jsonb; again jsonb; early jsonb; cap numeric; required numeric;
begin
  if (jsonb_typeof(graph->'nodes')='array' and jsonb_typeof(graph->'edges')='array'
    and jsonb_typeof(plan)='object' and plan->'contractVersion'='1'::jsonb
    and (plan - array['contractVersion','blocks'])='{}'::jsonb
    and jsonb_typeof(plan->'blocks')='array') is not true then
    raise exception 'REPEAT_PLAN_INVALID' using errcode='PGR03';
  end if;
  if jsonb_array_length(plan->'blocks') not between 1 and 1000
    or jsonb_array_length(graph->'nodes') not between 1 and 1000
    or jsonb_array_length(graph->'edges')>8000 then
    raise exception 'REPEAT_PLAN_INVALID' using errcode='PGR03';
  end if;
  required := jsonb_array_length(graph->'nodes');
  for block in select value from jsonb_array_elements(plan->'blocks') loop
    if (jsonb_typeof(block)='object'
      and block ?& array['id','nodeIds','entryNodeId','exitNodeId','maxOccurrences','repeatOutcome','earlyExitOutcome','limitExit']
      and (block - array['id','nodeIds','entryNodeId','exitNodeId','maxOccurrences','repeatOutcome','earlyExitOutcome','limitExit'])='{}'::jsonb
      and jsonb_typeof(block->'id')='string' and block->>'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      and jsonb_typeof(block->'nodeIds')='array'
      and jsonb_typeof(block->'entryNodeId')='string' and jsonb_typeof(block->'exitNodeId')='string'
      and jsonb_typeof(block->'maxOccurrences')='number'
      and jsonb_typeof(block->'repeatOutcome')='string' and jsonb_typeof(block->'earlyExitOutcome')='string'
      and block->>'repeatOutcome'<>block->>'earlyExitOutcome') is not true then
      raise exception 'REPEAT_PLAN_INVALID' using errcode='PGR03';
    end if;
    cap := (block->>'maxOccurrences')::numeric;
    if cap<>trunc(cap) or cap not between 1 and 2147483647
      or jsonb_array_length(block->'nodeIds') not between 1 and 1000
      or exists(select 1 from jsonb_array_elements(block->'nodeIds') n
        where (jsonb_typeof(n)='string' and n #>> '{}' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$') is not true) then
      raise exception 'REPEAT_PLAN_INVALID' using errcode='PGR03';
    end if;
    select array_agg(value) into members from jsonb_array_elements_text(block->'nodeIds');
    if block->>'id'=any(seen_blocks) or members && seen_members
      or cardinality(members)<>(select count(distinct m) from unnest(members) m)
      or not (block->>'entryNodeId'=any(members) and block->>'exitNodeId'=any(members))
      or exists(select 1 from unnest(members) m where not exists(
        select 1 from jsonb_array_elements(graph->'nodes') n where n->>'id'=m)) then
      raise exception 'REPEAT_SCOPE_INVALID' using errcode='PGR03';
    end if;
    seen_blocks := array_append(seen_blocks,block->>'id');
    seen_members := seen_members || members;
    -- UNION, not UNION ALL: reachability terminates even on a corrupt base cycle.
    if exists(with recursive reach(direction,id) as (
      select false,block->>'entryNodeId' union select true,block->>'exitNodeId'
      union select r.direction,case when r.direction then e->>'source' else e->>'target' end
        from reach r join jsonb_array_elements(graph->'edges') e
          on (case when r.direction then e->>'target' else e->>'source' end)=r.id
        where e->>'kind'='execution' and e->>'source'=any(members) and e->>'target'=any(members)
    ) select 1 from unnest(members) m where not exists(select 1 from reach where not direction and id=m)
        or not exists(select 1 from reach where direction and id=m)) then
      raise exception 'REPEAT_SCOPE_MUST_BE_SINGLE_ENTRY_EXIT' using errcode='PGR03';
    end if;
    if exists(select 1 from jsonb_array_elements(graph->'edges') e where e->>'kind'='execution' and (
      (not (e->>'source'=any(members)) and e->>'target'=any(members) and e->>'target'<>block->>'entryNodeId')
      or (e->>'source'=any(members) and not (e->>'target'=any(members)) and e->>'source'<>block->>'exitNodeId')
      or (e->>'source'=block->>'exitNodeId' and e->>'target'=any(members)))) then
      raise exception 'REPEAT_SIDE_ENTRY_OR_EXIT' using errcode='PGR03';
    end if;
    select n #> '{choice,outcomes}' into outcomes from jsonb_array_elements(graph->'nodes') n
      where n->>'id'=block->>'exitNodeId';
    if jsonb_typeof(outcomes) is distinct from 'array' then
      raise exception 'REPEAT_EXIT_REQUIRES_TWO_OUTCOMES' using errcode='PGR03';
    end if;
    if jsonb_array_length(outcomes)<>2 then
      raise exception 'REPEAT_EXIT_REQUIRES_TWO_OUTCOMES' using errcode='PGR03';
    end if;
    select o into again from jsonb_array_elements(outcomes) o where o->>'outcome'=block->>'repeatOutcome';
    select o into early from jsonb_array_elements(outcomes) o where o->>'outcome'=block->>'earlyExitOutcome';
    if again is null or early is null or again->'target' is distinct from block->'limitExit' then
      raise exception 'REPEAT_LIMIT_ROUTE_MISMATCH' using errcode='PGR03';
    end if;
    if exists(select 1 from jsonb_array_elements(graph->'nodes') n,
        jsonb_array_elements(coalesce(n #> '{choice,outcomes}','[]'::jsonb)) o
      where n->>'id'=any(members) and n->>'id'<>block->>'exitNodeId' and o #>> '{target,kind}'='branch_end') then
      raise exception 'REPEAT_INTERIOR_BRANCH_END_UNSUPPORTED' using errcode='PGR03';
    end if;
    required := required + (cap-1)*cardinality(members);
  end loop;
  if jsonb_typeof(graph #> '{executionPolicy,maxNodeExecutions}') is distinct from 'number' then
    raise exception 'REPEAT_EXECUTION_BUDGET_INSUFFICIENT' using errcode='PGR03';
  end if;
  if required>9007199254740991 or (graph #>> '{executionPolicy,maxNodeExecutions}')::numeric<required then
    raise exception 'REPEAT_EXECUTION_BUDGET_INSUFFICIENT' using errcode='PGR03';
  end if;
end $_$;


--
-- Name: file_reference_immutable_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.file_reference_immutable_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if TG_OP = 'DELETE' then
        if old.scope_kind in ('workflow_reference','workspace_reference') then
          raise exception 'Permanent reference removal must retain its tombstone.';
        end if;
        return old;
      end if;
      if old.scope_kind <> 'temporary' or new.scope_kind <> 'temporary' then
        if row(old.file_id,old.owner_principal_id,old.current_revision_id,old.scope_kind,
               old.chat_kind,old.operator_id,old.conversation_id,old.agent_id,old.workspace_id,
               old.workflow_id,old.run_id,old.execution_id,old.created_at)
          is distinct from
           row(new.file_id,new.owner_principal_id,new.current_revision_id,new.scope_kind,
               new.chat_kind,new.operator_id,new.conversation_id,new.agent_id,new.workspace_id,
               new.workflow_id,new.run_id,new.execution_id,new.created_at) then
          raise exception 'Permanent reference identity, scope and pinned revision are immutable.';
        end if;
        if (old.state = 'removed' and new.state <> 'removed')
          or (old.state = 'ready' and new.state = 'pending') then
          raise exception 'Permanent references cannot be resurrected or overwritten.';
        end if;
      end if;
      return new;
    end $$;


--
-- Name: file_revision_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.file_revision_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      raise exception 'File revisions are immutable; retain revision metadata after byte removal.';
    end $$;


--
-- Name: file_tool_fact_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.file_tool_fact_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      raise exception 'File tool receipts, turn links and read provenance are append-only.';
    end $$;


--
-- Name: graphql_keep_run_stop_cause(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_keep_run_stop_cause() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if TG_OP='UPDATE' and OLD.stop_cause is not null then
        NEW.stop_cause := OLD.stop_cause;
      end if;
      if NEW.stop_cause is not null then
        NEW.record := jsonb_set(NEW.record,'{stopCause}',NEW.stop_cause,true);
      else
        NEW.record := NEW.record - 'stopCause';
      end if;
      return NEW;
    end $$;


--
-- Name: graphql_live_cleanup_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_live_cleanup_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if TG_OP='INSERT' or OLD.pending is distinct from NEW.pending then
        perform graphql_record_live_run(NEW.run_id);
      end if;
      return NEW;
    end $$;


--
-- Name: graphql_live_execution_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_live_execution_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if TG_OP='INSERT' or (OLD.record->>'state') is distinct from (NEW.record->>'state') then
        perform graphql_record_live_execution(NEW.id);
      end if;
      return NEW;
    end $$;


--
-- Name: graphql_live_interaction_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_live_interaction_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if TG_OP='INSERT' or
        (OLD.record->>'status',OLD.record->>'deliveryState') is distinct from
        (NEW.record->>'status',NEW.record->>'deliveryState') then
        perform graphql_record_live_interaction(NEW.id);
      end if;
      return NEW;
    end $$;


--
-- Name: graphql_live_review_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_live_review_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if TG_OP='INSERT' or
        (OLD.record->>'state',OLD.record->>'attempt',OLD.record->>'providerTurnOrMessageId',OLD.record->'cleanup') is distinct from
        (NEW.record->>'state',NEW.record->>'attempt',NEW.record->>'providerTurnOrMessageId',NEW.record->'cleanup') then
        perform graphql_record_live_review(NEW.id);
      end if;
      return NEW;
    end $$;


--
-- Name: graphql_live_run_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_live_run_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if TG_OP='INSERT' or (OLD.record->>'executionState',OLD.record->'stopCause')
        is distinct from (NEW.record->>'executionState',NEW.record->'stopCause') then
        perform graphql_record_live_run(NEW.id);
      end if;
      return NEW;
    end $$;


--
-- Name: graphql_record_live_execution(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_record_live_execution(p_id text) RETURNS void
    LANGUAGE sql
    AS $$
      insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select e.run_id,'backend','node_state_changed',e.id,clock_timestamp(),
        jsonb_build_object('liveNodeEvent',1,'topic','execution','workflowNodeId',e.workflow_node_id,
          'agentId',e.agent_id,'attempt',e.attempt,'state',e.record->>'state')
      from harness_executions e where e.id=p_id;
    $$;


--
-- Name: graphql_record_live_interaction(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_record_live_interaction(p_id text) RETURNS void
    LANGUAGE sql
    AS $$
      insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select i.run_id,'backend','interaction_delivery_state',e.id,clock_timestamp(),
        jsonb_build_object('liveNodeEvent',1,'topic','interaction','interactionId',i.id,
          'workflowNodeId',e.workflow_node_id,'agentId',e.agent_id,
          'status',i.record->>'status','deliveryState',i.record->>'deliveryState',
          'handler',i.record->'approval'->>'handler',
          'reviewerAgentId',i.record->'approval'->>'designatedOrchestratorAgentId')
      from durable_interactions i join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
      where i.id=p_id;
    $$;


--
-- Name: graphql_record_live_review(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_record_live_review(p_id text) RETURNS void
    LANGUAGE sql
    AS $$
      insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select i.run_id,'backend','review_job_state',e.id,clock_timestamp(),
        jsonb_build_object('liveNodeEvent',1,'topic','review','reviewJobId',j.id,
          'workflowNodeId',e.workflow_node_id,'agentId',e.agent_id,'reviewerAgentId',j.reviewer_agent_id,
          'requestingNodeId',requester.workflow_node_id,'interactionId',i.id,
          'state',j.record->>'state','attempt',j.record->'attempt','revision',j.revision::text,
          'correlationId',j.record->>'correlationId','providerTurnOrMessageId',j.record->>'providerTurnOrMessageId',
          'cleanupComplete',j.record->'cleanup'->>'completedAt' is not null,
          'cleanupPending',j.record->'cleanup' is not null and j.record->'cleanup'->>'completedAt' is null)
      from review_jobs j join durable_interactions i on i.id=j.interaction_id
      join harness_executions e on e.id=j.execution_id and e.run_id=i.run_id and e.agent_id=j.reviewer_agent_id
      join harness_executions requester on requester.id=i.execution_id and requester.run_id=i.run_id
      where j.id=p_id;
    $$;


--
-- Name: graphql_record_live_run(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_record_live_run(p_id text) RETURNS void
    LANGUAGE sql
    AS $$
      insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select r.id,'backend','run_state_changed',null,clock_timestamp(),
        jsonb_build_object('liveNodeEvent',1,'topic','run','executionState',r.record->>'executionState')
      from runs r where r.id=p_id;
    $$;


--
-- Name: graphql_run_reliability_fence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphql_run_reliability_fence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if OLD.stop_requested_at is not null and NEW.stop_requested_at is distinct from OLD.stop_requested_at then
        raise exception using errcode='PGR01', message='A durable Stop fence cannot be cleared or replaced.';
      end if;
      -- Existing v1 behavior remains untouched. No timestamp/transport inference.
      if OLD.record->>'executionSemanticsVersion'='2' then
        if NEW.record->>'executionSemanticsVersion' is distinct from '2'
          or NEW.workflow_version_id is distinct from OLD.workflow_version_id
          or NEW.record->>'workflowVersionId' is distinct from OLD.record->>'workflowVersionId'
          or NEW.record->>'executionState' is distinct from NEW.execution_state then
          raise exception using errcode='PGR02', message='Immutable Run semantics and lifecycle columns must agree.';
        end if;
        if OLD.execution_state='completed' and
          (NEW.execution_state is distinct from OLD.execution_state or
           NEW.record->>'outcome' is distinct from OLD.record->>'outcome' or
           NEW.record->'result' is distinct from OLD.record->'result' or
           NEW.record->>'finishedAt' is distinct from OLD.record->>'finishedAt') then
          raise exception using errcode='PGR02', message='A terminal Run cannot be rewritten or resumed.';
        end if;
        if NEW.stop_requested_at is not null and NEW.execution_state is distinct from OLD.execution_state
          and NEW.execution_state not in ('completed','interrupted') then
          raise exception using errcode='PGR01', message='Stopped work cannot resume.';
        end if;
        if NEW.stop_requested_at is not null and OLD.execution_state<>'completed'
          and NEW.execution_state='completed' and NEW.record->>'outcome'='succeeded' then
          raise exception using errcode='PGR01', message='Stop won before completion; late evidence cannot commit Run success.';
        end if;
      end if;
      return NEW;
    end $$;


--
-- Name: guard_agent_native_placement(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_agent_native_placement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare intent execution_dispatch_intents%rowtype; material source_execution_materializations%rowtype;
begin
 select * into intent from execution_dispatch_intents where execution_id=NEW.execution_id;
 select * into material from source_execution_materializations where materialization_id=(NEW.record#>>'{materialization,receipt,materializationId}')::uuid;
 if intent.operation_id is distinct from NEW.operation_id or intent.binding_hash is distinct from NEW.accepted_binding_hash
   or material.execution_id is distinct from NEW.execution_id or material.operation_id is distinct from NEW.operation_id
   or material.attempt_id is distinct from intent.attempt_id then
  raise exception 'NATIVE_PLACEMENT_CONFLICT' using errcode='P2844';
 end if;
 return NEW;
end $$;


--
-- Name: guard_agent_owner_grant(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_agent_owner_grant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
 if NEW.scheduler_owner_id is distinct from pg_backend_pid()::text
  or not exists(select 1 from harness_executions e join pg_stat_activity a on a.pid=pg_backend_pid()
    where e.id=NEW.execution_id and (extract(epoch from a.backend_start)*1000000)::bigint::text=NEW.scheduler_owner_fence
    and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory' and l.classid=810002::oid
      and l.objid=(hashtext(e.run_id)::bigint & 4294967295)::oid and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted))
  or NEW.epoch='1' and not exists(select 1 from harness_executions where id=NEW.execution_id and xmin=pg_current_xact_id()::text::xid)
  or NEW.epoch<>'1' and not exists(select 1 from remote_execution_owner_reconciliations x
    where x.operation_id=NEW.operation_id and x.transition#>>'{nextOwner,grantId}'=NEW.grant_id and x.transition#>>'{nextOwner,epoch}'=NEW.epoch) then
  raise exception 'AGENT_OWNER_GRANT_CONFLICT' using errcode='P2844';
 end if;
 return NEW;
end $$;


--
-- Name: guard_dispatch_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_dispatch_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare e harness_executions%rowtype; x run_repeat_executions%rowtype; s run_repeat_slots%rowtype;
begin
 select * into e from harness_executions where id=NEW.execution_id;
 select * into x from run_repeat_executions where execution_id=NEW.execution_id;
 select * into s from run_repeat_slots where slot_id=x.slot_id;
 if not exists(select 1 from harness_executions where id=NEW.execution_id and xmin=pg_current_xact_id()::text::xid)
   or x.execution_id is null or x.run_id is distinct from NEW.run_id
   or x.technical_attempt is distinct from (NEW.record->>'technicalAttempt')::integer
   or x.occurrence_id is distinct from (NEW.record->>'occurrenceId')
   or s.input_digest is distinct from (NEW.record->>'inputDigest')
   or e.run_id is distinct from NEW.run_id or e.record->>'workflowNodeId' is distinct from NEW.node_id
   or NEW.scheduler_owner_id is distinct from pg_backend_pid()::text
   or not exists(select 1 from pg_stat_activity a where a.pid=pg_backend_pid()
     and (extract(epoch from a.backend_start)*1000000)::bigint::text=NEW.scheduler_owner_fence
     and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory'
       and l.classid=810002::oid and l.objid=(hashtext(NEW.run_id)::bigint & 4294967295)::oid
       and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted)) then
   raise exception 'DISPATCH_OWNER_CONFLICT' using errcode='P2844';
 end if;
 return NEW;
end $$;


--
-- Name: guard_execution_native_recovery(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_execution_native_recovery() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare e harness_executions%rowtype; c execution_native_closures%rowtype; native jsonb; r runs%rowtype;
begin
  if TG_OP<>'INSERT' then
    raise exception 'NATIVE_WORKFLOW_RECOVERY_IMMUTABLE' using errcode='P2655';
  end if;
  select * into e from harness_executions where id=NEW.execution_id;
  select * into r from runs where id=e.run_id for update;
  select * into e from harness_executions where id=NEW.execution_id for update;
  select * into c from execution_native_closures where generation=NEW.generation for update;
  select reference into native from execution_native_sessions where execution_id=e.id for share;
  if c.execution_id is distinct from e.id or c.execution_identity is distinct from NEW.execution_identity
    or NEW.execution_identity is distinct from jsonb_strip_nulls(jsonb_build_object(
      'id',e.id,'runId',e.run_id,'workflowNodeId',e.record->>'workflowNodeId',
      'agentId',e.record->>'agentId','agentConfigurationVersionId',e.record->>'agentConfigurationVersionId',
      'attempt',e.record->'attempt','workingDirectory',e.record->>'workingDirectory','runtimeDirectory',e.record->>'runtimeDirectory'))
    or r.record->>'id' is distinct from r.id or r.record->>'executionState' is distinct from r.execution_state
    or r.record->'executionSemanticsVersion' is distinct from '3'::jsonb
    or not (r.stop_requested_at is not null or r.execution_state='completed'
      or exists(select 1 from run_cleanup_intents where run_id=r.id and pending)
      or exists(select 1 from approval_execution_state b where b.execution_id=e.id and b.failure_result is not null)
      or coalesce((r.execution_state in ('running','waiting') and r.record->>'outcome'='pending'
        and e.record->>'state'='completed' and jsonb_typeof(e.record->'result')='object'
        and e.record->>'finishedAt' is not null and native is not null
        and exists(select 1 from execution_native_sessions s where s.execution_id=e.id
          and s.workflow_finalized_at is null)),false))
    or exists(select 1 from execution_native_closures n where n.execution_id=e.id and n.generation>c.generation)
    or exists(select 1 from execution_native_closures n where n.execution_id=e.id
      and n.generation<c.generation and n.closed_at is null and n.detached_at is null)
    or NEW.reference is distinct from native
    or (e.record->>'nativeSessionId') is distinct from (native->>'nativeSessionId')
    or (c.expected_reference is not null and c.expected_reference is distinct from native)
    or (c.detached_at is not null and c.detached_reference is distinct from native)
    or NEW.owner_id is distinct from pg_backend_pid()::text
    or not exists(select 1 from pg_stat_activity a where a.pid=pg_backend_pid()
      and (extract(epoch from a.backend_start)*1000000)::bigint::text=NEW.owner_fence
      and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory'
        and l.classid=810002::oid and l.objid=(hashtext(r.id)::bigint & 4294967295)::oid
        and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted)) then
    raise exception 'NATIVE_WORKFLOW_RECOVERY_CONFLICT' using errcode='P2655';
  end if;
  return NEW;
end $$;


--
-- Name: guard_legacy_workflow_schedule(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_legacy_workflow_schedule() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if NEW.record->>'kind'='schedule' then
        perform id from workflows where id=NEW.workflow_id and workspace_id=NEW.workspace_id for update;
        if exists(select 1 from workflow_schedules where workflow_id=NEW.workflow_id) then
          NEW.enabled := false;
          NEW.next_fire_at := null;
          NEW.record := jsonb_set(NEW.record,'{enabled}','false'::jsonb);
          NEW.last_error := 'SCHEDULE_REPLACED';
        end if;
      end if;
      return NEW;
    end;
    $$;


--
-- Name: guard_placement_admission(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_placement_admission() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare r runs%rowtype;
begin
 select * into r from runs where id=NEW.run_id;
 if r.id is null or r.execution_state<>'queued'
   or not exists(select 1 from runs where id=NEW.run_id and xmin=pg_current_xact_id()::text::xid)
   or NEW.record#>>'{payload,kind}' is distinct from 'agent'
   or NEW.record#>>'{payload,agentConfigurationVersionId}' is distinct from
     (r.record->'agentConfigurationVersionIds'->>(NEW.record#>>'{payload,agentId}')) then
   raise exception 'PLACEMENT_ADMISSION_CONFLICT' using errcode='P2843';
 end if;
 return NEW;
end $$;


--
-- Name: guard_placement_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_placement_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'PLACEMENT_EVIDENCE_IMMUTABLE' using errcode='P2843'; end $$;


--
-- Name: immutable_execution_native_closure(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.immutable_execution_native_closure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (to_jsonb(NEW)-array['closed_reference','closed_at','closed_without_session','detached_at','detached_reference'])
      is distinct from (to_jsonb(OLD)-array['closed_reference','closed_at','closed_without_session','detached_at','detached_reference'])
    or ((OLD.closed_at is not null or OLD.detached_at is not null) and to_jsonb(NEW) is distinct from to_jsonb(OLD)) then
    raise exception 'NATIVE_WORKFLOW_CLOSURE_IMMUTABLE' using errcode='P2644';
  end if;
  return NEW;
end $$;


--
-- Name: job_artifact_file_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.job_artifact_file_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if TG_OP='DELETE' then
        if old.scope_kind='job_execution' then raise exception 'Job artifact removal must retain its tombstone.'; end if;
        return old;
      end if;
      if new.scope_kind='job_execution' then
        perform 1 from job_executions where id=new.job_execution_id and workspace_id=new.workspace_id for share;
        if not found then raise exception 'Job artifact scope must match its actual workspace execution.'; end if;
      end if;
      if TG_OP='UPDATE' and (old.scope_kind='job_execution' or new.scope_kind='job_execution') then
        if row(old.file_id,old.owner_principal_id,old.current_revision_id,old.scope_kind,old.workspace_id,old.job_execution_id,old.created_at,old.retention_duration_seconds,old.expires_at)
          is distinct from row(new.file_id,new.owner_principal_id,new.current_revision_id,new.scope_kind,new.workspace_id,new.job_execution_id,new.created_at,new.retention_duration_seconds,new.expires_at) then
          raise exception 'Job artifact identity and accepted retention snapshot are immutable.';
        end if;
        if (old.state='removed' and new.state<>'removed') or (old.state='expired' and new.state not in ('expired','removed')) then
          raise exception 'Job artifact tombstones cannot be resurrected.';
        end if;
      end if;
      return new;
    end $$;


--
-- Name: job_artifact_revision_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.job_artifact_revision_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    declare scope text;
    begin
      select scope_kind into scope from files where file_id=new.file_id;
      if (scope='job_execution') is distinct from (new.origin='job_output') then
        raise exception 'CI output revisions require explicit job execution scope.';
      end if;
      return new;
    end $$;


--
-- Name: job_input_admission_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.job_input_admission_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 if old.operation='job.inputs.bind' then raise exception 'Original job input bindings are immutable.'; end if;
 if tg_op='UPDATE' and new.operation='job.inputs.bind' then raise exception 'Job input binding requires original admission.'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;


--
-- Name: job_output_admission_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.job_output_admission_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 if old.operation='job.output.admit' then raise exception 'Original job output admission receipts are immutable.'; end if;
 if tg_op='UPDATE' and new.operation='job.output.admit' then raise exception 'Job output admission requires its original command insertion.'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;


--
-- Name: native_activity_finished(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.native_activity_finished(event jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
    select coalesce((case when event->>'type'='native.unlinked_notification' then
        case when event#>>'{payload,method}'='turn/completed'
          then coalesce(event#>>'{payload,params,turn,status}','unknown')
          when event#>>'{payload,method}'='turn/started' then 'running' else 'unknown' end
      else coalesce(case when event->>'type' in ('claude.tool','claude.task') then event#>>'{payload,status}' end,
        event#>>'{payload,item,status}',event#>>'{payload,part,state,status}',
        case when event->>'type'='item.completed' then 'completed'
          when event->>'type'='item.started' then 'running' end) end)
      in ('completed','failed','declined','error','canceled','cancelled','interrupted'),false)
      or coalesce(event#>'{payload,item,error}' <> 'null'::jsonb,false)
      or coalesce(event#>>'{payload,item,type}'='dynamicToolCall'
        and event#>'{payload,item,success}'='false'::jsonb,false);
  $$;


--
-- Name: native_activity_identity(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.native_activity_identity(event jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
    with normalized as (
      select coalesce(case event->>'type'
          when 'claude.tool' then coalesce(event#>>'{payload,toolUseId}',event#>>'{payload,itemId}')
          when 'claude.task' then event#>>'{payload,taskId}'
          when 'native.unlinked_notification' then event#>>'{payload,turnId}' end,
        event#>>'{payload,item,id}',event#>>'{payload,part,id}',event#>>'{payload,itemId}',
        case when event#>>'{payload,method}' in ('turn/started','turn/completed')
          then event#>>'{payload,turnId}' end) as item_id,
        case when event->>'type'='native.unlinked_notification' then 'subagent'
          when event->>'type'='claude.tool' then 'tool'
          when event->>'type'='claude.task' then 'subagent'
          else coalesce(event#>>'{payload,item,type}',event#>>'{payload,part,type}') end as item_type
    )
    select case when item_id is not null and item_type in
      ('commandExecution','fileChange','webSearch','mcpToolCall','dynamicToolCall','collabAgentToolCall','tool','subagent')
      then jsonb_build_array(
        coalesce(case when event->>'type' in ('claude.tool','claude.task')
          then event#>>'{payload,nativeSessionId}' end,event#>>'{payload,threadId}',event#>>'{payload,part,sessionID}'),
        coalesce(case when event->>'type' in ('claude.tool','claude.task')
          then event#>>'{payload,owner,generation}' end,event#>>'{payload,runtimeGeneration}'),item_id) end
    from normalized;
  $$;


--
-- Name: notify_ci_ticket_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_ci_ticket_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    perform pg_notify('ci_ticket_changed', json_build_object(
      'workspaceId', new.workspace_id, 'ticketId', new.id, 'groupId', new.group_id)::text);
    return new;
  end;
  $$;


--
-- Name: order_run_activity_commit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.order_run_activity_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    perform pg_advisory_xact_lock(hashtextextended(
      current_schema() || ':run_activity:' || NEW.run_id, 0));
    -- The insert identity is private until commit. Allocate the published identity under the lock,
    -- after application work and finalizers, so cursors cannot skip a later-committing writer.
    update run_activity set sequence=default where run_id=NEW.run_id and sequence=NEW.sequence;
    return null;
  end $$;


--
-- Name: prepare_workflow_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_workflow_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  workspace_ids text[];
  workspace_id text;
begin
  if TG_OP = 'UPDATE' then
    if NEW.workspace_id = OLD.workspace_id
      and (NEW.archived_at is null) = (OLD.archived_at is null) then
      return NEW;
    end if;
    workspace_ids := array[OLD.workspace_id, NEW.workspace_id];
  elsif TG_OP = 'DELETE' then
    workspace_ids := array[OLD.workspace_id];
  else
    workspace_ids := array[NEW.workspace_id];
  end if;

  -- Fixture and restore inserts share the same workspace lock as product writes.
  for workspace_id in select distinct id from unnest(workspace_ids) as ids(id) order by id loop
    perform pg_advisory_xact_lock(hashtext('admission:workspace:' || workspace_id));
  end loop;
  perform 1 from workspaces where id = any(workspace_ids) order by id for update;
  if TG_OP = 'INSERT' or (TG_OP = 'UPDATE' and NEW.workspace_id <> OLD.workspace_id) then
    select coalesce(max(order_position), 0) + 1 into NEW.order_position
      from workflows where workflows.workspace_id = NEW.workspace_id;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end $$;


--
-- Name: preserve_job_acceptance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_job_acceptance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 if NEW.accepted_spec is distinct from OLD.accepted_spec or NEW.definition_version_id is distinct from OLD.definition_version_id
 or NEW.accepted_by is distinct from OLD.accepted_by or NEW.workspace_id is distinct from OLD.workspace_id
 or NEW.operation_id is distinct from OLD.operation_id or NEW.attempt_id is distinct from OLD.attempt_id
 or NEW.record->'acceptedSpec' is distinct from OLD.record->'acceptedSpec' then
 raise exception 'JOB_ACCEPTANCE_IMMUTABLE'; end if; return NEW;
end $$;


--
-- Name: preserve_job_accepted_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_job_accepted_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 if new.id is distinct from old.id
 or new.record->'id' is distinct from old.record->'id'
 or new.record->'workspaceId' is distinct from old.record->'workspaceId'
 or new.record->'operationId' is distinct from old.record->'operationId'
 or new.record->'attemptId' is distinct from old.record->'attemptId'
 or new.record->'owner' is distinct from old.record->'owner'
 or new.record->'workflow' is distinct from old.record->'workflow' then
  raise exception 'JOB_ACCEPTED_IDENTITY_IMMUTABLE';
 end if;return new;
end $$;


--
-- Name: preserve_job_admission_queue(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_job_admission_queue() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
 saved_definition jsonb;
 previous_state text;
 next_state text;
 mutable_fields text[] := array['revision','state','waitingReasons','compatibleTargetCount','queuePosition',
  'estimatedStartAt','sourceCapacityWait','reservationId','cancelRequestedAt','terminalReason','finishedAt'];
begin
 if TG_OP='DELETE' then raise exception 'JOB_QUEUE_HISTORY_IMMUTABLE'; end if;
 next_state := NEW.record->>'state';
 if TG_OP='INSERT' then
  if next_state is distinct from 'waiting' or NEW.record->>'revision' is distinct from '1'
   or NEW.record->'reservationId' is distinct from 'null'::jsonb
   or NEW.record->'cancelRequestedAt' is distinct from 'null'::jsonb
   or NEW.owner_id is not null or NEW.owner_fence is not null then
   raise exception 'JOB_QUEUE_INITIAL_STATE_INVALID';
  end if;
  select record into saved_definition from job_definition_versions
   where id=NEW.record #>> '{definition,versionId}' and workspace_id=NEW.workspace_id;
  if saved_definition is distinct from NEW.record->'definition' then
   raise exception 'JOB_QUEUE_DEFINITION_CONFLICT';
  end if;
  if exists(select 1 from job_preparations p where p.execution_id=NEW.execution_id
   or p.attempt_id=NEW.record->>'attemptId' or p.operation_id=NEW.record->>'operationId'
   or (p.principal_id=NEW.principal_id and p.command_id=NEW.command_id))
   or exists(select 1 from job_executions e where e.id=NEW.execution_id
   or e.attempt_id=NEW.record->>'attemptId' or e.operation_id=NEW.record->>'operationId') then
   raise exception 'JOB_QUEUE_IDENTITY_CONFLICT';
  end if;
 else
  -- Generated identities are computed after BEFORE triggers; the frozen record protects their inputs.
  if (to_jsonb(NEW)-array['record','backfill_claims','diagnostic_codes','owner_id','owner_fence',
    'definition_version_id','attempt_id','operation_id'])
   is distinct from (to_jsonb(OLD)-array['record','backfill_claims','diagnostic_codes','owner_id','owner_fence',
    'definition_version_id','attempt_id','operation_id'])
   or NEW.record-mutable_fields is distinct from OLD.record-mutable_fields then
   raise exception 'JOB_QUEUE_REQUEST_IMMUTABLE';
  end if;
  if NEW.record is distinct from OLD.record and (
   NEW.record-'revision'=OLD.record-'revision'
   or (NEW.record->>'revision')::bigint<>(OLD.record->>'revision')::bigint+1) then
   raise exception 'JOB_QUEUE_REVISION_CONFLICT';
  end if;
  if OLD.record->>'reservationId' is not null
   and NEW.record->'reservationId' is distinct from OLD.record->'reservationId' then
   raise exception 'JOB_QUEUE_RESERVATION_IMMUTABLE';
  end if;
  if OLD.record->>'cancelRequestedAt' is not null
   and NEW.record->'cancelRequestedAt' is distinct from OLD.record->'cancelRequestedAt' then
   raise exception 'JOB_QUEUE_CANCELLATION_IMMUTABLE';
  end if;
  previous_state := OLD.record->>'state';
  if (previous_state in ('waiting','blocked') and next_state not in ('waiting','blocked','claimed','terminal')
    and not (OLD.record ? 'sourceCapacityWait' and next_state='accepted'))
   or (previous_state='claimed' and next_state not in ('claimed','accepted','terminal')
    and not (next_state='waiting' and NEW.record ? 'sourceCapacityWait'))
   or (previous_state='accepted' and (next_state not in ('accepted','terminal')
    or (next_state='terminal' and NEW.record->>'terminalReason' is distinct from 'completed')))
   or (previous_state in ('waiting','blocked','claimed') and NEW.record->>'terminalReason'='completed')
   or (previous_state='terminal' and NEW.record is distinct from OLD.record) then
   raise exception 'JOB_QUEUE_STATE_CONFLICT';
  end if;
  if NEW.backfill_claims<OLD.backfill_claims then raise exception 'JOB_QUEUE_BACKFILL_CONFLICT'; end if;
 end if;
 if NEW.record->>'reservationId' is not null and not exists(
  select 1 from job_computer_selections s where s.execution_id=NEW.execution_id
   and s.workspace_id=NEW.workspace_id and s.definition_version_id=NEW.record #>> '{definition,versionId}'
   and s.attempt_id=NEW.record->>'attemptId' and s.operation_id=NEW.record->>'operationId'
   and s.limits=NEW.record #> '{resources,limits}') then
  raise exception 'JOB_QUEUE_SELECTION_CONFLICT';
 end if;
 if (next_state in ('claimed','accepted') or NEW.record ? 'sourceCapacityWait') and not exists(
  select 1 from job_preparations p where p.execution_id=NEW.execution_id
   and p.workspace_id=NEW.workspace_id and p.definition_version_id=NEW.record #>> '{definition,versionId}'
   and p.attempt_id=NEW.record->>'attemptId' and p.operation_id=NEW.record->>'operationId'
   and p.principal_id=NEW.principal_id and p.command_id=NEW.command_id and p.definition=NEW.record->'definition') then
  raise exception 'JOB_QUEUE_PREPARATION_CONFLICT';
 end if;
 if next_state='accepted' and not exists(
  select 1 from job_executions e where e.id=NEW.execution_id and e.workspace_id=NEW.workspace_id
   and e.definition_version_id=NEW.record #>> '{definition,versionId}'
   and e.attempt_id=NEW.record->>'attemptId' and e.operation_id=NEW.record->>'operationId'
   and e.accepted_by=NEW.principal_id) then
  raise exception 'JOB_QUEUE_ACCEPTANCE_CONFLICT';
 end if;
 if next_state='terminal' and NEW.record->>'terminalReason'='completed' and not exists(
  select 1 from job_executions e where e.id=NEW.execution_id and e.workspace_id=NEW.workspace_id
   and e.definition_version_id=NEW.record #>> '{definition,versionId}'
   and e.attempt_id=NEW.record->>'attemptId' and e.operation_id=NEW.record->>'operationId'
   and e.accepted_by=NEW.principal_id
   and e.record #>> '{process,phase}'='terminal' and e.record #> '{process,processStopped}'='true'::jsonb
   and e.record->>'publication' not in ('pending','collecting')
   and e.record->>'finishedAt'=NEW.record->>'finishedAt') then
  raise exception 'JOB_QUEUE_COMPLETION_UNCONFIRMED';
 end if;
 return NEW;
end $$;


--
-- Name: preserve_job_computer_selection(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_job_computer_selection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 if (to_jsonb(new)-'released_at') is distinct from (to_jsonb(old)-'released_at') then
  raise exception 'JOB_COMPUTER_SELECTION_IMMUTABLE';
 end if;
 return new;
end $$;


--
-- Name: preserve_job_definition_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_job_definition_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 raise exception 'JOB_DEFINITION_VERSION_IMMUTABLE'; end $$;


--
-- Name: preserve_job_dispatch_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_job_dispatch_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 if new.execution_id is distinct from old.execution_id or new.workspace_id is distinct from old.workspace_id or new.intent is distinct from old.intent then
  raise exception 'JOB_DISPATCH_IDENTITY_IMMUTABLE';
 end if;return new;
end $$;


--
-- Name: preserve_job_run_cleanup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_job_run_cleanup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 if old.cancel_cleanup is not null and new.cancel_cleanup is distinct from old.cancel_cleanup then
  raise exception 'JOB_CLEANUP_IMMUTABLE';
 end if;
 return new;
end $$;


--
-- Name: preserve_job_runtime_native_admission(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_job_runtime_native_admission() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 if old.native_admission is not null and new.native_admission is distinct from old.native_admission then
  raise exception 'JOB_RUNTIME_NATIVE_ADMISSION_IMMUTABLE';
 end if;
 return new;
end $$;


--
-- Name: preserve_job_runtime_profile_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preserve_job_runtime_profile_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 raise exception 'JOB_RUNTIME_PROFILE_VERSION_IMMUTABLE';end $$;


--
-- Name: protect_graph_edit_intent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_graph_edit_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if (new.record - array['state','stops','result','error','updatedAt','saveAttempted'])
           is distinct from (old.record - array['state','stops','result','error','updatedAt','saveAttempted'])
        or new.id<>old.id or new.principal_id<>old.principal_id or new.workspace_id<>old.workspace_id
        or new.workflow_id<>old.workflow_id or new.draft_id<>old.draft_id or new.created_at<>old.created_at then
        raise exception 'graph edit intent identities and payload are immutable';
      end if;
      if old.state in ('saved','discarded') and new.record is distinct from old.record then
        raise exception 'terminal graph edit intent is immutable';
      end if;
      if old.record->'saveAttempted'='true'::jsonb and new.record->'saveAttempted' is distinct from 'true'::jsonb then
        raise exception 'graph edit intent cannot forget a save attempt';
      end if;
      if exists (
        select 1 from jsonb_array_elements(old.record->'stops') with ordinality o(value,n)
        full join jsonb_array_elements(new.record->'stops') with ordinality n(value,n) using(n)
        where o.value is null or n.value is null
          or o.value-'receipt' is distinct from n.value-'receipt'
          or (o.value ? 'receipt' and o.value->'receipt' is distinct from n.value->'receipt')
      ) then raise exception 'exact Stop journal cannot be replaced'; end if;
      return new;
    end $$;


--
-- Name: protect_historical_workflow_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_historical_workflow_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'Historical workflow versions are immutable' using errcode='23514';
end $$;


--
-- Name: protect_repeat_native_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_repeat_native_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare is_repeat boolean;
begin
  if new.repeat_occurrence_id is distinct from old.repeat_occurrence_id then raise exception 'REPEAT_EXECUTION_IDENTITY_IMMUTABLE'; end if;
  select exists(select 1 from runs where id in (old.run_id,new.run_id)
    and record->>'executionSemanticsVersion'='3') into is_repeat;
  if is_repeat or old.repeat_occurrence_id is not null then
    if new.id is distinct from old.id or new.run_id is distinct from old.run_id
      or new.workflow_node_id is distinct from old.workflow_node_id or new.agent_id is distinct from old.agent_id
      or new.attempt is distinct from old.attempt
      or new.record->>'agentConfigurationVersionId' is distinct from old.record->>'agentConfigurationVersionId'
      or new.record->'input' is distinct from old.record->'input' then raise exception 'REPEAT_EXECUTION_IDENTITY_IMMUTABLE'; end if;
    if old.accepted and (not new.accepted or new.record->'result' is distinct from old.record->'result'
      or new.record->'state' is distinct from old.record->'state'
      or new.record->'finishedAt' is distinct from old.record->'finishedAt') then raise exception 'REPEAT_ACCEPTED_RESULT_IMMUTABLE'; end if;
  end if;
  return new;
end $$;


--
-- Name: protect_repeat_run_pin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_repeat_run_pin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.record->>'executionSemanticsVersion'='3' or new.record->>'executionSemanticsVersion'='3' then
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.workflow_id is distinct from old.workflow_id or new.workflow_version_id is distinct from old.workflow_version_id
      or new.record->'executionSemanticsVersion' is distinct from old.record->'executionSemanticsVersion'
      or new.record->'workflowVersionId' is distinct from old.record->'workflowVersionId'
      or new.record->'agentConfigurationVersionIds' is distinct from old.record->'agentConfigurationVersionIds'
      or new.record->'approval' is distinct from old.record->'approval'
      or new.record->'input' is distinct from old.record->'input' then raise exception 'REPEAT_RUN_PIN_IMMUTABLE'; end if;
    if new.record->>'executionState' is distinct from new.execution_state then raise exception 'REPEAT_RUN_STATE_CONFLICT'; end if;
    if old.execution_state='completed' and (new.execution_state is distinct from old.execution_state
      or new.record->'outcome' is distinct from old.record->'outcome' or new.record->'result' is distinct from old.record->'result'
      or new.record->'finishedAt' is distinct from old.record->'finishedAt') then raise exception 'REPEAT_RUN_TERMINAL_IMMUTABLE'; end if;
    if new.stop_requested_at is not null and new.execution_state is distinct from old.execution_state
      and new.execution_state not in ('completed','interrupted') then raise exception 'REPEAT_RUN_STOPPED'; end if;
    if new.stop_requested_at is not null and old.execution_state<>'completed'
      and new.execution_state='completed' and new.record->>'outcome'='succeeded' then raise exception 'REPEAT_RUN_STOPPED'; end if;
  end if;
  return new;
end $$;


--
-- Name: protect_repeat_version_pin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_repeat_version_pin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.execution_semantics_version=3 or new.execution_semantics_version=3 then
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.workflow_id is distinct from old.workflow_id or new.version is distinct from old.version
      or new.entry_node_id is distinct from old.entry_node_id or new.record is distinct from old.record
      or new.execution_semantics_version is distinct from old.execution_semantics_version
      or new.created_at is distinct from old.created_at then raise exception 'REPEAT_VERSION_IMMUTABLE'; end if;
  end if;
  return new;
end $$;


--
-- Name: protect_run_board_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_run_board_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    raise exception 'Run board snapshots are immutable' using errcode = '23514';
  end;
  $$;


--
-- Name: protect_run_dropdown_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_run_dropdown_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    if new.id is distinct from old.id or new.created_at is distinct from old.created_at
      or new.workspace_id is distinct from old.workspace_id
      or new.workflow_id is distinct from old.workflow_id then
      raise exception 'Run admission identity and ordering are immutable' using errcode = '23514';
    end if;
    return new;
  end;
  $$;


--
-- Name: protect_work_activation_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_work_activation_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.work_activation_id is distinct from old.work_activation_id then
    raise exception 'WORK_ACTIVATION_IDENTITY_IMMUTABLE';
  end if;
  return new;
end $$;


--
-- Name: protect_work_activation_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_work_activation_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.activation_id is distinct from old.activation_id or new.run_id is distinct from old.run_id
    or new.workflow_version_id is distinct from old.workflow_version_id
    or new.workflow_node_id is distinct from old.workflow_node_id
    or new.cause_kind is distinct from old.cause_kind or new.cause_id is distinct from old.cause_id
    or new.record is distinct from old.record or new.created_at is distinct from old.created_at
    or old.state='completed' and new.state<>'completed'
    or old.state<>'queued' and new.state='queued' and old.state<>'waiting' then
    raise exception 'WORK_ACTIVATION_IMMUTABLE'; end if;
  return new;
end $$;


--
-- Name: protect_work_join_dispatch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_work_join_dispatch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'WORK_JOIN_DISPATCH_IMMUTABLE'; end $$;


--
-- Name: protect_work_notice_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_work_notice_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.notice_id is distinct from old.notice_id or new.run_id is distinct from old.run_id
    or new.workflow_version_id is distinct from old.workflow_version_id
    or new.requester_activation_id is distinct from old.requester_activation_id
    or new.continuation_activation_id is distinct from old.continuation_activation_id
    or new.cause_kind is distinct from old.cause_kind or new.cause_id is distinct from old.cause_id
    or new.relationship_id is distinct from old.relationship_id
    or new.destination_node_id is distinct from old.destination_node_id
    or new.used is distinct from old.used or new.maximum is distinct from old.maximum
    or new.created_at is distinct from old.created_at or new.revision<>old.revision+1
    or (new.record - array['delivery','acknowledgementId','updatedAt'])
       is distinct from (old.record - array['delivery','acknowledgementId','updatedAt'])
    or (old.delivery_state='delivered' and new.delivery_state<>'delivered')
    or (old.delivery_state='queued' and new.delivery_state not in ('pending','unknown','failed'))
    or (old.delivery_state='pending' and new.delivery_state not in ('delivered','unknown','failed'))
    or (old.delivery_state='unknown' and new.delivery_state not in ('delivered','failed'))
    or (old.delivery_state='failed' and new.delivery_state<>'failed') then
    raise exception 'WORK_NOTICE_IDENTITY_IMMUTABLE'; end if;
  return new;
end $$;


--
-- Name: protect_work_unresolved(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_work_unresolved() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'WORK_UNRESOLVED_IMMUTABLE'; end $$;


--
-- Name: protect_work_usage_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_work_usage_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.run_id is distinct from old.run_id or new.workflow_version_id is distinct from old.workflow_version_id
    or new.relationship_id is distinct from old.relationship_id or new.maximum is distinct from old.maximum
    or new.used<old.used then raise exception 'WORK_COUNTER_IMMUTABLE'; end if;
  return new;
end $$;


--
-- Name: queue_run_subagent_projection(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.queue_run_subagent_projection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin
 insert into run_subagent_projection_queue(execution_id,latest_sequence) values(NEW.execution_id,NEW.sequence)
 on conflict(execution_id) do update set latest_sequence=greatest(run_subagent_projection_queue.latest_sequence,excluded.latest_sequence);
 if NEW.connection_id is null or NEW.connection_id not like 'child-history-%' then
   update run_subagent_backfill_state set complete=false,child_cursor=null where execution_id=NEW.execution_id and complete;
 end if;
 return NEW; end $$;


--
-- Name: record_host_ci_activity(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_host_ci_activity(ticket jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
  declare requester record;
  begin
    for requester in
      select e.id from harness_executions e join runs r on r.id=e.run_id
      where r.workspace_id=ticket->>'workspaceId' and (e.id=ticket#>>'{initiator,executionId}'
        or exists(select 1 from ci_group_requesters q where q.workspace_id=r.workspace_id
          and q.group_id::text=ticket->>'groupId' and q.execution_id=e.id))
      order by r.id,e.id
    loop
      perform record_requested_ci_activity(ticket,requester.id);
    end loop;
  end $$;


--
-- Name: record_host_ci_state_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_host_ci_state_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    if TG_OP='UPDATE' then
      if NEW.workspace_id is distinct from OLD.workspace_id or NEW.group_id is distinct from OLD.group_id
        or NEW.record->'initiator' is distinct from OLD.record->'initiator' then
        raise exception 'CI run ownership cannot change';
      end if;
      if OLD.state=NEW.state and OLD.record->'computer' is not distinct from NEW.record->'computer'
        and OLD.record->'step' is not distinct from NEW.record->'step' then return NEW; end if;
    end if;
    perform record_host_ci_activity(NEW.record);
    return NEW;
  end $$;


--
-- Name: record_joined_ci_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_joined_ci_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  declare ticket record;
  begin
    if NEW.initiator or NEW.execution_id is null then return NEW; end if;
    for ticket in select c.record from ci_runs c
      where c.workspace_id=NEW.workspace_id and c.group_id=NEW.group_id
        and c.record#>>'{initiator,executionId}' is distinct from NEW.execution_id
        and not exists(select 1 from ci_group_requesters q where q.workspace_id=NEW.workspace_id
          and q.group_id=NEW.group_id and q.execution_id=NEW.execution_id
          and q.principal_id<>NEW.principal_id)
      order by c.created_at,c.id
    loop
      perform record_requested_ci_activity(ticket.record,NEW.execution_id);
    end loop;
    return NEW;
  end $$;


--
-- Name: record_requested_ci_activity(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_requested_ci_activity(ticket jsonb, requester_execution_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
  declare
    parent_run_id text;
    execution_id text;
  begin
    -- The saved Run/configuration identity is immutable; the stream FK protects parent existence.
    select r.id,e.id into parent_run_id,execution_id
    from harness_executions e join runs r on r.id=e.run_id
    where e.id=requester_execution_id and r.workspace_id=ticket->>'workspaceId'
      and e.record->>'agentConfigurationVersionId'=r.record->'agentConfigurationVersionIds'->>e.agent_id;
    if parent_run_id is null then return; end if;

    insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
    values(parent_run_id,'backend','ci_state_changed',execution_id,clock_timestamp(),jsonb_build_object(
      'ticketId',ticket->>'id','ci',jsonb_build_object(
        'id',ticket->>'id','groupId',ticket->>'groupId','suite',ticket->>'suite',
        'part',ticket->'part','partition',ticket->'partition','state',ticket->>'state',
        'computer',case when ticket->'computer' <> 'null'::jsonb then jsonb_build_object(
          'hostRef',ticket#>'{computer,hostRef}','label',left(ticket#>>'{computer,label}',100)) else null end,
        'step',left(ticket->>'step',80),'exitCode',ticket->'exitCode',
        'queuedAt',ticket->>'queuedAt','startedAt',ticket->>'startedAt','finishedAt',ticket->>'finishedAt')));
  end $$;


--
-- Name: record_workflow_worker_ack_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_workflow_worker_ack_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.approval_native_ack_id is not null and old.approval_native_ack_id is null then
    insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      values(new.run_id,'backend','interaction_worker_ack',new.execution_id,clock_timestamp(),
        jsonb_build_object('interactionId',new.interaction_id,
          'acknowledgementId',new.approval_native_ack_id));
  end if;
  return new;
end $$;


--
-- Name: reject_repeat_evidence_truncate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_repeat_evidence_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'REPEAT_TRUNCATE_FORBIDDEN_USE_RUN_RETENTION'; end $$;


--
-- Name: reject_repeat_evidence_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_repeat_evidence_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'REPEAT_IMMUTABLE_EVIDENCE'; end $$;


--
-- Name: reject_work_evidence_truncate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_work_evidence_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'WORK_TRUNCATE_FORBIDDEN_USE_RUN_RETENTION'; end $$;


--
-- Name: reject_work_evidence_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_work_evidence_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'WORK_EVIDENCE_IMMUTABLE'; end $$;


--
-- Name: remote_dispatch_origin_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remote_dispatch_origin_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'Original remote dispatch connection is immutable.' using errcode='P2845'; end $$;


--
-- Name: remote_native_artifact_output_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remote_native_artifact_output_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.operation in ('remote.native-artifact.output','remote.native-artifact.context') then
    raise exception 'Original native artifact receipts are immutable.';
  end if;
  if tg_op='UPDATE' and new.operation in ('remote.native-artifact.output','remote.native-artifact.context') then
    raise exception 'Native artifact receipts require their original command insertion.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;


--
-- Name: remote_owner_control_snapshot_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remote_owner_control_snapshot_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.remote_owner_control is not null then
    if tg_op='DELETE' then raise exception 'Original remote response admission must be retained.'; end if;
    if row(old.remote_owner_control,old.remote_owner_control_token,old.remote_owner_control_fence,old.remote_owner_control_generation,
           old.interaction_id,old.attempt,old.native_session_id,old.native_request_id,old.correlation_id)
      is distinct from row(new.remote_owner_control,new.remote_owner_control_token,new.remote_owner_control_fence,new.remote_owner_control_generation,
           new.interaction_id,new.attempt,new.native_session_id,new.native_request_id,new.correlation_id) then
      raise exception 'Original remote response admission is immutable.';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;


--
-- Name: repeat_assert_selected_source(text, text, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.repeat_assert_selected_source(target_run_id text, target_node_id text, target_occurrence_id text, source_json jsonb, source_kind text) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare source run_repeat_executions%rowtype; result run_repeat_results%rowtype;
  pinned jsonb; edge jsonb; source_key text;
begin
  pinned := repeat_pinned_version(target_run_id);
  select * into strict source from run_repeat_executions where execution_id=source_json #>> '{execution,executionId}';
  select * into strict result from run_repeat_results where execution_id=source.execution_id;
  if source.run_id<>target_run_id or result.run_id<>target_run_id
    or source_json->'execution' is distinct from source.identity-'occurrence'
    or source_json->'occurrence' is distinct from coalesce(source.identity->'occurrence','null'::jsonb)
    or source_json->>'acceptedResultDigest' is distinct from result.result_digest
    or source_json->'acceptedResult' is distinct from result.result_json::jsonb then raise exception 'REPEAT_SOURCE_CONFLICT'; end if;
  select value into strict edge from jsonb_array_elements(pinned #> '{definition,edges}')
    where value->>'id'=source_json->>'relationshipId';
  if edge->>'kind' is distinct from 'execution' or edge->>'source' is distinct from source.workflow_node_id
    or edge->>'target' is distinct from target_node_id then raise exception 'REPEAT_BINDING_EDGE_CONFLICT'; end if;
  if source_kind='predecessor' and target_occurrence_id is not null
    and source.occurrence_id is distinct from target_occurrence_id then raise exception 'REPEAT_CROSS_OCCURRENCE_JOIN'; end if;
  if source_kind='external' and source.occurrence_id is not null and exists(
    select 1 from run_repeat_occurrences a join run_repeat_occurrences b on a.run_id=b.run_id and a.block_id=b.block_id
      where a.occurrence_id=source.occurrence_id and b.occurrence_id=target_occurrence_id) then
    raise exception 'REPEAT_EXTERNAL_SOURCE_CONFLICT';
  end if;
  source_key := case when source.occurrence_id is not null and source.occurrence_id=target_occurrence_id
    then source.occurrence_id else '' end;
  if not exists(select 1 from run_repeat_resolutions r where r.run_id=target_run_id and r.occurrence_key=source_key
    and r.workflow_node_id=source.workflow_node_id and r.execution_id=source.execution_id
    and r.record #>> '{value,resolution}'='succeeded'
    and r.record #>> '{value,acceptedResultDigest}'=result.result_digest
    and (r.record #> '{value,selectedRelationshipIds}') ? (edge->>'id')) then
    raise exception 'REPEAT_SOURCE_NOT_SELECTED';
  end if;
end $$;


--
-- Name: repeat_node_scope(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.repeat_node_scope(target_run_id text, node_id text, target_occurrence_id text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare pinned jsonb; block jsonb; occ run_repeat_occurrences%rowtype; member_count integer;
begin
  pinned := repeat_pinned_version(target_run_id);
  if (select count(*) from jsonb_array_elements(pinned #> '{definition,nodes}') n where n->>'id'=node_id)<>1 then
    raise exception 'REPEAT_NODE_SCOPE_CONFLICT';
  end if;
  select count(*) into member_count from jsonb_array_elements(pinned #> '{definition,repeat,blocks}') b
    where b->'nodeIds' ? node_id;
  if member_count>1 or (member_count=0)<>(target_occurrence_id is null) then
    raise exception 'REPEAT_EXECUTION_SCOPE_CONFLICT';
  end if;
  if target_occurrence_id is not null then
    select * into strict occ from run_repeat_occurrences where occurrence_id=target_occurrence_id;
    block := repeat_saved_block(pinned,occ.block_id);
    if occ.run_id<>target_run_id or not coalesce(block->'nodeIds' ? node_id,false) then
      raise exception 'REPEAT_EXECUTION_SCOPE_CONFLICT';
    end if;
    return block;
  end if;
  return null;
end $$;


--
-- Name: repeat_pinned_version(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.repeat_pinned_version(target_run_id text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare parent_run runs%rowtype; version workflow_versions%rowtype;
begin
  select * into strict parent_run from runs where id=target_run_id;
  select * into strict version from workflow_versions where id=parent_run.workflow_version_id;
  if version.execution_semantics_version<>3
    or version.workspace_id<>parent_run.workspace_id or version.workflow_id<>parent_run.workflow_id
    or (parent_run.record->'executionSemanticsVersion') is distinct from '3'::jsonb
    or (parent_run.record->>'id') is distinct from parent_run.id
    or (parent_run.record->>'workspaceId') is distinct from parent_run.workspace_id
    or (parent_run.record->>'workflowId') is distinct from parent_run.workflow_id
    or (parent_run.record->>'workflowVersionId') is distinct from version.id
    or (parent_run.record->>'executionState') is distinct from parent_run.execution_state
    or parent_run.record->'agentConfigurationVersionIds' is distinct from version.record->'agentConfigurationVersionIds'
    or not exists(select 1 from workflows where id=version.workflow_id and workspace_id=version.workspace_id) then
    raise exception 'REPEAT_SCOPE_CONFLICT';
  end if;
  return version.record;
end $$;


--
-- Name: repeat_saved_block(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.repeat_saved_block(pinned jsonb, target_block_id text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare block jsonb; cap numeric;
begin
  select value into strict block from jsonb_array_elements(pinned #> '{definition,repeat,blocks}')
    where value->>'id'=target_block_id;
  -- JSON null, strings, fractional numbers and absent caps must not make an IF
  -- condition UNKNOWN and accidentally authorize an unbounded occurrence.
  if jsonb_typeof(block->'maxOccurrences') is distinct from 'number' then
    raise exception 'REPEAT_LIMIT_INVALID';
  end if;
  cap := (block->>'maxOccurrences')::numeric;
  if cap<1 or cap>2147483647 or cap<>trunc(cap)
    or jsonb_typeof(block->'nodeIds') is distinct from 'array'
    or not coalesce(block->'nodeIds' ? (block->>'entryNodeId'),false)
    or not coalesce(block->'nodeIds' ? (block->>'exitNodeId'),false)
    or block->>'repeatOutcome' is null or block->>'earlyExitOutcome' is null
    or block->>'repeatOutcome'=block->>'earlyExitOutcome' then
    raise exception 'REPEAT_BLOCK_INVALID';
  end if;
  return block;
end $$;


--
-- Name: require_work_notice(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.require_work_notice() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare request run_work_requests%rowtype; usage run_work_connection_usage%rowtype;
begin
  if tg_table_name='run_work_denials' then
    if exists(select 1 from run_work_denials where denial_id=new.denial_id)
      and not exists(select 1 from run_work_notices where run_id=new.run_id
        and cause_kind='limit_denial' and cause_id=new.denial_id) then
      raise exception 'WORK_DENIAL_NOTICE_MISSING'; end if;
  elsif tg_table_name='run_work_returns' and new.outcome='needs_changes' then
    select * into strict request from run_work_requests where request_id=new.request_id;
    select * into strict usage from run_work_connection_usage
      where run_id=new.run_id and relationship_id=request.relationship_id;
    if usage.maximum is not null and usage.used=usage.maximum
      and not exists(select 1 from run_work_notices where run_id=new.run_id
        and cause_kind='last_return' and cause_id=new.return_id) then
      raise exception 'WORK_LAST_RETURN_NOTICE_MISSING'; end if;
  end if;
  return null;
end $$;


--
-- Name: retain_work_notice(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.retain_work_notice() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if exists(select 1 from runs where id=old.run_id) then raise exception 'WORK_NOTICE_RETAIN_WITH_RUN'; end if;
  return null;
end $$;


--
-- Name: revise_workflow_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revise_workflow_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if TG_OP = 'INSERT' then
    update workspaces set workflow_order_revision = workflow_order_revision + 1 where id = NEW.workspace_id;
  elsif TG_OP = 'DELETE' then
    update workspaces set workflow_order_revision = workflow_order_revision + 1 where id = OLD.workspace_id;
  elsif NEW.workspace_id <> OLD.workspace_id
    or (NEW.archived_at is null) <> (OLD.archived_at is null) then
    update workspaces set workflow_order_revision = workflow_order_revision + 1
      where id in (OLD.workspace_id, NEW.workspace_id);
  end if;
  return null;
end $$;


--
-- Name: run_reference_pin_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.run_reference_pin_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      perform 1 from runs r join files f on f.file_id=new.file_id
        join file_revisions v on v.file_id=f.file_id and v.revision_id=new.revision_id
        where r.id=new.run_id and f.state='ready' and f.workspace_id=r.workspace_id and
          ((f.scope_kind='workspace_reference' and f.workflow_id is null)
            or (f.scope_kind='workflow_reference' and f.workflow_id=r.workflow_id))
        for share of r,f;
      if not found then
        raise exception using errcode='23514', message='A Run may pin only a ready reference in its exact inherited scope.';
      end if;
      return new;
    end $$;


--
-- Name: run_reference_provenance_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.run_reference_provenance_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      raise exception 'Run reference pins and read provenance are immutable and must be retained.';
    end $$;


--
-- Name: run_reference_read_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.run_reference_read_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      perform 1 from harness_executions e
        join file_revisions v on v.file_id=new.file_id and v.revision_id=new.revision_id
        where e.id=new.execution_id and e.run_id=new.run_id and new.read_at>=v.created_at
        for share of e;
      if not found then
        raise exception using errcode='23514', message='Reference provenance must name the exact Run execution and a valid read time.';
      end if;
      return new;
    end $$;


--
-- Name: set_native_event_occurred_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_native_event_occurred_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    NEW.occurred_at := (NEW.record->>'occurredAt')::timestamptz;
    return NEW;
  end $$;


--
-- Name: source_fact_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.source_fact_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'Accepted source snapshots and root binding facts are immutable.'; end $$;


--
-- Name: source_snapshot_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.source_snapshot_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
 if tg_op='DELETE' or new.snapshot_id<>old.snapshot_id or new.approved_source_id<>old.approved_source_id
 or new.workspace_id<>old.workspace_id or new.manifest_digest<>old.manifest_digest or new.record<>old.record
 or (old.availability='unavailable' and new.availability<>'unavailable') then
 raise exception 'Source facts cannot be changed or resurrected.'; end if; return new;
end $$;


--
-- Name: start_run_cleanup_episode(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.start_run_cleanup_episode() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    if NEW.pending and not OLD.pending then
      NEW.requested_at := clock_timestamp();
      NEW.deadline_exceeded_at := null;
    end if;
    return NEW;
  end $$;


--
-- Name: suppress_legacy_workflow_schedule(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.suppress_legacy_workflow_schedule() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      update workflow_triggers set enabled=false,next_fire_at=null,
        record=jsonb_set(record,'{enabled}','false'::jsonb),last_error='SCHEDULE_REPLACED'
        where workflow_id=NEW.workflow_id and workspace_id=NEW.workspace_id and record->>'kind'='schedule'
          and (enabled or next_fire_at is not null or last_error is distinct from 'SCHEDULE_REPLACED');
      return NEW;
    end;
    $$;


--
-- Name: sync_review_job_lease(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_review_job_lease() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      NEW.lease_owner := NEW.record->>'leaseOwner';
      NEW.lease_token := NEW.record->>'leaseToken';
      NEW.lease_expires_at := (NEW.record->>'leaseExpiresAt')::timestamptz;
      if TG_OP='INSERT' then
        NEW.lease_fence := case when NEW.lease_token is null then 0 else 1 end;
      else
        NEW.lease_fence := OLD.lease_fence + case
          when NEW.lease_token is not null and NEW.lease_token is distinct from OLD.lease_token then 1 else 0 end;
      end if;
      return NEW;
    end $$;


--
-- Name: wave25_approval_generation_monotonic(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wave25_approval_generation_monotonic() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    if (NEW.record->>'connectionGeneration')::bigint < (OLD.record->>'connectionGeneration')::bigint
      and exists(select 1 from execution_native_sessions s join harness_executions e on e.id=s.execution_id
        join runs r on r.id=e.run_id join workflow_versions v on v.id=r.workflow_version_id
        where v.execution_semantics_version=2 and s.reference->>'nativeSessionId'=OLD.native_session_id
          and s.reference->>'harness'=OLD.harness) then
      raise exception 'GRAPH_STALE_GENERATION' using errcode='PGA05';
    end if;
    return NEW;
  end $$;


--
-- Name: wave25_approval_immutable_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wave25_approval_immutable_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    if OLD.execution_semantics_version=2 and NEW.record is distinct from OLD.record then
      raise exception 'APPROVAL_ACCEPTED_VERSION_IMMUTABLE' using errcode='PGA02';
    end if;
    return NEW;
  end $$;


--
-- Name: wave25_approval_no_downgrade(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wave25_approval_no_downgrade() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
declare old_graph jsonb := OLD.record; new_graph jsonb := NEW.record; pinned workflow_versions%rowtype;
begin
  if TG_TABLE_NAME<>'workflows' then
    raise exception 'CURRENT_DEFINITION_SERVICE_REQUIRED' using errcode='PGC01';
  end if;
  if (old_graph->'executionSemanticsVersion'='3'::jsonb and new_graph->'executionSemanticsVersion'='3'::jsonb
    and NEW.id=OLD.id and NEW.workspace_id=OLD.workspace_id) is not true then
    raise exception 'EXECUTION_SEMANTICS_UNSUPPORTED' using errcode='PGC01';
  end if;
  select * into pinned from workflow_versions where id=NEW.current_version_id;
  if NEW.current_version_id is distinct from OLD.current_version_id then
    if (pinned.execution_semantics_version=3 and pinned.workflow_id=NEW.id and pinned.workspace_id=NEW.workspace_id
      and NEW.revision=OLD.revision+1 and new_graph=pinned.record->'definition'
      and (to_jsonb(NEW)-array['record','revision','current_version_id'])=(to_jsonb(OLD)-array['record','revision','current_version_id'])
      and exists(select 1 from current_workflow_publications p where p.workflow_version_id=NEW.current_version_id
        and p.workspace_id=NEW.workspace_id and p.workflow_id=NEW.id and p.base_version_id is not distinct from OLD.current_version_id
        and p.expected_revision=OLD.revision and p.publication_xid=pg_current_xact_id())) is not true then
      raise exception 'CURRENT_TYPED_WRITER_REQUIRED' using errcode='PGC01';
    end if;
  elsif NEW.current_version_id is null then
    if (NEW.revision>=OLD.revision and old_graph->'nodes'='[]'::jsonb and old_graph->'edges'='[]'::jsonb
      and not (new_graph ? 'repeat')
      and eng04_repeat_executable_graph(new_graph)=eng04_repeat_executable_graph(old_graph)
      and new_graph->'createdAt' is not distinct from old_graph->'createdAt') is not true then
      raise exception 'CURRENT_TYPED_WRITER_REQUIRED' using errcode='PGC01';
    end if;
  elsif (pinned.execution_semantics_version=3 and pinned.workflow_id=NEW.id and pinned.workspace_id=NEW.workspace_id
    and NEW.revision>=OLD.revision and new_graph->'version'=to_jsonb(pinned.version)
    and new_graph->'createdAt' is not distinct from old_graph->'createdAt'
    and eng04_repeat_executable_graph(new_graph)=eng04_repeat_executable_graph(old_graph)
    and eng04_repeat_executable_graph(new_graph)=eng04_repeat_executable_graph(pinned.record->'definition')) is not true then
    raise exception 'CURRENT_TYPED_WRITER_REQUIRED' using errcode='PGC01';
  end if;
  return NEW;
end $$;


--
-- Name: wave25_approval_requires_publication(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wave25_approval_requires_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  declare target_run text; target_id text; target_revision bigint; kinds text[];
  begin
    if TG_TABLE_NAME='durable_interactions' then
      target_run=NEW.run_id; target_id=NEW.id; target_revision=NEW.revision;
      kinds=array['interaction','delivery','native_event'];
      if TG_OP='UPDATE' and NEW.record is not distinct from OLD.record and NEW.status=OLD.status then return NEW; end if;
    else
      select run_id into target_run from durable_interactions where id=NEW.interaction_id;
      target_id=NEW.id; target_revision=NEW.revision; kinds=array['review','cleanup','native_event'];
      if TG_OP='UPDATE' and NEW.state=OLD.state and
        (NEW.record - array['leaseOwner','leaseToken','leaseExpiresAt','updatedAt','retryAfter']) is not distinct from
        (OLD.record - array['leaseOwner','leaseToken','leaseExpiresAt','updatedAt','retryAfter']) then return NEW; end if;
    end if;
    if not exists(select 1 from runs r join workflow_versions v on v.id=r.workflow_version_id
      where r.id=target_run and v.execution_semantics_version=2) then return NEW; end if;
    if not exists(select 1 from run_graph_sources s join run_graph_batches b
        on b.run_id=s.run_id and b.sequence=s.first_sequence
      where s.run_id=target_run and s.source_id=target_id and s.source_revision=target_revision
        and s.source_kind=any(kinds) and b.publication_xid=pg_current_xact_id()) then
      raise exception 'APPROVAL_ATOMIC_PUBLICATION_REQUIRED' using errcode='PGA03';
    end if;
    return NEW;
  end $$;


--
-- Name: work_join_required_edges(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_join_required_edges(work_run_id text, round_id text, join_node_id text) RETURNS text[]
    LANGUAGE sql STABLE
    AS $$
  with recursive
  pinned as (select repeat_pinned_version(work_run_id) as value),
  nodes as (select n.value from pinned p
    cross join lateral jsonb_array_elements(p.value #> '{definition,nodes}') n(value)),
  edges as (select e.value from pinned p
    cross join lateral jsonb_array_elements(p.value #> '{definition,edges}') e(value)
    where e.value->>'kind'='execution'),
  decisions as (
    select a.activation_id,x.execution_id,a.workflow_node_id, x.result_json::jsonb->'output' as payload
    from run_work_results x join run_work_activations a on a.run_id=x.run_id and a.activation_id=x.activation_id
    where x.run_id=work_run_id and work_round_id(x.run_id,a.activation_id)=round_id
  ),
  routes as (
    select e.value->>'id' as relationship_id,n.value->>'id' as source,
      case when e.value->>'source'=n.value->>'id' then e.value->>'target' else e.value->>'source' end as target
    from pinned cross join nodes n left join decisions d on d.workflow_node_id=n.value->>'id'
    join edges e on (e.value->>'source'=n.value->>'id'
      or e.value->>'workRequestDirection'='both' and e.value->>'target'=n.value->>'id')
      and e.value->>'id'=any(work_saved_routes(pinned.value,n.value,d.payload))
      and not exists(select 1 from run_work_denials denied
        where denied.run_id=work_run_id and denied.requester_activation_id=d.activation_id
          and denied.relationship_id=e.value->>'id')
      and not exists(select 1 from run_work_unresolved unresolved
        where unresolved.run_id=work_run_id and unresolved.execution_id=d.execution_id
          and unresolved.reason='repeated_exhausted_route' and unresolved.relationship_id=e.value->>'id')
  ),
  reachable(node_id) as (
    select coalesce((select workflow_node_id from run_work_activations
      where run_id=work_run_id and activation_id=round_id),(select value->>'entryNodeId' from pinned))
    union
    select routes.target from reachable join routes on routes.source=reachable.node_id
      where reachable.node_id<>join_node_id
  )
  select coalesce(array_agg(distinct r.relationship_id order by r.relationship_id),'{}')
    from routes r join reachable on reachable.node_id=r.source join edges e on e.value->>'id'=r.relationship_id
    where r.target=join_node_id and e.value->>'target'=join_node_id;
$$;


--
-- Name: work_json_bytes(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_json_bytes(value jsonb) RETURNS integer
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  select octet_length(regexp_replace(value::text, '("(?:[^"\\]|\\.)*")|[[:space:]]+', '\1', 'g'));
$$;


--
-- Name: work_parent_request(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_parent_request(work_run_id text, work_activation_id text) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
declare activation run_work_activations%rowtype; original_node text; next_id text;
  visited text[] := '{}';
begin
  loop
    if work_activation_id=any(visited) then raise exception 'WORK_PARENT_REQUEST_CYCLE'; end if;
    visited := array_append(visited,work_activation_id);
    select * into strict activation from run_work_activations
      where run_id=work_run_id and activation_id=work_activation_id;
    if original_node is null then original_node := activation.workflow_node_id;
    elsif activation.workflow_node_id<>original_node then raise exception 'WORK_PARENT_REQUEST_NODE_CONFLICT'; end if;
    if activation.cause_kind='work_request' then
      if not exists(select 1 from run_work_requests where run_id=work_run_id
        and request_id=activation.cause_id and destination_activation_id=activation.activation_id
        and destination_node_id=original_node) then raise exception 'WORK_PARENT_REQUEST_CONFLICT'; end if;
      return activation.cause_id;
    elsif activation.cause_kind='work_return' then
      select record->>'requesterActivationId' into strict next_id from run_work_returns
        where run_id=work_run_id and return_id=activation.cause_id
          and requester_continuation_activation_id=activation.activation_id;
    elsif activation.cause_kind='limit_denial' then
      select d.requester_activation_id into strict next_id from run_work_denials d
        join run_work_notices n on n.run_id=d.run_id and n.cause_kind='limit_denial' and n.cause_id=d.denial_id
        where d.run_id=work_run_id and d.denial_id=activation.cause_id
          and n.continuation_activation_id=activation.activation_id;
    else
      return null;
    end if;
    work_activation_id := next_id;
  end loop;
end $$;


--
-- Name: work_return_request(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_return_request(work_run_id text, work_activation_id text, supplied_id text) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
declare request_ids text[];
begin
  select array_agg(request_id order by request_id) into request_ids from run_work_requests
    where run_id=work_run_id and (destination_activation_id=work_activation_id
      or request_id=work_parent_request(work_run_id,work_activation_id));
  if supplied_id is not null and supplied_id=any(request_ids) then return supplied_id; end if;
  if supplied_id is null and cardinality(request_ids)=1 then return request_ids[1]; end if;
  raise exception 'WORK_RETURN_RESULT_CONFLICT';
end $$;


--
-- Name: work_round_id(text, text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_round_id(work_run_id text, work_activation_id text, visited text[] DEFAULT '{}'::text[]) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
declare activation run_work_activations%rowtype; requester_id text; relationship_id text; round_ids text[];
begin
  if work_activation_id=any(visited) then raise exception 'WORK_ROUND_CYCLE'; end if;
  visited := array_append(visited,work_activation_id);
  select * into strict activation from run_work_activations
    where run_id=work_run_id and activation_id=work_activation_id;
  if activation.cause_kind in ('entry','dependency') then return activation.lineage_id;
  elsif activation.cause_kind in ('work_return','limit_denial') then return activation.activation_id;
  elsif activation.cause_kind='work_request' then
    select r.requester_activation_id,r.relationship_id into strict requester_id,relationship_id from run_work_requests r
      where run_id=work_run_id and request_id=activation.cause_id
        and destination_activation_id=activation.activation_id;
    if exists(select 1 from jsonb_array_elements(repeat_pinned_version(work_run_id) #> '{definition,edges}') e
      where e->>'id'=relationship_id and e->>'source'=activation.workflow_node_id) then
      return activation.activation_id;
    end if;
    return work_round_id(work_run_id,requester_id,visited);
  elsif activation.cause_kind='join' then
    select array_agg(distinct work_round_id(work_run_id,requester_activation_id,visited)) into round_ids
      from run_work_requests where run_id=work_run_id and destination_activation_id=activation.activation_id;
    if cardinality(round_ids) is distinct from 1 then raise exception 'WORK_JOIN_ROUND_CONFLICT'; end if;
    return round_ids[1];
  end if;
  raise exception 'WORK_ROUND_CAUSE_UNSUPPORTED';
end $$;


--
-- Name: work_saved_routes(jsonb, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_saved_routes(pinned jsonb, node jsonb, payload jsonb) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare selected text[]; route_kind text;
begin
  if payload is not null then
    if jsonb_typeof(payload)='string' then payload := (payload #>> '{}')::jsonb;
    elsif payload->>'text' is not null and payload->'routing' is null then payload := (payload->>'text')::jsonb;
    end if;
    route_kind := payload #>> '{routing,kind}';
    if route_kind='return' then return '{}'; end if;
    if route_kind='finish' and payload #>> '{routing,outcome}' is null
      and jsonb_array_length(payload #> '{data,remainingFindings}')>0 then return '{}'; end if;
  end if;
  if node->'choice' is not null then
    select coalesce(array_agg(c #>> '{target,relationshipId}' order by c #>> '{target,relationshipId}'),'{}')
      into selected from jsonb_array_elements(node #> '{choice,outcomes}') c
      where c #>> '{target,kind}'='edge'
        and (payload is null or c->>'outcome'=payload #>> '{routing,outcome}');
    return selected;
  end if;
  if payload is not null and route_kind is distinct from 'finish' then return '{}'; end if;
  select coalesce(array_agg(e->>'id' order by e->>'id'),'{}') into selected
    from jsonb_array_elements(pinned #> '{definition,edges}') e
    where e->>'kind'='execution' and e->>'source'=node->>'id';
  return selected;
end $$;


--
-- Name: workflow_native_file_context_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workflow_native_file_context_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.agent_key like 'workflow-native-files:v1:%' then
    if tg_op='DELETE' then raise exception 'Original workflow file contexts must be retained.'; end if;
    if row(old.id,old.kind,old.agent_key,old.operator_id,old.operator_configuration_version_id,old.owner_principal_id,
           old.workspace_id,old.workflow_id,old.workflow_node_id,old.agent_id,old.agent_configuration_version_id,
           old.origin_run_id,old.origin_execution_id,old.harness,old.provider_version,old.native_session_id,
           old.record)
      is distinct from row(new.id,new.kind,new.agent_key,new.operator_id,new.operator_configuration_version_id,new.owner_principal_id,
           new.workspace_id,new.workflow_id,new.workflow_node_id,new.agent_id,new.agent_configuration_version_id,
           new.origin_run_id,new.origin_execution_id,new.harness,new.provider_version,new.native_session_id,
           new.record) then
      raise exception 'Original workflow file context identity is immutable.';
    end if;
  elsif tg_op='UPDATE' and new.agent_key like 'workflow-native-files:v1:%' then
    raise exception 'Workflow file contexts require their original Main admission insertion.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;


--
-- Name: workflow_node_presentation(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workflow_node_presentation(graph jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id',node->'id','name',node->'name','label',node->'label')) order by ordinal),'[]'::jsonb)
  from jsonb_array_elements(graph->'nodes') with ordinality as n(node,ordinal)
$$;


--
-- Name: workflow_schedule_occurrence_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workflow_schedule_occurrence_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      raise exception 'Schedule occurrences are immutable' using errcode = '23514';
    end;
    $$;


--
-- Name: workspace_root_fact_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workspace_root_fact_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin raise exception 'Approved root configuration facts are immutable.'; end $$;


--
-- Name: workspace_root_policy_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workspace_root_policy_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
 if tg_op='DELETE' or new.record<>old.record or new.root_policy_id<>old.root_policy_id or new.root_policy_revision<>old.root_policy_revision
 or new.workspace_id<>old.workspace_id or new.host_scope<>old.host_scope or new.location_revision<>old.location_revision
 or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then raise exception 'Approved root facts cannot change or resurrect.'; end if; return new;
end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: checkpoint_blobs; Type: TABLE; Schema: langgraph; Owner: -
--

CREATE TABLE langgraph.checkpoint_blobs (
    thread_id text NOT NULL,
    checkpoint_ns text DEFAULT ''::text NOT NULL,
    channel text NOT NULL,
    version text NOT NULL,
    type text NOT NULL,
    blob bytea
);


--
-- Name: checkpoint_migrations; Type: TABLE; Schema: langgraph; Owner: -
--

CREATE TABLE langgraph.checkpoint_migrations (
    v integer NOT NULL
);


--
-- Name: checkpoint_writes; Type: TABLE; Schema: langgraph; Owner: -
--

CREATE TABLE langgraph.checkpoint_writes (
    thread_id text NOT NULL,
    checkpoint_ns text DEFAULT ''::text NOT NULL,
    checkpoint_id text NOT NULL,
    task_id text NOT NULL,
    idx integer NOT NULL,
    channel text NOT NULL,
    type text,
    blob bytea NOT NULL
);


--
-- Name: checkpoints; Type: TABLE; Schema: langgraph; Owner: -
--

CREATE TABLE langgraph.checkpoints (
    thread_id text NOT NULL,
    checkpoint_ns text DEFAULT ''::text NOT NULL,
    checkpoint_id text NOT NULL,
    parent_checkpoint_id text,
    type text,
    checkpoint jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: agent_configuration_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_configuration_versions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    agent_id text NOT NULL,
    version integer NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id text NOT NULL,
    workspace_id text NOT NULL,
    current_configuration_version_id text,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata_revision bigint DEFAULT 1 NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: application_installation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_installation (
    singleton boolean DEFAULT true NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT application_installation_singleton_check CHECK (singleton)
);


--
-- Name: application_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_migrations (
    version integer NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_operators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_operators (
    id text NOT NULL,
    current_configuration_version_id text NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_setting_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_setting_versions (
    id text NOT NULL,
    setting_key text NOT NULL,
    version integer NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_settings (
    key text NOT NULL,
    record jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    current_version_id text
);


--
-- Name: approval_execution_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_execution_state (
    execution_id text NOT NULL,
    graph_thread_id text NOT NULL,
    active_timeout_ms bigint NOT NULL,
    active_elapsed_ms bigint DEFAULT 0 NOT NULL,
    active_started_at timestamp with time zone,
    approval_wait_started_at timestamp with time zone,
    stopped_at timestamp with time zone,
    revision bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    failure_result jsonb,
    CONSTRAINT approval_execution_state_active_elapsed_ms_check CHECK ((active_elapsed_ms >= 0)),
    CONSTRAINT approval_execution_state_active_timeout_ms_check CHECK ((active_timeout_ms > 0)),
    CONSTRAINT approval_execution_state_failure_result_check CHECK (((failure_result IS NULL) OR ((jsonb_typeof(failure_result) = 'object'::text) AND ((failure_result ->> 'outcome'::text) = 'failed'::text) AND (jsonb_typeof((failure_result -> 'error'::text)) = 'object'::text))))
);


--
-- Name: bug_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bug_reports (
    id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text,
    run_id text,
    status text NOT NULL,
    severity text NOT NULL,
    revision bigint NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    title_key text NOT NULL,
    CONSTRAINT bug_reports_revision_check CHECK ((revision > 0)),
    CONSTRAINT bug_reports_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
    CONSTRAINT bug_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'triaged'::text, 'fixed'::text, 'wont-fix'::text, 'duplicate'::text])))
);


--
-- Name: build_computer_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.build_computer_preferences (
    host_key text NOT NULL,
    target jsonb NOT NULL,
    revision bigint NOT NULL,
    build_enabled boolean NOT NULL,
    build_priority integer NOT NULL,
    updated_by text NOT NULL,
    build_allowance_percent integer DEFAULT 100 NOT NULL,
    CONSTRAINT build_computer_preferences_build_allowance_percent_check CHECK (((build_allowance_percent >= 10) AND (build_allowance_percent <= 100))),
    CONSTRAINT build_computer_preferences_build_priority_check CHECK (((build_priority >= 0) AND (build_priority <= 100))),
    CONSTRAINT build_computer_preferences_revision_check CHECK ((revision > 0))
);


--
-- Name: ci_dispatch_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_dispatch_claims (
    ticket_id text NOT NULL,
    owner_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: ci_enrollment_computers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_enrollment_computers (
    workspace_id text NOT NULL,
    host_key text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    profiles jsonb DEFAULT '{}'::jsonb NOT NULL,
    state jsonb NOT NULL
);


--
-- Name: ci_enrollment_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_enrollment_workspaces (
    workspace_id text NOT NULL,
    principal jsonb NOT NULL
);


--
-- Name: ci_file_durations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_file_durations (
    repository text NOT NULL,
    file text NOT NULL,
    duration_ms integer NOT NULL,
    samples integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ci_file_durations_duration_ms_check CHECK ((duration_ms > 0))
);


--
-- Name: ci_group_requesters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_group_requesters (
    group_id uuid NOT NULL,
    workspace_id text NOT NULL,
    principal_id text NOT NULL,
    execution_id text,
    initiator boolean NOT NULL,
    command_id text,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    detached_at timestamp with time zone
);


--
-- Name: ci_request_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_request_groups (
    group_id uuid NOT NULL,
    workspace_id text NOT NULL,
    request_key text NOT NULL,
    output jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ci_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_runs (
    id uuid NOT NULL,
    workspace_id text NOT NULL,
    group_id uuid NOT NULL,
    state text NOT NULL,
    host_key text,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    durations jsonb,
    activity_record_revision bigint DEFAULT 0 NOT NULL,
    test_results jsonb,
    log_tail text DEFAULT ''::text NOT NULL,
    result_cache_keys jsonb,
    CONSTRAINT ci_runs_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'passed'::text, 'failed'::text, 'canceled'::text, 'lost'::text])))
);


--
-- Name: ci_runtime_preparations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_runtime_preparations (
    id uuid NOT NULL,
    workspace_id text NOT NULL,
    device_id uuid NOT NULL,
    principal_id text NOT NULL,
    command_id text NOT NULL,
    record jsonb NOT NULL,
    active boolean NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: ci_test_result_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ci_test_result_cache (
    workspace_id text NOT NULL,
    repository text NOT NULL,
    cache_key text NOT NULL,
    file text NOT NULL,
    ticket_id uuid NOT NULL,
    commit text NOT NULL,
    passed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: claude_callback_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.claude_callback_receipts (
    owner_key text NOT NULL,
    callback_key text NOT NULL,
    input_hash text NOT NULL,
    record jsonb NOT NULL
);


--
-- Name: computer_sync_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computer_sync_identities (
    host_key text NOT NULL,
    target jsonb NOT NULL,
    identity jsonb NOT NULL
);


--
-- Name: computer_sync_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computer_sync_preferences (
    workspace_id text NOT NULL,
    host_key text NOT NULL,
    target jsonb NOT NULL,
    revision bigint NOT NULL,
    enabled boolean NOT NULL,
    updated_by text NOT NULL,
    CONSTRAINT computer_sync_preferences_revision_check CHECK ((revision > 0))
);


--
-- Name: conversation_session_controls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_session_controls (
    conversation_id text NOT NULL,
    record jsonb NOT NULL
);


--
-- Name: conversation_session_defaults; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_session_defaults (
    principal_id text NOT NULL,
    role text NOT NULL,
    subject text NOT NULL,
    profile_key text NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT conversation_session_defaults_role_check CHECK ((role = ANY (ARRAY['operator'::text, 'agent'::text])))
);


--
-- Name: current_workflow_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.current_workflow_publications (
    workflow_version_id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    base_version_id text,
    expected_revision bigint NOT NULL,
    principal_id text NOT NULL,
    command_id text NOT NULL,
    source text NOT NULL,
    input_hash text NOT NULL,
    input jsonb NOT NULL,
    content_json text NOT NULL,
    publication_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT current_workflow_publications_command_id_check CHECK ((command_id <> ''::text)),
    CONSTRAINT current_workflow_publications_content_json_check CHECK ((octet_length(content_json) <= 4194304)),
    CONSTRAINT current_workflow_publications_expected_revision_check CHECK (((expected_revision >= 1) AND (expected_revision <= '9007199254740990'::bigint))),
    CONSTRAINT current_workflow_publications_input_hash_check CHECK ((input_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT current_workflow_publications_source_check CHECK ((source = ANY (ARRAY['http'::text, 'mcp'::text])))
);


--
-- Name: device_authorization_secret; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_authorization_secret (
    singleton boolean NOT NULL,
    secret text NOT NULL,
    CONSTRAINT device_authorization_secret_singleton_check CHECK (singleton)
);


--
-- Name: device_main_identity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_main_identity (
    main_id uuid NOT NULL,
    record jsonb NOT NULL
);


--
-- Name: device_pairing_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_pairing_grants (
    id uuid NOT NULL,
    token_hash text NOT NULL,
    device_id uuid NOT NULL,
    authorization_revision bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_request_id uuid,
    consumed_at timestamp with time zone,
    principal_id text NOT NULL
);


--
-- Name: device_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_registrations (
    id uuid NOT NULL,
    main_id uuid NOT NULL,
    worker_installation_id uuid NOT NULL,
    public_key text NOT NULL,
    record jsonb NOT NULL,
    credential_hash text,
    credential_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: durable_interactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.durable_interactions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    run_id text NOT NULL,
    execution_id text NOT NULL,
    requesting_agent_id text NOT NULL,
    harness text NOT NULL,
    native_session_id text NOT NULL,
    native_request_id text NOT NULL,
    status text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_owner text,
    delivery_token text,
    delivery_fence bigint DEFAULT 0 NOT NULL,
    delivery_lease_expires_at timestamp with time zone,
    last_delivery_error jsonb,
    reconciliation_status text DEFAULT 'not_required'::text NOT NULL,
    approval_relationship_id text,
    approval_reviewer_execution_id text,
    approval_native_request_proof_id text,
    CONSTRAINT durable_interactions_reconciliation_status_check CHECK ((reconciliation_status = ANY (ARRAY['not_required'::text, 'required'::text, 'delivered'::text, 'not_delivered'::text, 'unknown'::text])))
);


--
-- Name: execution_dispatch_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_dispatch_intents (
    operation_id text NOT NULL,
    execution_id text NOT NULL,
    run_id text NOT NULL,
    node_id text NOT NULL,
    binding_hash text NOT NULL,
    attempt_id text NOT NULL,
    record jsonb NOT NULL,
    scheduler_owner_id text NOT NULL,
    scheduler_owner_fence text NOT NULL,
    CONSTRAINT execution_dispatch_intents_check CHECK ((((record ->> 'schemaVersion'::text) = '1'::text) AND ((record ->> 'protocolVersion'::text) = '1'::text) AND ((record ->> 'operationId'::text) = operation_id) AND ((record ->> 'executionId'::text) = execution_id) AND ((record ->> 'attemptId'::text) = attempt_id) AND ((record ->> 'runId'::text) = run_id) AND ((record ->> 'nodeId'::text) = node_id) AND ((record ->> 'bindingHash'::text) = binding_hash))),
    CONSTRAINT execution_dispatch_intents_record_check CHECK ((jsonb_typeof(record) = 'object'::text)),
    CONSTRAINT execution_dispatch_intents_record_check1 CHECK ((record ?& ARRAY['schemaVersion'::text, 'protocolVersion'::text, 'operationId'::text, 'executionId'::text, 'attemptId'::text, 'runId'::text, 'nodeId'::text, 'bindingHash'::text]))
);


--
-- Name: execution_dispatch_owner_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_dispatch_owner_grants (
    execution_id text NOT NULL,
    operation_id text NOT NULL,
    grant_id text NOT NULL,
    epoch text NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    scheduler_owner_id text NOT NULL,
    scheduler_owner_fence text NOT NULL,
    CONSTRAINT execution_dispatch_owner_grants_epoch_check CHECK ((epoch ~ '^[1-9][0-9]*$'::text))
);


--
-- Name: execution_native_closures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_native_closures (
    generation bigint NOT NULL,
    execution_id text NOT NULL,
    execution_identity jsonb NOT NULL,
    expected_reference jsonb,
    closed_reference jsonb,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    closed_without_session boolean DEFAULT false NOT NULL,
    detached_at timestamp with time zone,
    detached_reference jsonb,
    CONSTRAINT current_closure_shape CHECK (((((closed_at IS NULL) AND (closed_reference IS NULL) AND (NOT closed_without_session)) OR ((closed_at IS NOT NULL) AND (detached_at IS NULL) AND ((closed_without_session AND (closed_reference IS NULL) AND (expected_reference IS NULL)) OR ((NOT closed_without_session) AND (jsonb_typeof(closed_reference) = 'object'::text))))) AND (((detached_at IS NULL) AND (detached_reference IS NULL)) OR ((detached_at IS NOT NULL) AND (closed_at IS NULL) AND (jsonb_typeof(detached_reference) = 'object'::text))))),
    CONSTRAINT execution_native_closures_closed_reference_check CHECK (((closed_reference IS NULL) OR (jsonb_typeof(closed_reference) = 'object'::text))),
    CONSTRAINT execution_native_closures_execution_identity_check CHECK ((jsonb_typeof(execution_identity) = 'object'::text)),
    CONSTRAINT execution_native_closures_expected_reference_check CHECK (((expected_reference IS NULL) OR (jsonb_typeof(expected_reference) = 'object'::text)))
);


--
-- Name: execution_native_closures_generation_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.execution_native_closures ALTER COLUMN generation ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.execution_native_closures_generation_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: execution_native_placements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_native_placements (
    execution_id text NOT NULL,
    operation_id text NOT NULL,
    accepted_binding_hash text NOT NULL,
    binding_hash text NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT execution_native_placements_binding_hash_check CHECK ((binding_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT execution_native_placements_check CHECK ((((record ->> 'executionId'::text) = execution_id) AND ((record ->> 'operationId'::text) = operation_id) AND ((record ->> 'bindingHash'::text) = binding_hash) AND ((record ->> 'acceptedBindingHash'::text) = accepted_binding_hash)))
);


--
-- Name: execution_native_recoveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_native_recoveries (
    generation bigint NOT NULL,
    execution_id text NOT NULL,
    execution_identity jsonb NOT NULL,
    reference jsonb,
    owner_id text NOT NULL,
    owner_fence text NOT NULL,
    recovered_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT execution_native_recoveries_execution_identity_check CHECK ((jsonb_typeof(execution_identity) = 'object'::text)),
    CONSTRAINT execution_native_recoveries_reference_check CHECK (((reference IS NULL) OR (jsonb_typeof(reference) = 'object'::text)))
);


--
-- Name: execution_native_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_native_sessions (
    execution_id text NOT NULL,
    reference jsonb NOT NULL,
    workflow_finalized_at timestamp with time zone
);


--
-- Name: execution_work_result_repairs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_work_result_repairs (
    execution_id text NOT NULL,
    attempt integer NOT NULL,
    rejected_provider_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT execution_work_result_repairs_attempt_check CHECK (((attempt >= 1) AND (attempt <= 2)))
);


--
-- Name: file_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_allocations (
    allocation_id uuid NOT NULL,
    owner_principal_id text NOT NULL,
    request_id text NOT NULL,
    input_hash text NOT NULL,
    file_id text NOT NULL,
    revision_id text NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT file_allocations_input_hash_check CHECK ((input_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT file_allocations_request_id_check CHECK (((length(request_id) >= 1) AND (length(request_id) <= 200))),
    CONSTRAINT file_allocations_state_check CHECK ((state = ANY (ARRAY['allocated'::text, 'staged'::text, 'finalized'::text, 'canceled'::text])))
);


--
-- Name: file_artifact_edge_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_artifact_edge_reads (
    edge_id text NOT NULL,
    consumer_execution_id text NOT NULL,
    consumer_attempt_id text NOT NULL,
    read_at timestamp with time zone NOT NULL
);


--
-- Name: file_artifact_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_artifact_edges (
    edge_id text NOT NULL,
    command_id text NOT NULL,
    receiver_principal_id text NOT NULL,
    file_id text NOT NULL,
    revision_id text NOT NULL,
    record jsonb NOT NULL
);


--
-- Name: file_retention_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_retention_preferences (
    owner_principal_id text NOT NULL,
    duration_seconds integer DEFAULT 604800 NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT file_retention_preferences_duration_seconds_check CHECK (((duration_seconds >= 3600) AND (duration_seconds <= 31536000))),
    CONSTRAINT file_retention_preferences_revision_check CHECK ((revision >= 0))
);


--
-- Name: file_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_revisions (
    revision_id text NOT NULL,
    file_id text NOT NULL,
    filename text NOT NULL,
    media_type text NOT NULL,
    byte_size bigint NOT NULL,
    sha256 text NOT NULL,
    origin text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    storage_key uuid NOT NULL,
    CONSTRAINT file_revisions_byte_size_check CHECK (((byte_size >= 0) AND (byte_size <= 26214400))),
    CONSTRAINT file_revisions_class_check CHECK ((((origin = ANY (ARRAY['upload'::text, 'agent_output'::text, 'agent_copy'::text])) AND (media_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text, 'image/gif'::text, 'application/pdf'::text, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'::text, 'text/markdown'::text, 'application/zip'::text]))) OR ((origin = 'job_output'::text) AND (media_type = ANY (ARRAY['text/plain'::text, 'application/json'::text, 'application/xml'::text, 'text/html'::text, 'application/zip'::text, 'application/gzip'::text, 'application/octet-stream'::text]))))),
    CONSTRAINT file_revisions_filename_check CHECK (((length(filename) >= 1) AND (length(filename) <= 255))),
    CONSTRAINT file_revisions_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: file_tool_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_tool_artifacts (
    artifact_id uuid NOT NULL,
    binding text NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT file_tool_artifacts_binding_check CHECK ((binding ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT file_tool_artifacts_check CHECK (((((record ->> 'artifactId'::text) = (artifact_id)::text) AND ((record ->> 'binding'::text) = binding) AND ((record ->> 'state'::text) = ANY (ARRAY['writing'::text, 'complete'::text, 'failed'::text])) AND ((record ->> 'writeId'::text) IS NOT NULL) AND (((record ->> 'state'::text) <> 'complete'::text) OR (jsonb_typeof((record -> 'snapshot'::text)) = 'object'::text))) IS TRUE))
);


--
-- Name: file_tool_copy_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_tool_copy_receipts (
    owner_principal_id text NOT NULL,
    command_id text NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT file_tool_copy_receipts_command_id_check CHECK (((length(command_id) >= 8) AND (length(command_id) <= 200)))
);


--
-- Name: file_tool_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_tool_publications (
    owner_principal_id text NOT NULL,
    request_id text NOT NULL,
    binding text NOT NULL,
    file_id text NOT NULL,
    revision_id text NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT file_tool_publications_binding_check CHECK ((binding ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: file_tool_read_provenance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_tool_read_provenance (
    id bigint NOT NULL,
    binding text NOT NULL,
    run_id text NOT NULL,
    execution_id text NOT NULL,
    file_id text NOT NULL,
    revision_id text NOT NULL,
    read_at timestamp with time zone NOT NULL
);


--
-- Name: file_tool_read_provenance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.file_tool_read_provenance ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.file_tool_read_provenance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: file_tool_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_tool_sessions (
    token_hash text NOT NULL,
    record jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT file_tool_sessions_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.files (
    file_id text NOT NULL,
    owner_principal_id text NOT NULL,
    current_revision_id text NOT NULL,
    scope_kind text NOT NULL,
    chat_kind text,
    operator_id text,
    conversation_id text,
    agent_id text,
    workspace_id text,
    workflow_id text,
    run_id text,
    execution_id text,
    state text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    retention_duration_seconds integer,
    expires_at timestamp with time zone,
    activity_record_revision bigint DEFAULT 0 NOT NULL,
    job_execution_id text,
    CONSTRAINT files_scope_check CHECK ((
CASE scope_kind
    WHEN 'temporary'::text THEN ((job_execution_id IS NULL) AND (conversation_id IS NOT NULL) AND ((retention_duration_seconds >= 3600) AND (retention_duration_seconds <= 31536000)) AND (expires_at = (created_at + ((retention_duration_seconds)::double precision * '00:00:01'::interval))) AND
    CASE chat_kind
        WHEN 'operator'::text THEN ((operator_id IS NOT NULL) AND (agent_id IS NULL) AND (workspace_id IS NULL) AND (workflow_id IS NULL) AND (run_id IS NULL) AND (execution_id IS NULL))
        WHEN 'agent'::text THEN ((operator_id IS NULL) AND (agent_id IS NOT NULL) AND (workspace_id IS NOT NULL) AND (workflow_id IS NOT NULL) AND (((run_id IS NULL) AND (execution_id IS NULL)) OR ((run_id IS NOT NULL) AND (execution_id IS NOT NULL))))
        ELSE false
    END)
    WHEN 'job_execution'::text THEN ((job_execution_id IS NOT NULL) AND (workspace_id IS NOT NULL) AND (chat_kind IS NULL) AND (conversation_id IS NULL) AND (operator_id IS NULL) AND (agent_id IS NULL) AND (workflow_id IS NULL) AND (run_id IS NULL) AND (execution_id IS NULL) AND ((retention_duration_seconds >= 3600) AND (retention_duration_seconds <= 31536000)) AND (expires_at = (created_at + ((retention_duration_seconds)::double precision * '00:00:01'::interval))))
    WHEN 'workflow_reference'::text THEN ((job_execution_id IS NULL) AND (chat_kind IS NULL) AND (conversation_id IS NULL) AND (operator_id IS NULL) AND (agent_id IS NULL) AND (workspace_id IS NOT NULL) AND (workflow_id IS NOT NULL) AND (run_id IS NULL) AND (execution_id IS NULL) AND (retention_duration_seconds IS NULL) AND (expires_at IS NULL) AND (state <> 'expired'::text))
    WHEN 'workspace_reference'::text THEN ((job_execution_id IS NULL) AND (chat_kind IS NULL) AND (conversation_id IS NULL) AND (operator_id IS NULL) AND (agent_id IS NULL) AND (workspace_id IS NOT NULL) AND (workflow_id IS NULL) AND (run_id IS NULL) AND (execution_id IS NULL) AND (retention_duration_seconds IS NULL) AND (expires_at IS NULL) AND (state <> 'expired'::text))
    ELSE false
END IS TRUE)),
    CONSTRAINT files_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'ready'::text, 'expired'::text, 'removed'::text])))
);


--
-- Name: graph_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_drafts (
    id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    revision bigint NOT NULL,
    base_workflow_version_id text,
    record jsonb NOT NULL,
    discarded_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: graph_edit_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_edit_intents (
    id text NOT NULL,
    principal_id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    draft_id text NOT NULL,
    state text NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT graph_edit_intents_check CHECK (((((record ->> 'id'::text) = id) AND ((record ->> 'ownerPrincipalId'::text) = principal_id) AND ((record ->> 'workspaceId'::text) = workspace_id) AND ((record ->> 'workflowId'::text) = workflow_id) AND ((record ->> 'draftId'::text) = draft_id) AND ((record ->> 'state'::text) = state)) IS TRUE)),
    CONSTRAINT graph_edit_intents_state_check CHECK ((state = ANY (ARRAY['staged'::text, 'stopping'::text, 'waiting'::text, 'saving'::text, 'blocked'::text, 'uncertain'::text, 'saved'::text, 'discarded'::text])))
);


--
-- Name: harness_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harness_executions (
    id text NOT NULL,
    run_id text NOT NULL,
    workflow_node_id text NOT NULL,
    agent_id text NOT NULL,
    attempt integer NOT NULL,
    accepted boolean DEFAULT false NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    worker_credentials_closed_at timestamp with time zone,
    native_event_next_sequence bigint DEFAULT 0 NOT NULL,
    repeat_occurrence_id text,
    work_activation_id text,
    activity_record_revision bigint DEFAULT 0 NOT NULL,
    tick_index integer,
    CONSTRAINT harness_executions_native_event_next_sequence_check CHECK ((native_event_next_sequence >= 0)),
    CONSTRAINT work_execution_not_repeat CHECK (((work_activation_id IS NULL) OR (repeat_occurrence_id IS NULL)))
);


--
-- Name: harness_instance_profile_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harness_instance_profile_evidence (
    check_id uuid NOT NULL,
    instance_id uuid NOT NULL,
    instance_revision bigint NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: harness_instance_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harness_instance_settings (
    instance_id uuid NOT NULL,
    revision bigint NOT NULL,
    host_key text NOT NULL,
    application_installation_id uuid NOT NULL,
    record jsonb NOT NULL,
    configuration_fingerprint text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT harness_instance_settings_revision_check CHECK ((revision > 0))
);


--
-- Name: harness_mcp_change_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harness_mcp_change_plans (
    id uuid NOT NULL,
    harness text NOT NULL,
    revision text NOT NULL,
    change jsonb NOT NULL,
    requested_by text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    decided_by text,
    error text,
    managed_preset text,
    native_user_after_hash text,
    native_file text,
    reconciled_revision text,
    host_ref jsonb,
    CONSTRAINT harness_mcp_change_plans_harness_check CHECK ((harness = ANY (ARRAY['codex'::text, 'claude'::text, 'opencode'::text]))),
    CONSTRAINT harness_mcp_change_plans_managed_preset_check CHECK ((managed_preset = ANY (ARRAY['graphql'::text, 'linear'::text, 'operator'::text, 'worker'::text]))),
    CONSTRAINT harness_mcp_change_plans_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'submitting'::text, 'applied'::text, 'rejected'::text, 'failed'::text, 'uncertain'::text, 'reconciled'::text])))
);


--
-- Name: harness_native_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harness_native_events (
    execution_id text NOT NULL,
    sequence integer NOT NULL,
    record jsonb NOT NULL,
    connection_id text,
    source_sequence integer,
    activity_identity jsonb GENERATED ALWAYS AS (public.native_activity_identity(record)) STORED,
    activity_finished boolean GENERATED ALWAYS AS (public.native_activity_finished(record)) STORED,
    occurred_at timestamp with time zone
);


--
-- Name: harness_qualifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harness_qualifications (
    harness text NOT NULL,
    version text NOT NULL,
    binary_sha256 text NOT NULL,
    suite_revision text NOT NULL,
    profile text NOT NULL,
    status text NOT NULL,
    checks jsonb DEFAULT '[]'::jsonb NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    failure_reason text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    checked_at timestamp with time zone,
    CONSTRAINT harness_qualifications_binary_sha256_check CHECK ((binary_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT harness_qualifications_harness_check CHECK ((harness = ANY (ARRAY['codex'::text, 'opencode'::text]))),
    CONSTRAINT harness_qualifications_status_check CHECK ((status = ANY (ARRAY['qualifying'::text, 'passed'::text, 'failed'::text])))
);


--
-- Name: host_harness_measurements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_harness_measurements (
    identity_hash text NOT NULL,
    harness text NOT NULL,
    binary_sha256 text NOT NULL,
    suite_revision text NOT NULL,
    qualification jsonb NOT NULL,
    evidence jsonb NOT NULL
);


--
-- Name: interaction_delivery_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.interaction_delivery_attempts (
    interaction_id text NOT NULL,
    attempt integer NOT NULL,
    state text NOT NULL,
    native_session_id text NOT NULL,
    native_request_id text NOT NULL,
    correlation_id text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_fence bigint DEFAULT 0 NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    approval_write_started_at timestamp with time zone,
    approval_connection_generation bigint,
    remote_owner_control jsonb,
    remote_owner_control_token text,
    remote_owner_control_fence bigint,
    remote_owner_control_generation bigint,
    CONSTRAINT interaction_delivery_attempt_approval_connection_generati_check CHECK ((approval_connection_generation >= 0)),
    CONSTRAINT interaction_delivery_attempts_attempt_check CHECK ((attempt > 0)),
    CONSTRAINT interaction_delivery_attempts_state_check CHECK ((state = ANY (ARRAY['submitted'::text, 'uncertain'::text, 'delivered'::text, 'failed'::text]))),
    CONSTRAINT remote_owner_control_snapshot CHECK ((((remote_owner_control IS NULL) AND (remote_owner_control_token IS NULL) AND (remote_owner_control_fence IS NULL) AND (remote_owner_control_generation IS NULL)) OR (((jsonb_typeof(remote_owner_control) = 'object'::text) AND ((remote_owner_control ->> 'schemaVersion'::text) = '1'::text) AND ((remote_owner_control #>> '{action,kind}'::text[]) = 'respond'::text) AND ((remote_owner_control #>> '{action,interactionId}'::text[]) = interaction_id) AND ((remote_owner_control #>> '{native,sessionId}'::text[]) = native_session_id) AND ((remote_owner_control #>> '{action,nativeInteractionId}'::text[]) = native_request_id) AND (length(remote_owner_control_token) > 0) AND (remote_owner_control_fence > 0) AND (remote_owner_control_generation >= 0)) IS TRUE)))
);


--
-- Name: interaction_graph_resumes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.interaction_graph_resumes (
    interaction_id text NOT NULL,
    run_id text NOT NULL,
    execution_id text NOT NULL,
    graph_thread_id text NOT NULL,
    graph_interrupt_id text,
    delivery_revision bigint NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_token text,
    lease_fence bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    last_error text,
    completed_at timestamp with time zone,
    approval_dispatch_started_at timestamp with time zone,
    approval_native_ack_id text,
    approval_native_ack_source jsonb,
    approval_native_ack_record jsonb,
    CONSTRAINT interaction_graph_resumes_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT interaction_graph_resumes_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'resuming'::text, 'resumed'::text, 'blocked'::text, 'canceled'::text])))
);


--
-- Name: interaction_reconciliation_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.interaction_reconciliation_evidence (
    sequence bigint NOT NULL,
    interaction_id text NOT NULL,
    attempt integer,
    delivery_fence bigint NOT NULL,
    native_session_id text NOT NULL,
    native_request_id text NOT NULL,
    correlation_id text,
    outcome text NOT NULL,
    evidence jsonb NOT NULL,
    error jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT interaction_reconciliation_evidence_outcome_check CHECK ((outcome = ANY (ARRAY['delivered'::text, 'not_delivered'::text, 'unknown'::text])))
);


--
-- Name: interaction_reconciliation_evidence_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.interaction_reconciliation_evidence ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.interaction_reconciliation_evidence_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: job_admission_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_admission_queue (
    id uuid NOT NULL,
    workspace_id text NOT NULL,
    principal_id text NOT NULL,
    command_id text NOT NULL,
    execution_id text NOT NULL,
    enqueue_sequence bigint NOT NULL,
    record jsonb NOT NULL,
    definition_version_id text GENERATED ALWAYS AS ((record #>> '{definition,versionId}'::text[])) STORED NOT NULL,
    attempt_id text GENERATED ALWAYS AS ((record ->> 'attemptId'::text)) STORED NOT NULL,
    operation_id text GENERATED ALWAYS AS ((record ->> 'operationId'::text)) STORED NOT NULL,
    backfill_claims integer DEFAULT 0 NOT NULL,
    diagnostic_codes jsonb DEFAULT '[]'::jsonb NOT NULL,
    owner_id text,
    owner_fence text,
    CONSTRAINT job_admission_queue_backfill_claims_check CHECK ((backfill_claims >= 0)),
    CONSTRAINT job_admission_queue_check CHECK (((length(command_id) > 0) AND (length(execution_id) > 0) AND (length(attempt_id) > 0) AND (length(operation_id) > 0))),
    CONSTRAINT job_admission_queue_check1 CHECK (COALESCE((((record ->> 'schemaVersion'::text) = '1'::text) AND ((record ->> 'id'::text) = (id)::text) AND ((record ->> 'workspaceId'::text) = workspace_id) AND ((record ->> 'principalId'::text) = principal_id) AND ((record ->> 'commandId'::text) = command_id) AND ((record ->> 'executionId'::text) = execution_id) AND ((record ->> 'enqueueSequence'::text) = (enqueue_sequence)::text) AND ((record #>> '{definition,workspaceId}'::text[]) = workspace_id)), false)),
    CONSTRAINT job_admission_queue_check2 CHECK (COALESCE((((record -> 'reservationId'::text) = 'null'::jsonb) OR ((record ->> 'reservationId'::text) = (id)::text)), false)),
    CONSTRAINT job_admission_queue_check4 CHECK (((owner_id IS NULL) = (owner_fence IS NULL))),
    CONSTRAINT job_admission_queue_check5 CHECK (((owner_id IS NULL) OR ((owner_id ~ '^[1-9][0-9]*$'::text) AND (owner_fence ~ '^[1-9][0-9]*$'::text)))),
    CONSTRAINT job_admission_queue_diagnostic_codes_check CHECK ((jsonb_typeof(diagnostic_codes) = 'array'::text)),
    CONSTRAINT job_admission_queue_enqueue_sequence_check CHECK ((enqueue_sequence > 0)),
    CONSTRAINT job_admission_queue_record_check CHECK (((jsonb_typeof(record) = 'object'::text) AND (record ?& ARRAY['schemaVersion'::text, 'id'::text, 'workspaceId'::text, 'principalId'::text, 'commandId'::text, 'commandDigest'::text, 'definition'::text, 'executionId'::text, 'attemptId'::text, 'operationId'::text, 'resources'::text, 'placement'::text, 'placementOverride'::text, 'workflow'::text, 'gateId'::text, 'revision'::text, 'enqueueSequence'::text, 'enqueuedAt'::text, 'deadlineAt'::text, 'state'::text, 'waitingReasons'::text, 'compatibleTargetCount'::text, 'queuePosition'::text, 'estimatedStartAt'::text, 'reservationId'::text, 'cancelRequestedAt'::text, 'terminalReason'::text, 'finishedAt'::text]))),
    CONSTRAINT job_admission_queue_record_check1 CHECK (((jsonb_typeof((record -> 'revision'::text)) = 'number'::text) AND ((((record ->> 'revision'::text))::numeric >= (1)::numeric) AND (((record ->> 'revision'::text))::numeric <= ('9007199254740991'::bigint)::numeric)) AND (((record ->> 'revision'::text))::numeric = trunc(((record ->> 'revision'::text))::numeric)))),
    CONSTRAINT job_admission_queue_record_check2 CHECK (COALESCE(((record ->> 'commandDigest'::text) ~ '^[a-f0-9]{64}$'::text), false)),
    CONSTRAINT job_admission_queue_record_check3 CHECK (COALESCE(((record ->> 'state'::text) = ANY (ARRAY['waiting'::text, 'blocked'::text, 'claimed'::text, 'accepted'::text, 'terminal'::text])), false)),
    CONSTRAINT job_admission_queue_record_check4 CHECK ((jsonb_typeof((record -> 'waitingReasons'::text)) = 'array'::text)),
    CONSTRAINT job_admission_queue_record_check6 CHECK ((((record ->> 'terminalReason'::text) IS DISTINCT FROM 'cancelled'::text) OR ((record ->> 'cancelRequestedAt'::text) IS NOT NULL))),
    CONSTRAINT job_admission_queue_record_check7 CHECK (COALESCE(((((record ->> 'deadlineAt'::text))::timestamp with time zone - ((record ->> 'enqueuedAt'::text))::timestamp with time zone) = ((((record #>> '{definition,spec,policy,queueTimeoutMs}'::text[]))::bigint)::double precision * '00:00:00.001'::interval)), false)),
    CONSTRAINT job_admission_queue_reservation_state CHECK (COALESCE(((((record ->> 'state'::text) = ANY (ARRAY['claimed'::text, 'accepted'::text])) AND ((record ->> 'reservationId'::text) = (id)::text)) OR (((record ->> 'state'::text) = ANY (ARRAY['waiting'::text, 'blocked'::text])) AND ((record -> 'reservationId'::text) = 'null'::jsonb)) OR (((record ->> 'state'::text) = 'waiting'::text) AND ((record ->> 'reservationId'::text) = (id)::text) AND (record ? 'sourceCapacityWait'::text)) OR ((record ->> 'state'::text) = 'terminal'::text)), false)),
    CONSTRAINT job_admission_queue_source_capacity_wait CHECK (((NOT (record ? 'sourceCapacityWait'::text)) OR COALESCE((((record ->> 'state'::text) = 'waiting'::text) AND ((record ->> 'reservationId'::text) = (id)::text) AND ((record -> 'waitingReasons'::text) @> '["busy"]'::jsonb) AND (jsonb_typeof((record -> 'sourceCapacityWait'::text)) = 'object'::text) AND (((record #>> '{sourceCapacityWait,attempts}'::text[]))::bigint > 0) AND (((record #>> '{sourceCapacityWait,waitedMs}'::text[]))::bigint >= 0) AND (((record #>> '{sourceCapacityWait,retryAt}'::text[]))::timestamp with time zone >= ((record #>> '{sourceCapacityWait,startedAt}'::text[]))::timestamp with time zone)), false))),
    CONSTRAINT job_admission_queue_terminal CHECK (COALESCE(((((record ->> 'state'::text) = 'terminal'::text) AND ((record ->> 'terminalReason'::text) = ANY (ARRAY['cancelled'::text, 'timed_out'::text, 'authorization_revoked'::text, 'request_exceeds_maximum'::text, 'completed'::text])) AND ((record ->> 'finishedAt'::text) IS NOT NULL) AND (((record ->> 'terminalReason'::text) <> 'completed'::text) OR ((record ->> 'reservationId'::text) = (id)::text))) OR (((record ->> 'state'::text) <> 'terminal'::text) AND ((record -> 'terminalReason'::text) = 'null'::jsonb) AND ((record -> 'finishedAt'::text) = 'null'::jsonb))), false))
);


--
-- Name: job_admission_queue_sequence; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.job_admission_queue_sequence
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: job_computer_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_computer_selections (
    execution_id text NOT NULL,
    workspace_id text NOT NULL,
    definition_version_id text NOT NULL,
    attempt_id text NOT NULL,
    operation_id text NOT NULL,
    host_key text NOT NULL,
    spec jsonb NOT NULL,
    limits jsonb NOT NULL,
    selection jsonb NOT NULL,
    source_scope text NOT NULL,
    source_bytes bigint NOT NULL,
    released_at timestamp with time zone,
    claimed_at timestamp with time zone DEFAULT clock_timestamp(),
    CONSTRAINT job_computer_selections_source_bytes_check CHECK ((source_bytes >= 0))
);


--
-- Name: job_definition_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_definition_versions (
    id text NOT NULL,
    definition_id text NOT NULL,
    workspace_id text NOT NULL,
    revision bigint NOT NULL,
    record jsonb NOT NULL
);


--
-- Name: job_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_definitions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    revision bigint NOT NULL,
    version_id text NOT NULL,
    record jsonb NOT NULL,
    updated_by text NOT NULL,
    CONSTRAINT job_definitions_revision_check CHECK ((revision > 0))
);


--
-- Name: job_dispatch_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_dispatch_intents (
    execution_id text NOT NULL,
    workspace_id text NOT NULL,
    intent jsonb NOT NULL,
    owner_id text,
    owner_fence text,
    receipt_sequence bigint DEFAULT 0 NOT NULL,
    last_receipt jsonb,
    delivery_attempted boolean DEFAULT false NOT NULL,
    cancel_command_id text,
    cancel_principal_id text,
    cancel_action text,
    launch_blocked_reason text,
    cancel_cleanup jsonb,
    CONSTRAINT job_cleanup_actual_subject CHECK (((cancel_cleanup IS NULL) OR (((jsonb_typeof(cancel_cleanup) = 'object'::text) AND (cancel_cleanup ?& ARRAY['schemaVersion'::text, 'id'::text, 'commandId'::text, 'workspaceId'::text, 'workflowId'::text, 'workflowVersionId'::text, 'runId'::text, 'nodeId'::text, 'nodeExecutionId'::text, 'executionId'::text, 'attemptId'::text, 'operationId'::text, 'bindingHash'::text, 'jobOwner'::text, 'runOwner'::text, 'reason'::text, 'cleanupRequestedAt'::text, 'requestedAt'::text]) AND ((cancel_cleanup ->> 'schemaVersion'::text) = '1'::text) AND ((cancel_cleanup ->> 'executionId'::text) = execution_id) AND ((cancel_cleanup ->> 'commandId'::text) = cancel_command_id) AND ((cancel_cleanup ->> 'attemptId'::text) = (intent ->> 'attemptId'::text)) AND ((cancel_cleanup ->> 'operationId'::text) = (intent ->> 'operationId'::text)) AND ((cancel_cleanup ->> 'bindingHash'::text) = (intent ->> 'bindingHash'::text)) AND ((cancel_cleanup -> 'jobOwner'::text) = (intent -> 'owner'::text)) AND (((intent -> 'subject'::text) ->> 'kind'::text) = 'workflow-node'::text) AND ((cancel_cleanup ->> 'runId'::text) = ((intent -> 'subject'::text) ->> 'runId'::text)) AND ((cancel_cleanup ->> 'nodeId'::text) = ((intent -> 'subject'::text) ->> 'nodeId'::text)) AND ((cancel_cleanup ->> 'nodeExecutionId'::text) = ((intent -> 'subject'::text) ->> 'nodeExecutionId'::text)) AND ((cancel_cleanup ->> 'workflowId'::text) = ((intent -> 'subject'::text) ->> 'workflowId'::text)) AND ((cancel_cleanup ->> 'workspaceId'::text) = workspace_id)) IS TRUE))),
    CONSTRAINT job_dispatch_intents_cancel_action_check CHECK ((cancel_action = ANY (ARRAY['jobs:cancel'::text, 'runs:stop'::text]))),
    CONSTRAINT job_dispatch_intents_launch_blocked_reason_check CHECK ((launch_blocked_reason = 'build_disabled'::text))
);


--
-- Name: job_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_executions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    definition_version_id text NOT NULL,
    operation_id text NOT NULL,
    attempt_id text NOT NULL,
    record jsonb NOT NULL,
    accepted_spec jsonb NOT NULL,
    accepted_by text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    log_bytes bigint DEFAULT 0 NOT NULL,
    log_sequence bigint DEFAULT 0 NOT NULL,
    log_truncated boolean DEFAULT false NOT NULL,
    activity_record_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT job_executions_log_bytes_check CHECK ((log_bytes >= 0)),
    CONSTRAINT job_executions_log_sequence_check CHECK ((log_sequence >= 0))
);


--
-- Name: job_log_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_log_chunks (
    execution_id text NOT NULL,
    sequence bigint NOT NULL,
    attempt_id text NOT NULL,
    stream text NOT NULL,
    text text NOT NULL,
    byte_size integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT job_log_chunks_byte_size_check CHECK (((byte_size >= 0) AND (byte_size <= 65536))),
    CONSTRAINT job_log_chunks_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT job_log_chunks_stream_check CHECK ((stream = ANY (ARRAY['stdout'::text, 'stderr'::text])))
);


--
-- Name: job_preparations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_preparations (
    execution_id text NOT NULL,
    attempt_id text NOT NULL,
    operation_id text NOT NULL,
    workspace_id text NOT NULL,
    definition_version_id text NOT NULL,
    principal_id text NOT NULL,
    command_id text NOT NULL,
    definition jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: job_runtime_profile_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_runtime_profile_versions (
    profile_id text NOT NULL,
    revision bigint NOT NULL,
    record jsonb NOT NULL
);


--
-- Name: job_runtime_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_runtime_profiles (
    id text NOT NULL,
    workspace_id text NOT NULL,
    revision bigint NOT NULL,
    root_id uuid NOT NULL,
    binding_revision bigint NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT job_runtime_profiles_revision_check CHECK ((revision > 0))
);


--
-- Name: job_runtime_qualification_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_runtime_qualification_approvals (
    id uuid NOT NULL,
    qualification_id uuid NOT NULL,
    profile_id text NOT NULL,
    profile_revision bigint NOT NULL,
    workspace_id text NOT NULL,
    record jsonb NOT NULL,
    measurement jsonb,
    run_result jsonb,
    run_command_id text,
    run_principal_id text,
    requested_by text NOT NULL,
    approved_by text,
    native_admission jsonb,
    CONSTRAINT job_runtime_native_admission_subject CHECK (((native_admission IS NULL) OR ((jsonb_typeof(native_admission) = 'object'::text) AND (native_admission ?& ARRAY['kind'::text, 'approvalId'::text, 'qualificationId'::text, 'operationId'::text, 'workspaceId'::text, 'profileId'::text, 'profileRevision'::text, 'runCommandId'::text, 'runPrincipalId'::text, 'leaseId'::text]) AND (run_command_id IS NOT NULL) AND (run_principal_id IS NOT NULL) AND ((native_admission ->> 'kind'::text) = 'job-runtime-qualification'::text) AND ((native_admission ->> 'approvalId'::text) = (id)::text) AND ((native_admission ->> 'qualificationId'::text) = (qualification_id)::text) AND ((native_admission ->> 'operationId'::text) = (qualification_id)::text) AND ((native_admission ->> 'workspaceId'::text) = workspace_id) AND ((native_admission ->> 'profileId'::text) = profile_id) AND ((native_admission ->> 'profileRevision'::text) = (profile_revision)::text) AND ((native_admission ->> 'runCommandId'::text) = run_command_id) AND ((native_admission ->> 'runPrincipalId'::text) = run_principal_id) AND (((native_admission ->> 'approvedByPrincipalId'::text) IS NULL) OR ((native_admission ->> 'approvedByPrincipalId'::text) = approved_by)))))
);


--
-- Name: local_human_principal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_human_principal (
    singleton boolean DEFAULT true NOT NULL,
    principal_id text NOT NULL,
    CONSTRAINT local_human_principal_singleton_check CHECK (singleton)
);


--
-- Name: local_workflow_native_output_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_workflow_native_output_chunks (
    artifact_id uuid NOT NULL,
    byte_offset integer NOT NULL,
    bytes bytea NOT NULL,
    CONSTRAINT local_workflow_native_output_chunks_byte_offset_check CHECK (((byte_offset >= 0) AND (byte_offset <= 67108864))),
    CONSTRAINT local_workflow_native_output_chunks_bytes_check CHECK (((octet_length(bytes) >= 1) AND (octet_length(bytes) <= 65536)))
);


--
-- Name: local_workflow_native_output_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_workflow_native_output_commands (
    execution_id text NOT NULL,
    binding text NOT NULL,
    command_id text NOT NULL,
    input_hash text NOT NULL,
    reply jsonb,
    CONSTRAINT local_workflow_native_output_commands_binding_check CHECK ((binding ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT local_workflow_native_output_commands_input_hash_check CHECK ((input_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: local_workflow_native_outputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_workflow_native_outputs (
    artifact_id uuid NOT NULL,
    main_id uuid NOT NULL,
    execution_id text NOT NULL,
    binding text NOT NULL,
    description jsonb NOT NULL,
    byte_size integer DEFAULT 0 NOT NULL,
    sha256 text,
    publication jsonb,
    retired_at timestamp with time zone,
    CONSTRAINT local_workflow_native_outputs_binding_check CHECK ((binding ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT local_workflow_native_outputs_byte_size_check CHECK (((byte_size >= 0) AND (byte_size <= 67108864))),
    CONSTRAINT local_workflow_native_outputs_sha256_check CHECK (((sha256 IS NULL) OR (sha256 ~ '^[a-f0-9]{64}$'::text)))
);


--
-- Name: management_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.management_audit (
    sequence bigint NOT NULL,
    principal_id text,
    source text NOT NULL,
    action text NOT NULL,
    target_key text NOT NULL,
    outcome text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: management_audit_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.management_audit ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.management_audit_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: management_command_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.management_command_receipts (
    principal_id text NOT NULL,
    operation text NOT NULL,
    command_id text NOT NULL,
    target_key text NOT NULL,
    input_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activity_record_revision bigint DEFAULT 0 NOT NULL,
    activity_status text GENERATED ALWAYS AS ((result ->> 'status'::text)) STORED,
    activity_control jsonb GENERATED ALWAYS AS ((result -> 'acceptedControl'::text)) STORED,
    activity_acknowledgment jsonb GENERATED ALWAYS AS ((result -> 'providerAcknowledgment'::text)) STORED
);


--
-- Name: management_principals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.management_principals (
    id text NOT NULL,
    name text NOT NULL,
    audience text NOT NULL,
    token_hash text,
    grants jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_id text,
    delegated_from text,
    CONSTRAINT management_principals_audience_check CHECK ((audience = ANY (ARRAY['operator'::text, 'worker'::text, 'user'::text]))),
    CONSTRAINT management_principals_credential_required CHECK (((token_hash IS NOT NULL) OR (id = 'principal-local-human'::text)))
);


--
-- Name: native_event_ingestion_sequence; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.native_event_ingestion_sequence
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: native_session_lanes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.native_session_lanes (
    id text NOT NULL,
    harness text NOT NULL,
    native_session_id text NOT NULL,
    owner_agent_id text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    record jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operator_chat_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_chat_credentials (
    principal_id text NOT NULL,
    conversation_id text NOT NULL
);


--
-- Name: operator_configuration_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_configuration_versions (
    id text NOT NULL,
    operator_id text NOT NULL,
    version integer NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operator_conversation_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_conversation_activity (
    sequence bigint NOT NULL,
    conversation_id text NOT NULL,
    request_id text NOT NULL,
    activity_id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    record jsonb NOT NULL,
    source_provenance jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: operator_conversation_activity_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.operator_conversation_activity ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.operator_conversation_activity_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operator_conversation_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_conversation_messages (
    id text NOT NULL,
    conversation_id text NOT NULL,
    sequence bigint NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    client_request_id text,
    native_message_id text,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activity_record_revision bigint DEFAULT 0 NOT NULL,
    text_provenance jsonb,
    CONSTRAINT operator_conversation_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text, 'tool'::text])))
);


--
-- Name: operator_conversation_messages_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.operator_conversation_messages ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.operator_conversation_messages_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operator_conversation_turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_conversation_turns (
    conversation_id text NOT NULL,
    request_id text NOT NULL,
    payload jsonb NOT NULL,
    input_hash text NOT NULL,
    retryable boolean DEFAULT false NOT NULL,
    result jsonb,
    operator_configuration_version_id text,
    turn_sequence bigint NOT NULL,
    intent text,
    delivery text,
    message_id text,
    native_turn_id text,
    target_native_turn_id text,
    delivery_error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    terminal_observation jsonb,
    native_closure_state text,
    terminal_history jsonb,
    terminal_history_persisted boolean DEFAULT false NOT NULL,
    CONSTRAINT operator_terminal_closure_state CHECK ((((terminal_observation IS NULL) AND (native_closure_state IS NULL)) OR ((terminal_observation IS NOT NULL) AND (native_closure_state IS NOT NULL) AND (native_closure_state = ANY (ARRAY['observed'::text, 'pending'::text, 'closed'::text]))))),
    CONSTRAINT operator_turns_agent_delivery_check CHECK ((((intent IS NULL) AND (delivery IS NULL)) OR ((intent = ANY (ARRAY['next_turn'::text, 'steer'::text, 'interrupt_and_send'::text])) AND (delivery = ANY (ARRAY['queued'::text, 'submitting'::text, 'accepted'::text, 'completed'::text, 'failed'::text, 'canceled'::text, 'unknown'::text])) AND (message_id IS NOT NULL))))
);


--
-- Name: operator_conversation_turns_turn_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.operator_conversation_turns ALTER COLUMN turn_sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.operator_conversation_turns_turn_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operator_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_conversations (
    id text NOT NULL,
    operator_id text,
    operator_configuration_version_id text,
    harness text NOT NULL,
    provider_version text,
    native_session_id text,
    active_request_id text,
    active_native_turn_id text,
    turn_state text DEFAULT 'idle'::text NOT NULL,
    last_error text,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_principal_id text,
    revision bigint DEFAULT 0 NOT NULL,
    active_phase text,
    cancel_requested boolean DEFAULT false NOT NULL,
    pending_interaction jsonb,
    response_delivery text,
    last_result jsonb,
    deleted_at timestamp with time zone,
    parent_conversation_id text,
    fork_request_id text,
    handoff_source_harness text,
    handoff_source_sequence bigint,
    handoff_omitted_messages integer DEFAULT 0 NOT NULL,
    handoff_context text,
    kind text DEFAULT 'operator'::text NOT NULL,
    agent_key text,
    workspace_id text,
    workflow_id text,
    workflow_node_id text,
    agent_id text,
    agent_configuration_version_id text,
    origin_run_id text,
    origin_execution_id text,
    worker_conversation_binding jsonb,
    CONSTRAINT operator_conversations_kind_check CHECK ((((kind = 'operator'::text) AND (operator_id IS NOT NULL) AND (operator_configuration_version_id IS NOT NULL) AND (agent_key IS NULL)) OR ((kind = 'agent'::text) AND (operator_id IS NULL) AND (owner_principal_id IS NULL) AND (agent_key IS NOT NULL) AND (workspace_id IS NOT NULL) AND (workflow_id IS NOT NULL) AND (workflow_node_id IS NOT NULL) AND (agent_id IS NOT NULL) AND (agent_configuration_version_id IS NOT NULL) AND ((origin_run_id IS NULL) = (origin_execution_id IS NULL))))),
    CONSTRAINT operator_conversations_turn_state_check CHECK ((turn_state = ANY (ARRAY['idle'::text, 'starting'::text, 'active'::text, 'canceling'::text, 'uncertain'::text, 'error'::text])))
);


--
-- Name: provider_account_accepted_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_account_accepted_bindings (
    owner_kind text NOT NULL,
    owner_id text NOT NULL,
    binding jsonb NOT NULL,
    account_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_account_accepted_bindings_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['run-node'::text, 'operator-command'::text, 'agent-conversation'::text])))
);


--
-- Name: provider_account_authentication_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_account_authentication_operations (
    id uuid NOT NULL,
    principal_id text NOT NULL,
    cancel_principal_id text,
    source text NOT NULL,
    account_id uuid NOT NULL,
    target_key text NOT NULL,
    command_id text NOT NULL,
    input_hash text NOT NULL,
    record jsonb NOT NULL,
    native_closed boolean DEFAULT false NOT NULL,
    CONSTRAINT provider_account_authentication_operations_source_check CHECK ((source = ANY (ARRAY['http'::text, 'mcp'::text, 'device'::text])))
);


--
-- Name: provider_account_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_account_observations (
    target_key text NOT NULL,
    account_id uuid NOT NULL,
    record jsonb NOT NULL
);


--
-- Name: remote_dispatch_origins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_dispatch_origins (
    operation_id text NOT NULL,
    connection jsonb NOT NULL,
    bound_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT remote_dispatch_origins_connection_check CHECK ((jsonb_typeof(connection) = 'object'::text))
);


--
-- Name: remote_execution_owner_reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_execution_owner_reconciliations (
    operation_id text NOT NULL,
    command_id text NOT NULL,
    ordinal bigint NOT NULL,
    transition jsonb NOT NULL,
    CONSTRAINT remote_execution_owner_reconciliations_check CHECK ((((transition ->> 'operationId'::text) = operation_id) AND ((transition ->> 'commandId'::text) = command_id))),
    CONSTRAINT remote_execution_owner_reconciliations_transition_check CHECK ((jsonb_typeof(transition) = 'object'::text))
);


--
-- Name: remote_execution_owner_reconciliations_ordinal_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.remote_execution_owner_reconciliations ALTER COLUMN ordinal ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.remote_execution_owner_reconciliations_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: remote_execution_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_execution_receipts (
    operation_id text NOT NULL,
    sequence bigint NOT NULL,
    receipt jsonb NOT NULL,
    CONSTRAINT remote_execution_receipts_check CHECK ((((receipt ->> 'schemaVersion'::text) = '1'::text) AND ((receipt #>> '{intent,operationId}'::text[]) = operation_id) AND (((receipt ->> 'sequence'::text))::bigint = sequence))),
    CONSTRAINT remote_execution_receipts_receipt_check CHECK ((jsonb_typeof(receipt) = 'object'::text)),
    CONSTRAINT remote_execution_receipts_sequence_check CHECK ((sequence > 0))
);


--
-- Name: remote_execution_recovery_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_execution_recovery_audit (
    operation_id text NOT NULL,
    ordinal bigint NOT NULL,
    reason text NOT NULL,
    evidence_digest text NOT NULL,
    CONSTRAINT remote_execution_recovery_audit_evidence_digest_check CHECK ((evidence_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT remote_execution_recovery_audit_reason_check CHECK ((length(reason) <= 100))
);


--
-- Name: remote_execution_recovery_audit_ordinal_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.remote_execution_recovery_audit ALTER COLUMN ordinal ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.remote_execution_recovery_audit_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: repeat_workflow_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repeat_workflow_publications (
    workflow_version_id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    base_version_id text NOT NULL,
    expected_revision bigint NOT NULL,
    principal_id text NOT NULL,
    command_id text NOT NULL,
    source text NOT NULL,
    input_hash text NOT NULL,
    input jsonb NOT NULL,
    content_json text NOT NULL,
    publication_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT repeat_workflow_publications_command_id_check CHECK ((command_id <> ''::text)),
    CONSTRAINT repeat_workflow_publications_content_json_check CHECK ((octet_length(content_json) <= 4194304)),
    CONSTRAINT repeat_workflow_publications_expected_revision_check CHECK (((expected_revision >= 1) AND (expected_revision <= '9007199254740990'::bigint))),
    CONSTRAINT repeat_workflow_publications_input_hash_check CHECK ((input_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT repeat_workflow_publications_source_check CHECK ((source = ANY (ARRAY['http'::text, 'mcp'::text])))
);


--
-- Name: review_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_jobs (
    id text NOT NULL,
    interaction_id text NOT NULL,
    reviewer_agent_id text NOT NULL,
    state text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    execution_id text,
    working_directory text,
    provider_version text,
    lease_owner text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    lease_fence bigint DEFAULT 0 NOT NULL,
    recovery_evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    approval_connection_generation bigint,
    approval_native_evidence jsonb,
    approval_original_proof_id text,
    CONSTRAINT review_jobs_approval_connection_generation_check CHECK ((approval_connection_generation >= 0))
);


--
-- Name: review_native_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_native_entries (
    job_id text NOT NULL,
    run_id text NOT NULL,
    execution_id text NOT NULL,
    phase text NOT NULL,
    record jsonb NOT NULL,
    record_json text NOT NULL,
    entry_proof_id text,
    source_id text,
    source_revision bigint,
    source_digest text,
    CONSTRAINT review_native_entries_check CHECK ((record = (record_json)::jsonb)),
    CONSTRAINT review_native_entries_check1 CHECK ((NOT ((record #>> '{scope,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT review_native_entries_check2 CHECK ((NOT ((record #>> '{execution,executionId}'::text[]) IS DISTINCT FROM execution_id))),
    CONSTRAINT review_native_entries_check3 CHECK ((NOT ((record #>> '{job,id}'::text[]) IS DISTINCT FROM job_id))),
    CONSTRAINT review_native_entries_check4 CHECK ((((phase = 'reserved'::text) AND (source_id IS NULL) AND (source_revision IS NULL) AND (source_digest IS NULL) AND (entry_proof_id IS NULL)) OR ((phase <> 'reserved'::text) AND (source_id IS NOT NULL) AND (source_revision IS NOT NULL) AND (source_digest IS NOT NULL) AND (((phase = 'entered'::text) AND (entry_proof_id IS NOT NULL)) OR ((phase = 'not_submitted'::text) AND (entry_proof_id IS NULL)))))),
    CONSTRAINT review_native_entries_phase_check CHECK ((phase = ANY (ARRAY['reserved'::text, 'entered'::text, 'not_submitted'::text]))),
    CONSTRAINT review_native_entries_record_check CHECK ((NOT ((record #> '{scope,executionSemanticsVersion}'::text[]) IS DISTINCT FROM '3'::jsonb))),
    CONSTRAINT review_native_entries_record_json_check CHECK ((octet_length(record_json) <= 4194304)),
    CONSTRAINT review_native_entries_source_digest_check CHECK ((source_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT review_native_entries_source_revision_check CHECK ((source_revision >= 0))
);


--
-- Name: review_native_proofs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_native_proofs (
    proof_id text NOT NULL,
    run_id text NOT NULL,
    execution_id text NOT NULL,
    job_id text NOT NULL,
    source_digest text NOT NULL,
    record jsonb NOT NULL,
    record_json text NOT NULL,
    CONSTRAINT review_native_proofs_check CHECK ((record = (record_json)::jsonb)),
    CONSTRAINT review_native_proofs_check1 CHECK ((source_digest = ('sha256:'::text || encode(sha256(convert_to(record_json, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT review_native_proofs_check2 CHECK ((NOT ((record ->> 'proofId'::text) IS DISTINCT FROM proof_id))),
    CONSTRAINT review_native_proofs_check3 CHECK ((NOT ((record #>> '{scope,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT review_native_proofs_check4 CHECK ((NOT ((record #>> '{execution,executionId}'::text[]) IS DISTINCT FROM execution_id))),
    CONSTRAINT review_native_proofs_check5 CHECK ((NOT ((record #>> '{job,id}'::text[]) IS DISTINCT FROM job_id))),
    CONSTRAINT review_native_proofs_record_check CHECK ((NOT ((record #> '{scope,executionSemanticsVersion}'::text[]) IS DISTINCT FROM '3'::jsonb))),
    CONSTRAINT review_native_proofs_record_check1 CHECK (((record #>> '{original,type}'::text[]) = ANY (ARRAY['entry'::text, 'event'::text, 'history'::text]))),
    CONSTRAINT review_native_proofs_record_json_check CHECK ((octet_length(record_json) <= 12582912))
);


--
-- Name: run_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_activity (
    run_id text NOT NULL,
    sequence bigint NOT NULL,
    source text NOT NULL,
    kind text NOT NULL,
    harness_execution_id text,
    occurred_at timestamp with time zone NOT NULL,
    payload jsonb NOT NULL
);


--
-- Name: run_activity_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.run_activity ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.run_activity_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: run_activity_streams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_activity_streams (
    run_id text NOT NULL
);


--
-- Name: run_authority_principals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_authority_principals (
    principal_id text NOT NULL,
    run_id text NOT NULL,
    owner_principal_id text NOT NULL,
    caller_principal_id text NOT NULL,
    grant_ceiling jsonb NOT NULL,
    accepted_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_authority_principals_check CHECK ((principal_id <> owner_principal_id)),
    CONSTRAINT run_authority_principals_grant_ceiling_check CHECK ((jsonb_typeof(grant_ceiling) = 'array'::text))
);


--
-- Name: run_board_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_board_snapshots (
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    workflow_version_id text NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    admission_trigger text NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT run_board_snapshots_admission_trigger_check CHECK ((admission_trigger = ANY (ARRAY['manual'::text, 'schedule'::text]))),
    CONSTRAINT run_board_snapshots_check CHECK (((((record ->> 'kind'::text) = 'available'::text) AND ((record ->> 'runId'::text) = run_id) AND ((record ->> 'workspaceId'::text) = workspace_id) AND ((record ->> 'workflowId'::text) = workflow_id) AND ((record ->> 'workflowVersionId'::text) = workflow_version_id) AND (((record ->> 'capturedAt'::text))::timestamp with time zone = captured_at) AND (jsonb_typeof((record -> 'nodes'::text)) = 'array'::text) AND (jsonb_typeof((record -> 'edges'::text)) = 'array'::text)) IS TRUE)),
    CONSTRAINT run_board_snapshots_record_check CHECK ((jsonb_typeof(record) = 'object'::text))
);


--
-- Name: run_checkpoint_owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_checkpoint_owners (
    run_id text NOT NULL,
    generation bigint NOT NULL,
    owner_pid integer NOT NULL,
    owner_started_at timestamp with time zone NOT NULL,
    CONSTRAINT run_checkpoint_owners_generation_check CHECK ((generation > 0))
);


--
-- Name: run_cleanup_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_cleanup_intents (
    run_id text NOT NULL,
    pending boolean DEFAULT true NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    failure_result jsonb,
    deadline_exceeded_at timestamp with time zone,
    CONSTRAINT run_cleanup_intents_failure_result_check CHECK (((failure_result IS NULL) OR ((jsonb_typeof(failure_result) = 'object'::text) AND ((failure_result ->> 'outcome'::text) = 'failed'::text) AND (jsonb_typeof((failure_result -> 'error'::text)) = 'object'::text))))
);


--
-- Name: run_graph_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_graph_batches (
    run_id text NOT NULL,
    sequence bigint NOT NULL,
    batch_id uuid NOT NULL,
    publication_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    kind text NOT NULL,
    payload text,
    payload_bytes integer GENERATED ALWAYS AS (COALESCE(octet_length(payload), 0)) STORED,
    reset_reason text,
    CONSTRAINT run_graph_batches_check CHECK ((((kind = 'events'::text) AND (payload IS NOT NULL) AND (octet_length(payload) <= 65536) AND (reset_reason IS NULL)) OR ((kind = 'reset'::text) AND (payload IS NULL) AND (reset_reason = 'atomic_change_too_large'::text)))),
    CONSTRAINT run_graph_batches_kind_check CHECK ((kind = ANY (ARRAY['events'::text, 'reset'::text]))),
    CONSTRAINT run_graph_batches_sequence_check CHECK ((sequence > 0))
);


--
-- Name: run_graph_effects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_graph_effects (
    run_id text NOT NULL,
    effect_kind text NOT NULL,
    entity_id text NOT NULL,
    effect_digest text NOT NULL,
    semantic_digest text NOT NULL,
    first_sequence bigint NOT NULL,
    CONSTRAINT run_graph_effects_effect_digest_check CHECK ((effect_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT run_graph_effects_effect_kind_check CHECK ((effect_kind = ANY (ARRAY['execution.launch'::text, 'result.accept'::text, 'route.resolve'::text, 'input.bind'::text, 'approval.decide'::text, 'approval.deliver'::text, 'graph.resume'::text, 'review.settle'::text, 'run.stop'::text]))),
    CONSTRAINT run_graph_effects_entity_id_check CHECK ((octet_length(entity_id) <= 200)),
    CONSTRAINT run_graph_effects_first_sequence_check CHECK ((first_sequence > 0)),
    CONSTRAINT run_graph_effects_semantic_digest_check CHECK ((semantic_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: run_graph_heads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_graph_heads (
    run_id text NOT NULL,
    protocol_version smallint NOT NULL,
    head_sequence bigint DEFAULT 0 NOT NULL,
    retention_floor bigint DEFAULT 0 NOT NULL,
    history_coverage text NOT NULL,
    CONSTRAINT run_graph_heads_check CHECK (((retention_floor >= 0) AND (retention_floor <= head_sequence))),
    CONSTRAINT run_graph_heads_head_sequence_check CHECK ((head_sequence >= 0)),
    CONSTRAINT run_graph_heads_history_coverage_check CHECK ((history_coverage = ANY (ARRAY['from_admission'::text, 'from_snapshot'::text]))),
    CONSTRAINT run_graph_heads_protocol_version_check CHECK ((protocol_version = 1))
);


--
-- Name: run_graph_public_projection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_graph_public_projection (
    run_id text NOT NULL,
    sequence bigint NOT NULL,
    record jsonb NOT NULL,
    source_id text NOT NULL,
    source_digest text NOT NULL,
    semantic_digest text NOT NULL,
    CONSTRAINT run_graph_public_projection_record_check CHECK ((jsonb_typeof(record) = 'object'::text)),
    CONSTRAINT run_graph_public_projection_semantic_digest_check CHECK ((semantic_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT run_graph_public_projection_sequence_check CHECK ((sequence >= 1)),
    CONSTRAINT run_graph_public_projection_source_digest_check CHECK ((source_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: run_graph_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_graph_sources (
    run_id text NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    source_revision bigint NOT NULL,
    source_digest text NOT NULL,
    semantic_digest text NOT NULL,
    first_sequence bigint NOT NULL,
    CONSTRAINT run_graph_sources_first_sequence_check CHECK ((first_sequence > 0)),
    CONSTRAINT run_graph_sources_semantic_digest_check CHECK ((semantic_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT run_graph_sources_source_digest_check CHECK ((source_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT run_graph_sources_source_id_check CHECK ((octet_length(source_id) <= 200)),
    CONSTRAINT run_graph_sources_source_kind_check CHECK ((source_kind = ANY (ARRAY['run'::text, 'execution'::text, 'native_event'::text, 'node_resolution'::text, 'input_binding'::text, 'interaction'::text, 'delivery'::text, 'review'::text, 'cleanup'::text]))),
    CONSTRAINT run_graph_sources_source_revision_check CHECK ((source_revision >= 0))
);


--
-- Name: run_input_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_input_bindings (
    run_id text NOT NULL,
    binding_id text NOT NULL,
    relationship_id text NOT NULL,
    sender_execution_id text NOT NULL,
    sender_node_id text NOT NULL,
    sender_attempt integer NOT NULL,
    recipient_execution_id text NOT NULL,
    recipient_node_id text NOT NULL,
    recipient_attempt integer NOT NULL,
    accepted_result_digest text NOT NULL,
    recipient_input_digest text NOT NULL,
    input_ordinal integer NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT run_input_bindings_accepted_result_digest_check CHECK ((accepted_result_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT run_input_bindings_check CHECK (((sender_execution_id <> recipient_execution_id) AND (sender_node_id <> recipient_node_id))),
    CONSTRAINT run_input_bindings_input_ordinal_check CHECK (((input_ordinal >= 0) AND (input_ordinal < 8000))),
    CONSTRAINT run_input_bindings_recipient_attempt_check CHECK ((recipient_attempt = 1)),
    CONSTRAINT run_input_bindings_recipient_input_digest_check CHECK ((recipient_input_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT run_input_bindings_sender_attempt_check CHECK ((sender_attempt = 1))
);


--
-- Name: run_native_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_native_activity (
    run_id text NOT NULL,
    execution_id text NOT NULL,
    workflow_node_id text NOT NULL,
    attempt integer NOT NULL,
    work_kind text NOT NULL,
    work_id text NOT NULL,
    review_job_id text GENERATED ALWAYS AS (
CASE
    WHEN (work_kind = 'review'::text) THEN work_id
    ELSE NULL::text
END) STORED,
    last_native_sequence bigint,
    terminal_native_sequence bigint,
    projection_revision bigint NOT NULL,
    activity jsonb NOT NULL,
    CONSTRAINT run_native_activity_check CHECK (((work_kind <> 'workflow'::text) OR (work_id = execution_id))),
    CONSTRAINT run_native_activity_check1 CHECK (((terminal_native_sequence IS NULL) OR ((last_native_sequence IS NOT NULL) AND (terminal_native_sequence <= last_native_sequence)))),
    CONSTRAINT run_native_activity_last_native_sequence_check CHECK ((last_native_sequence >= 0)),
    CONSTRAINT run_native_activity_projection_revision_check CHECK ((projection_revision >= 0)),
    CONSTRAINT run_native_activity_terminal_native_sequence_check CHECK ((terminal_native_sequence >= 0)),
    CONSTRAINT run_native_activity_work_kind_check CHECK ((work_kind = ANY (ARRAY['workflow'::text, 'review'::text])))
);


--
-- Name: run_native_correlations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_native_correlations (
    run_id text NOT NULL,
    execution_id text NOT NULL,
    workflow_node_id text NOT NULL,
    attempt integer NOT NULL,
    work_kind text NOT NULL,
    work_id text NOT NULL,
    correlation_key text NOT NULL,
    provider text NOT NULL,
    native_session_id text NOT NULL,
    connection_id text,
    connection_generation integer NOT NULL,
    native_turn_id text,
    native_request_id text,
    interaction_id text,
    review_job_id text,
    first_native_sequence bigint NOT NULL,
    last_native_sequence bigint NOT NULL,
    terminal_native_sequence bigint,
    metadata_revision bigint NOT NULL,
    CONSTRAINT run_native_correlations_check CHECK ((last_native_sequence >= first_native_sequence)),
    CONSTRAINT run_native_correlations_check1 CHECK (((terminal_native_sequence >= first_native_sequence) AND (terminal_native_sequence <= last_native_sequence))),
    CONSTRAINT run_native_correlations_check2 CHECK ((((work_kind = 'workflow'::text) AND (work_id = execution_id) AND (review_job_id IS NULL)) OR ((work_kind = 'review'::text) AND (review_job_id IS NOT NULL) AND (interaction_id IS NOT NULL) AND (work_id = review_job_id)))),
    CONSTRAINT run_native_correlations_connection_generation_check CHECK ((connection_generation >= 0)),
    CONSTRAINT run_native_correlations_correlation_key_check CHECK ((octet_length(correlation_key) <= 200)),
    CONSTRAINT run_native_correlations_first_native_sequence_check CHECK ((first_native_sequence >= 0)),
    CONSTRAINT run_native_correlations_metadata_revision_check CHECK ((metadata_revision >= 0)),
    CONSTRAINT run_native_correlations_provider_check CHECK ((provider = ANY (ARRAY['codex'::text, 'opencode'::text, 'claude'::text]))),
    CONSTRAINT run_native_correlations_work_kind_check CHECK ((work_kind = ANY (ARRAY['workflow'::text, 'review'::text])))
);


--
-- Name: run_native_projection_checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_native_projection_checkpoints (
    run_id text NOT NULL,
    execution_id text NOT NULL,
    workflow_node_id text NOT NULL,
    attempt integer NOT NULL,
    work_kind text NOT NULL,
    work_id text NOT NULL,
    revision bigint NOT NULL,
    checkpoint jsonb NOT NULL,
    CONSTRAINT run_native_projection_checkpoints_check CHECK (((work_kind <> 'workflow'::text) OR (work_id = execution_id))),
    CONSTRAINT run_native_projection_checkpoints_checkpoint_check CHECK (((jsonb_typeof(checkpoint) = 'object'::text) AND (octet_length((checkpoint)::text) <= 131072))),
    CONSTRAINT run_native_projection_checkpoints_revision_check CHECK ((revision >= 0)),
    CONSTRAINT run_native_projection_checkpoints_work_kind_check CHECK ((work_kind = ANY (ARRAY['workflow'::text, 'review'::text])))
);


--
-- Name: run_node_placements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_node_placements (
    run_id text NOT NULL,
    node_id text NOT NULL,
    binding_hash text NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT run_node_placements_binding_hash_check CHECK ((binding_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT run_node_placements_check CHECK ((((record ->> 'schemaVersion'::text) = '1'::text) AND ((record ->> 'runId'::text) = run_id) AND ((record ->> 'nodeId'::text) = node_id) AND ((record ->> 'bindingHash'::text) = binding_hash))),
    CONSTRAINT run_node_placements_record_check CHECK ((jsonb_typeof(record) = 'object'::text)),
    CONSTRAINT run_node_placements_record_check1 CHECK ((record ?& ARRAY['schemaVersion'::text, 'runId'::text, 'nodeId'::text, 'bindingHash'::text]))
);


--
-- Name: run_node_resolutions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_node_resolutions (
    run_id text NOT NULL,
    workflow_node_id text NOT NULL,
    resolution text NOT NULL,
    execution_id text,
    attempt integer,
    record jsonb NOT NULL,
    CONSTRAINT run_node_resolutions_check CHECK ((((resolution = ANY (ARRAY['skipped'::text, 'excluded'::text])) AND (execution_id IS NULL) AND (attempt IS NULL)) OR ((resolution <> ALL (ARRAY['skipped'::text, 'excluded'::text])) AND (execution_id IS NOT NULL) AND (attempt = 1)))),
    CONSTRAINT run_node_resolutions_check1 CHECK ((((record ->> 'workflowNodeId'::text) = workflow_node_id) AND ((record ->> 'resolution'::text) = resolution))),
    CONSTRAINT run_node_resolutions_resolution_check CHECK ((resolution = ANY (ARRAY['succeeded'::text, 'failed'::text, 'canceled'::text, 'skipped'::text, 'excluded'::text])))
);


--
-- Name: run_reference_file_pins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_reference_file_pins (
    run_id text NOT NULL,
    file_id text NOT NULL,
    revision_id text NOT NULL
);


--
-- Name: run_reference_file_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_reference_file_reads (
    run_id text NOT NULL,
    execution_id text NOT NULL,
    file_id text NOT NULL,
    revision_id text NOT NULL,
    read_at timestamp with time zone NOT NULL
);


--
-- Name: run_repeat_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_repeat_bindings (
    binding_id text NOT NULL,
    run_id text NOT NULL,
    recipient_execution_id text NOT NULL,
    source_execution_id text NOT NULL,
    source_result_digest text NOT NULL,
    input_digest text NOT NULL,
    slot_id text NOT NULL,
    ordinal integer NOT NULL,
    record jsonb NOT NULL,
    bound_at timestamp with time zone DEFAULT transaction_timestamp(),
    CONSTRAINT run_repeat_bindings_check CHECK ((recipient_execution_id <> source_execution_id)),
    CONSTRAINT run_repeat_bindings_check1 CHECK ((NOT ((record ->> 'bindingId'::text) IS DISTINCT FROM binding_id))),
    CONSTRAINT run_repeat_bindings_check2 CHECK ((NOT ((record ->> 'inputDigest'::text) IS DISTINCT FROM input_digest))),
    CONSTRAINT run_repeat_bindings_check3 CHECK ((NOT (((record ->> 'ordinal'::text))::integer IS DISTINCT FROM ordinal))),
    CONSTRAINT run_repeat_bindings_check4 CHECK ((NOT ((record #>> '{recipient,executionId}'::text[]) IS DISTINCT FROM recipient_execution_id))),
    CONSTRAINT run_repeat_bindings_check5 CHECK ((NOT ((record #>> '{source,execution,executionId}'::text[]) IS DISTINCT FROM source_execution_id))),
    CONSTRAINT run_repeat_bindings_check6 CHECK ((NOT ((record #>> '{source,acceptedResultDigest}'::text[]) IS DISTINCT FROM source_result_digest))),
    CONSTRAINT run_repeat_bindings_ordinal_check CHECK (((ordinal >= 0) AND (ordinal < 16001)))
);


--
-- Name: run_repeat_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_repeat_decisions (
    decision_id text NOT NULL,
    occurrence_id text NOT NULL,
    run_id text GENERATED ALWAYS AS ((record #>> '{occurrence,identity,scope,runId}'::text[])) STORED NOT NULL,
    exit_execution_id text NOT NULL,
    result_digest text NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT run_repeat_decisions_check CHECK ((NOT ((record ->> 'decisionId'::text) IS DISTINCT FROM decision_id))),
    CONSTRAINT run_repeat_decisions_check1 CHECK ((NOT ((record #>> '{occurrence,identity,occurrenceId}'::text[]) IS DISTINCT FROM occurrence_id))),
    CONSTRAINT run_repeat_decisions_check2 CHECK ((NOT ((record #>> '{exitExecution,occurrence,occurrenceId}'::text[]) IS DISTINCT FROM occurrence_id))),
    CONSTRAINT run_repeat_decisions_check3 CHECK ((NOT ((record ->> 'acceptedResultDigest'::text) IS DISTINCT FROM result_digest))),
    CONSTRAINT run_repeat_decisions_check4 CHECK ((NOT ((record #>> '{exitExecution,executionId}'::text[]) IS DISTINCT FROM exit_execution_id)))
);


--
-- Name: run_repeat_effects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_repeat_effects (
    run_id text NOT NULL,
    effect_kind text NOT NULL,
    entity_id text NOT NULL,
    payload_digest text NOT NULL,
    owner_id text NOT NULL,
    owner_fence text NOT NULL,
    CONSTRAINT run_repeat_effects_effect_kind_check CHECK ((effect_kind = ANY (ARRAY['occurrence.create'::text, 'input.bind'::text, 'terminal.accept'::text, 'node.inactive'::text, 'run.complete'::text]))),
    CONSTRAINT run_repeat_effects_payload_digest_check CHECK ((payload_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: run_repeat_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_repeat_executions (
    execution_id text NOT NULL,
    run_id text NOT NULL,
    slot_id text NOT NULL,
    occurrence_id text,
    technical_attempt integer NOT NULL,
    previous_execution_id text,
    previous_technical_attempt integer GENERATED ALWAYS AS (
CASE
    WHEN (technical_attempt > 1) THEN (technical_attempt - 1)
    ELSE NULL::integer
END) STORED,
    identity jsonb NOT NULL,
    occurrence_key text GENERATED ALWAYS AS (COALESCE(occurrence_id, ''::text)) STORED,
    workflow_node_id text GENERATED ALWAYS AS ((identity ->> 'workflowNodeId'::text)) STORED NOT NULL,
    work_activation_id text,
    executor_kind text GENERATED ALWAYS AS (COALESCE((identity ->> 'kind'::text), 'agent'::text)) STORED,
    harness_execution_id text GENERATED ALWAYS AS (
CASE
    WHEN (COALESCE((identity ->> 'kind'::text), 'agent'::text) = 'agent'::text) THEN execution_id
    ELSE NULL::text
END) STORED,
    job_execution_id text GENERATED ALWAYS AS (
CASE
    WHEN ((identity ->> 'kind'::text) = 'job'::text) THEN execution_id
    ELSE NULL::text
END) STORED,
    CONSTRAINT run_repeat_executions_check CHECK (((technical_attempt = 1) = (previous_execution_id IS NULL))),
    CONSTRAINT run_repeat_executions_check1 CHECK ((NOT ((identity ->> 'executionId'::text) IS DISTINCT FROM execution_id))),
    CONSTRAINT run_repeat_executions_check2 CHECK ((NOT (((identity ->> 'attempt'::text))::integer IS DISTINCT FROM technical_attempt))),
    CONSTRAINT run_repeat_executions_technical_attempt_check CHECK ((technical_attempt > 0)),
    CONSTRAINT work_attempt_not_repeat CHECK (((work_activation_id IS NULL) OR (occurrence_id IS NULL))),
    CONSTRAINT workflow_executor_kind CHECK ((executor_kind = ANY (ARRAY['agent'::text, 'job'::text])))
);


--
-- Name: run_repeat_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_repeat_occurrences (
    occurrence_id text NOT NULL,
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    workflow_version_id text NOT NULL,
    block_id text NOT NULL,
    occurrence_index integer NOT NULL,
    binding_id text NOT NULL,
    input_json text NOT NULL,
    input_digest text NOT NULL,
    previous_occurrence_id text,
    previous_occurrence_index integer,
    previous_decision_id text,
    previous_result_digest text,
    record jsonb NOT NULL,
    CONSTRAINT run_repeat_occurrences_check CHECK ((input_digest = ('sha256:'::text || encode(sha256(convert_to(input_json, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT run_repeat_occurrences_check1 CHECK ((((occurrence_index = 1) AND (previous_occurrence_id IS NULL) AND (previous_occurrence_index IS NULL) AND (previous_decision_id IS NULL) AND (previous_result_digest IS NULL)) OR ((occurrence_index > 1) AND (previous_occurrence_id IS NOT NULL) AND (previous_occurrence_index IS NOT NULL) AND (previous_occurrence_index = (occurrence_index - 1)) AND (previous_decision_id IS NOT NULL) AND (previous_result_digest IS NOT NULL)))),
    CONSTRAINT run_repeat_occurrences_check10 CHECK ((NOT ((record #>> '{input,previous,occurrenceId}'::text[]) IS DISTINCT FROM previous_occurrence_id))),
    CONSTRAINT run_repeat_occurrences_check11 CHECK ((NOT ((record #> '{input,previous,occurrenceIndex}'::text[]) IS DISTINCT FROM to_jsonb(previous_occurrence_index)))),
    CONSTRAINT run_repeat_occurrences_check12 CHECK ((NOT ((record #>> '{input,previous,decisionId}'::text[]) IS DISTINCT FROM previous_decision_id))),
    CONSTRAINT run_repeat_occurrences_check13 CHECK ((NOT ((record #>> '{input,previous,acceptedResultDigest}'::text[]) IS DISTINCT FROM previous_result_digest))),
    CONSTRAINT run_repeat_occurrences_check14 CHECK ((NOT ((record #>> '{input,inputDigest}'::text[]) IS DISTINCT FROM input_digest))),
    CONSTRAINT run_repeat_occurrences_check15 CHECK ((NOT ((record #>> '{input,bindingId}'::text[]) IS DISTINCT FROM binding_id))),
    CONSTRAINT run_repeat_occurrences_check2 CHECK (((((occurrence_index = 1) AND ((record #> '{input,previous}'::text[]) = 'null'::jsonb) AND (((input_json)::jsonb -> 'carry'::text) = 'null'::jsonb)) OR ((occurrence_index > 1) AND (jsonb_typeof((record #> '{input,previous}'::text[])) = 'object'::text))) IS TRUE)),
    CONSTRAINT run_repeat_occurrences_check3 CHECK ((NOT ((record #>> '{identity,occurrenceId}'::text[]) IS DISTINCT FROM occurrence_id))),
    CONSTRAINT run_repeat_occurrences_check4 CHECK ((NOT ((record #>> '{identity,scope,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT run_repeat_occurrences_check5 CHECK ((NOT ((record #>> '{identity,scope,workflowVersionId}'::text[]) IS DISTINCT FROM workflow_version_id))),
    CONSTRAINT run_repeat_occurrences_check6 CHECK ((NOT ((record #>> '{identity,scope,workspaceId}'::text[]) IS DISTINCT FROM workspace_id))),
    CONSTRAINT run_repeat_occurrences_check7 CHECK ((NOT ((record #>> '{identity,scope,workflowId}'::text[]) IS DISTINCT FROM workflow_id))),
    CONSTRAINT run_repeat_occurrences_check8 CHECK ((NOT ((record #>> '{identity,blockId}'::text[]) IS DISTINCT FROM block_id))),
    CONSTRAINT run_repeat_occurrences_check9 CHECK ((NOT ((record #> '{identity,occurrenceIndex}'::text[]) IS DISTINCT FROM to_jsonb(occurrence_index)))),
    CONSTRAINT run_repeat_occurrences_input_json_check CHECK ((octet_length(input_json) <= 4194304)),
    CONSTRAINT run_repeat_occurrences_input_json_check1 CHECK ((((jsonb_typeof((input_json)::jsonb) = 'object'::text) AND ((input_json)::jsonb ? 'runInput'::text) AND (jsonb_typeof(((input_json)::jsonb -> 'external'::text)) = 'array'::text) AND ((input_json)::jsonb ? 'carry'::text)) IS TRUE)),
    CONSTRAINT run_repeat_occurrences_occurrence_id_check CHECK ((occurrence_id <> ''::text)),
    CONSTRAINT run_repeat_occurrences_occurrence_index_check CHECK ((occurrence_index > 0)),
    CONSTRAINT run_repeat_occurrences_record_check CHECK ((NOT ((record -> 'contractVersion'::text) IS DISTINCT FROM '1'::jsonb))),
    CONSTRAINT run_repeat_occurrences_record_check1 CHECK ((NOT ((record #> '{identity,scope,executionSemanticsVersion}'::text[]) IS DISTINCT FROM '3'::jsonb)))
);


--
-- Name: run_repeat_resolutions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_repeat_resolutions (
    run_id text NOT NULL,
    occurrence_key text NOT NULL,
    workflow_node_id text NOT NULL,
    source_occurrence_id text,
    execution_id text,
    record jsonb NOT NULL,
    CONSTRAINT run_repeat_resolutions_check CHECK ((((occurrence_key = ''::text) OR (occurrence_key = source_occurrence_id)) IS TRUE)),
    CONSTRAINT run_repeat_resolutions_check1 CHECK ((NOT ((record #>> '{value,workflowNodeId}'::text[]) IS DISTINCT FROM workflow_node_id))),
    CONSTRAINT run_repeat_resolutions_check2 CHECK ((NOT ((record #>> '{ref,nodeId}'::text[]) IS DISTINCT FROM workflow_node_id))),
    CONSTRAINT run_repeat_resolutions_check3 CHECK ((NOT ((record #>> '{ref,occurrence,occurrenceId}'::text[]) IS DISTINCT FROM source_occurrence_id))),
    CONSTRAINT run_repeat_resolutions_check4 CHECK ((NOT ((record #>> '{value,execution,executionId}'::text[]) IS DISTINCT FROM execution_id)))
);


--
-- Name: run_repeat_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_repeat_results (
    execution_id text NOT NULL,
    run_id text NOT NULL,
    occurrence_id text,
    occurrence_key text GENERATED ALWAYS AS (COALESCE(occurrence_id, ''::text)) STORED,
    result_json text NOT NULL,
    result_digest text NOT NULL,
    accepted_at timestamp with time zone NOT NULL,
    CONSTRAINT run_repeat_results_check CHECK ((result_digest = ('sha256:'::text || encode(sha256(convert_to(result_json, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT run_repeat_results_result_json_check CHECK ((octet_length(result_json) <= 65536)),
    CONSTRAINT run_repeat_results_result_json_check1 CHECK ((NOT (((result_json)::jsonb ->> 'outcome'::text) IS DISTINCT FROM 'succeeded'::text)))
);


--
-- Name: run_repeat_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_repeat_slots (
    slot_id text NOT NULL,
    run_id text NOT NULL,
    occurrence_id text,
    workflow_node_id text NOT NULL,
    input_json text NOT NULL,
    input_digest text NOT NULL,
    occurrence_key text GENERATED ALWAYS AS (COALESCE(occurrence_id, ''::text)) STORED,
    work_activation_id text,
    tick_index integer,
    CONSTRAINT run_repeat_slots_check CHECK ((input_digest = ('sha256:'::text || encode(sha256(convert_to(input_json, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT run_repeat_slots_input_json_check CHECK ((octet_length(input_json) <= 4194304)),
    CONSTRAINT work_slot_not_repeat CHECK (((work_activation_id IS NULL) OR (occurrence_id IS NULL)))
);


--
-- Name: run_subagent_backfill_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_subagent_backfill_state (
    execution_id text NOT NULL,
    child_cursor text,
    complete boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_failure text
);


--
-- Name: run_subagent_command_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_subagent_command_receipts (
    id text NOT NULL,
    principal_id text NOT NULL,
    operation text NOT NULL,
    command_id text NOT NULL,
    subagent_id text NOT NULL,
    input_hash text NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT run_subagent_command_receipts_check CHECK ((((record ->> 'id'::text) = id) AND ((record ->> 'principalId'::text) = principal_id) AND ((record ->> 'commandId'::text) = command_id) AND ((record ->> 'operation'::text) = operation)))
);


--
-- Name: run_subagent_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_subagent_items (
    subagent_id text NOT NULL,
    kind text NOT NULL,
    id text NOT NULL,
    ordinal bigint NOT NULL,
    revision bigint NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT run_subagent_items_check CHECK ((((record ->> 'subagentId'::text) = subagent_id) AND ((record ->> 'id'::text) = id) AND ((record ->> 'revision'::text) = (revision)::text))),
    CONSTRAINT run_subagent_items_kind_check CHECK ((kind = ANY (ARRAY['message'::text, 'tool'::text]))),
    CONSTRAINT run_subagent_items_revision_check CHECK ((revision > 0))
);


--
-- Name: run_subagent_items_ordinal_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.run_subagent_items ALTER COLUMN ordinal ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.run_subagent_items_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: run_subagent_lifecycle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_subagent_lifecycle (
    subagent_id text NOT NULL,
    execution_id text NOT NULL,
    sequence integer NOT NULL,
    fact jsonb NOT NULL
);


--
-- Name: run_subagent_message_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_subagent_message_roles (
    execution_id text NOT NULL,
    native_session_id text NOT NULL,
    native_message_id text NOT NULL,
    role text NOT NULL,
    CONSTRAINT run_subagent_message_roles_role_check CHECK ((role = ANY (ARRAY['assistant'::text, 'user'::text])))
);


--
-- Name: run_subagent_pending_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_subagent_pending_events (
    execution_id text NOT NULL,
    sequence integer NOT NULL
);


--
-- Name: run_subagent_projection_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_subagent_projection_queue (
    execution_id text NOT NULL,
    projected_sequence integer DEFAULT '-1'::integer NOT NULL,
    latest_sequence integer NOT NULL
);


--
-- Name: run_subagent_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_subagent_sources (
    subagent_id text NOT NULL,
    execution_id text NOT NULL,
    sequence integer NOT NULL,
    digest text NOT NULL
);


--
-- Name: run_subagents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_subagents (
    id text NOT NULL,
    run_id text NOT NULL,
    parent_execution_id text NOT NULL,
    native_mode text NOT NULL,
    parent_native_session_id text NOT NULL,
    provider_child_id text NOT NULL,
    parent_subagent_id text,
    lifecycle_at timestamp with time zone,
    revision bigint NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT run_subagents_check CHECK ((((record ->> 'id'::text) = id) AND ((record ->> 'runId'::text) = run_id) AND ((record ->> 'parentExecutionId'::text) = parent_execution_id) AND ((record ->> 'revision'::text) = (revision)::text) AND ((record ->> 'nativeMode'::text) = native_mode))),
    CONSTRAINT run_subagents_revision_check CHECK ((revision > 0))
);


--
-- Name: run_work_activations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_activations (
    activation_id text NOT NULL,
    activation_sequence bigint NOT NULL,
    run_id text NOT NULL,
    workflow_version_id text NOT NULL,
    workflow_node_id text NOT NULL,
    lineage_id text GENERATED ALWAYS AS ((record ->> 'lineageId'::text)) STORED NOT NULL,
    cause_kind text NOT NULL,
    cause_id text NOT NULL,
    state text NOT NULL,
    input_digest text,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT run_work_activations_cause_kind_check CHECK ((cause_kind = ANY (ARRAY['entry'::text, 'dependency'::text, 'join'::text, 'work_request'::text, 'work_return'::text, 'limit_denial'::text]))),
    CONSTRAINT run_work_activations_check CHECK ((NOT ((record ->> 'activationId'::text) IS DISTINCT FROM activation_id))),
    CONSTRAINT run_work_activations_check1 CHECK ((NOT ((record #>> '{scope,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT run_work_activations_check2 CHECK ((NOT ((record #>> '{scope,workflowVersionId}'::text[]) IS DISTINCT FROM workflow_version_id))),
    CONSTRAINT run_work_activations_check3 CHECK ((NOT ((record ->> 'workflowNodeId'::text) IS DISTINCT FROM workflow_node_id))),
    CONSTRAINT run_work_activations_check4 CHECK ((NOT ((record #>> '{cause,kind}'::text[]) IS DISTINCT FROM cause_kind))),
    CONSTRAINT run_work_activations_check5 CHECK (
CASE cause_kind
    WHEN 'entry'::text THEN (cause_id = run_id)
    WHEN 'dependency'::text THEN (cause_id = (record #>> '{cause,resolutionId}'::text[]))
    WHEN 'join'::text THEN (cause_id = (record #>> '{cause,joinId}'::text[]))
    WHEN 'work_request'::text THEN (cause_id = (record #>> '{cause,requestId}'::text[]))
    WHEN 'work_return'::text THEN (cause_id = (record #>> '{cause,returnId}'::text[]))
    ELSE (cause_id = (record #>> '{cause,denialId}'::text[]))
END),
    CONSTRAINT run_work_activations_input_digest_check CHECK ((input_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT run_work_activations_lineage_id_check CHECK ((lineage_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'::text)),
    CONSTRAINT run_work_activations_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'waiting'::text, 'completed'::text, 'needs_direction'::text, 'unknown'::text])))
);


--
-- Name: run_work_activations_activation_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.run_work_activations ALTER COLUMN activation_sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.run_work_activations_activation_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: run_work_connection_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_connection_usage (
    run_id text NOT NULL,
    workflow_version_id text NOT NULL,
    relationship_id text NOT NULL,
    used integer DEFAULT 0 NOT NULL,
    maximum integer,
    CONSTRAINT run_work_connection_usage_check CHECK (((maximum IS NULL) OR (used <= maximum))),
    CONSTRAINT run_work_connection_usage_maximum_check CHECK (((maximum >= 1) AND (maximum <= 2147483647))),
    CONSTRAINT run_work_connection_usage_used_check CHECK ((used >= 0))
);


--
-- Name: run_work_denials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_denials (
    denial_id text NOT NULL,
    run_id text NOT NULL,
    request_id text NOT NULL,
    workflow_version_id text NOT NULL,
    relationship_id text NOT NULL,
    requester_activation_id text NOT NULL,
    requester_execution_id text NOT NULL,
    payload_digest text NOT NULL,
    record jsonb NOT NULL,
    denied_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT run_work_denials_check CHECK ((NOT ((record ->> 'denialId'::text) IS DISTINCT FROM denial_id))),
    CONSTRAINT run_work_denials_check1 CHECK ((NOT ((record #>> '{scope,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT run_work_denials_check2 CHECK ((NOT ((record ->> 'requestId'::text) IS DISTINCT FROM request_id))),
    CONSTRAINT run_work_denials_check3 CHECK ((NOT ((record ->> 'relationshipId'::text) IS DISTINCT FROM relationship_id))),
    CONSTRAINT run_work_denials_check4 CHECK ((NOT ((record ->> 'requesterExecutionId'::text) IS DISTINCT FROM requester_execution_id))),
    CONSTRAINT run_work_denials_check5 CHECK ((NOT ((record ->> 'payloadDigest'::text) IS DISTINCT FROM payload_digest))),
    CONSTRAINT run_work_denials_payload_digest_check CHECK ((payload_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: run_work_direction_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_direction_responses (
    interaction_id text NOT NULL,
    principal_id text NOT NULL,
    source text NOT NULL,
    start_input jsonb,
    continuation_run_id text,
    CONSTRAINT run_work_direction_responses_source_check CHECK ((source = ANY (ARRAY['http'::text, 'mcp'::text]))),
    CONSTRAINT run_work_direction_responses_start_input_check CHECK (((start_input IS NULL) OR (jsonb_typeof(start_input) = 'object'::text)))
);


--
-- Name: run_work_direction_waits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_direction_waits (
    run_id text NOT NULL,
    workflow_version_id text NOT NULL,
    unresolved_ids jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT run_work_direction_waits_unresolved_ids_check CHECK (((jsonb_typeof(unresolved_ids) = 'array'::text) AND (jsonb_array_length(unresolved_ids) > 0) AND (jsonb_array_length(unresolved_ids) <= 1000)))
);


--
-- Name: run_work_join_dispatches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_join_dispatches (
    run_id text NOT NULL,
    activation_id text NOT NULL,
    source_activation_id text NOT NULL
);


--
-- Name: run_work_notices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_notices (
    notice_id text NOT NULL,
    run_id text NOT NULL,
    workflow_version_id text NOT NULL,
    requester_activation_id text NOT NULL,
    continuation_activation_id text NOT NULL,
    cause_kind text NOT NULL,
    cause_id text NOT NULL,
    relationship_id text NOT NULL,
    destination_node_id text NOT NULL,
    used integer NOT NULL,
    maximum integer NOT NULL,
    delivery_state text NOT NULL,
    acknowledgement_execution_id text,
    revision integer DEFAULT 0 NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT run_work_notices_cause_kind_check CHECK ((cause_kind = ANY (ARRAY['last_return'::text, 'limit_denial'::text]))),
    CONSTRAINT run_work_notices_check CHECK (((maximum > 0) AND (used = maximum))),
    CONSTRAINT run_work_notices_check1 CHECK (((delivery_state = 'delivered'::text) = (acknowledgement_execution_id IS NOT NULL))),
    CONSTRAINT run_work_notices_check10 CHECK ((NOT ((record ->> 'destinationNodeId'::text) IS DISTINCT FROM destination_node_id))),
    CONSTRAINT run_work_notices_check11 CHECK ((NOT ((record -> 'used'::text) IS DISTINCT FROM to_jsonb(used)))),
    CONSTRAINT run_work_notices_check12 CHECK ((NOT ((record -> 'maxWorkHandoffsPerRun'::text) IS DISTINCT FROM to_jsonb(maximum)))),
    CONSTRAINT run_work_notices_check13 CHECK ((NOT ((record ->> 'delivery'::text) IS DISTINCT FROM delivery_state))),
    CONSTRAINT run_work_notices_check14 CHECK ((NOT ((record ->> 'acknowledgementId'::text) IS DISTINCT FROM acknowledgement_execution_id))),
    CONSTRAINT run_work_notices_check15 CHECK ((NOT ((record ->> 'createdAt'::text) IS DISTINCT FROM to_char((created_at AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text)))),
    CONSTRAINT run_work_notices_check16 CHECK ((NOT ((record ->> 'updatedAt'::text) IS DISTINCT FROM to_char((updated_at AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text)))),
    CONSTRAINT run_work_notices_check2 CHECK ((NOT ((record ->> 'noticeId'::text) IS DISTINCT FROM notice_id))),
    CONSTRAINT run_work_notices_check3 CHECK ((NOT ((record #>> '{scope,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT run_work_notices_check4 CHECK ((NOT ((record #>> '{scope,workflowVersionId}'::text[]) IS DISTINCT FROM workflow_version_id))),
    CONSTRAINT run_work_notices_check5 CHECK ((NOT ((record ->> 'requesterActivationId'::text) IS DISTINCT FROM requester_activation_id))),
    CONSTRAINT run_work_notices_check6 CHECK ((NOT ((record ->> 'continuationActivationId'::text) IS DISTINCT FROM continuation_activation_id))),
    CONSTRAINT run_work_notices_check7 CHECK ((NOT ((record #>> '{cause,kind}'::text[]) IS DISTINCT FROM cause_kind))),
    CONSTRAINT run_work_notices_check8 CHECK ((NOT (
CASE cause_kind
    WHEN 'last_return'::text THEN (record #>> '{cause,returnId}'::text[])
    ELSE (record #>> '{cause,denialId}'::text[])
END IS DISTINCT FROM cause_id))),
    CONSTRAINT run_work_notices_check9 CHECK ((NOT ((record ->> 'relationshipId'::text) IS DISTINCT FROM relationship_id))),
    CONSTRAINT run_work_notices_delivery_state_check CHECK ((delivery_state = ANY (ARRAY['queued'::text, 'pending'::text, 'delivered'::text, 'unknown'::text, 'failed'::text]))),
    CONSTRAINT run_work_notices_revision_check CHECK ((revision >= 0)),
    CONSTRAINT run_work_notices_used_check CHECK ((used > 0)),
    CONSTRAINT work_notice_size_check CHECK ((public.work_json_bytes(record) <= 65536))
);


--
-- Name: run_work_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_requests (
    request_id text NOT NULL,
    run_id text NOT NULL,
    workflow_version_id text NOT NULL,
    relationship_id text NOT NULL,
    ordinal integer NOT NULL,
    requester_activation_id text NOT NULL,
    requester_execution_id text NOT NULL,
    destination_activation_id text NOT NULL,
    requester_node_id text NOT NULL,
    destination_node_id text NOT NULL,
    payload_digest text NOT NULL,
    record jsonb NOT NULL,
    accepted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT run_work_requests_check CHECK ((requester_node_id <> destination_node_id)),
    CONSTRAINT run_work_requests_check1 CHECK ((NOT ((record ->> 'requestId'::text) IS DISTINCT FROM request_id))),
    CONSTRAINT run_work_requests_check10 CHECK ((NOT ((record ->> 'payloadDigest'::text) IS DISTINCT FROM payload_digest))),
    CONSTRAINT run_work_requests_check11 CHECK ((NOT ((record -> 'ordinal'::text) IS DISTINCT FROM to_jsonb(ordinal)))),
    CONSTRAINT run_work_requests_check2 CHECK ((NOT ((record #>> '{scope,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT run_work_requests_check3 CHECK ((NOT ((record #>> '{scope,workflowVersionId}'::text[]) IS DISTINCT FROM workflow_version_id))),
    CONSTRAINT run_work_requests_check4 CHECK ((NOT ((record ->> 'relationshipId'::text) IS DISTINCT FROM relationship_id))),
    CONSTRAINT run_work_requests_check5 CHECK ((NOT ((record ->> 'requesterActivationId'::text) IS DISTINCT FROM requester_activation_id))),
    CONSTRAINT run_work_requests_check6 CHECK ((NOT ((record ->> 'requesterExecutionId'::text) IS DISTINCT FROM requester_execution_id))),
    CONSTRAINT run_work_requests_check7 CHECK ((NOT ((record ->> 'destinationActivationId'::text) IS DISTINCT FROM destination_activation_id))),
    CONSTRAINT run_work_requests_check8 CHECK ((NOT ((record ->> 'requesterNodeId'::text) IS DISTINCT FROM requester_node_id))),
    CONSTRAINT run_work_requests_check9 CHECK ((NOT ((record ->> 'destinationNodeId'::text) IS DISTINCT FROM destination_node_id))),
    CONSTRAINT run_work_requests_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT run_work_requests_payload_digest_check CHECK ((payload_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: run_work_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_results (
    execution_id text NOT NULL,
    run_id text NOT NULL,
    activation_id text NOT NULL,
    result_json text NOT NULL,
    result_digest text NOT NULL,
    accepted_at timestamp with time zone NOT NULL,
    CONSTRAINT run_work_results_check CHECK ((result_digest = ('sha256:'::text || encode(sha256(convert_to(result_json, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT run_work_results_result_json_check CHECK ((octet_length(result_json) <= 65536))
);


--
-- Name: run_work_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_returns (
    return_id text NOT NULL,
    run_id text NOT NULL,
    request_id text NOT NULL,
    source_activation_id text NOT NULL,
    source_execution_id text NOT NULL,
    requester_continuation_activation_id text,
    result_digest text NOT NULL,
    outcome text NOT NULL,
    record jsonb NOT NULL,
    returned_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT run_work_returns_check CHECK ((NOT ((record ->> 'returnId'::text) IS DISTINCT FROM return_id))),
    CONSTRAINT run_work_returns_check1 CHECK ((NOT ((record #>> '{scope,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT run_work_returns_check2 CHECK ((NOT ((record ->> 'requestId'::text) IS DISTINCT FROM request_id))),
    CONSTRAINT run_work_returns_check3 CHECK ((NOT ((record ->> 'sourceActivationId'::text) IS DISTINCT FROM source_activation_id))),
    CONSTRAINT run_work_returns_check4 CHECK ((NOT ((record ->> 'sourceExecutionId'::text) IS DISTINCT FROM source_execution_id))),
    CONSTRAINT run_work_returns_check5 CHECK ((NOT ((record ->> 'continuationActivationId'::text) IS DISTINCT FROM requester_continuation_activation_id))),
    CONSTRAINT run_work_returns_check6 CHECK ((NOT ((record ->> 'acceptedResultDigest'::text) IS DISTINCT FROM result_digest))),
    CONSTRAINT run_work_returns_check7 CHECK ((NOT ((record ->> 'outcome'::text) IS DISTINCT FROM outcome))),
    CONSTRAINT run_work_returns_check8 CHECK (((outcome = 'needs_changes'::text) = (requester_continuation_activation_id IS NOT NULL))),
    CONSTRAINT run_work_returns_outcome_check CHECK ((outcome = ANY (ARRAY['accepted'::text, 'needs_changes'::text]))),
    CONSTRAINT run_work_returns_result_digest_check CHECK ((result_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: run_work_unresolved; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_work_unresolved (
    unresolved_id text NOT NULL,
    run_id text NOT NULL,
    activation_id text NOT NULL,
    execution_id text NOT NULL,
    result_digest text NOT NULL,
    reason text NOT NULL,
    relationship_id text,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT run_work_unresolved_check CHECK (((reason = 'repeated_exhausted_route'::text) = (relationship_id IS NOT NULL))),
    CONSTRAINT run_work_unresolved_reason_check CHECK ((reason = ANY (ARRAY['finish_with_findings'::text, 'repeated_exhausted_route'::text]))),
    CONSTRAINT run_work_unresolved_result_digest_check CHECK ((result_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: run_worktrees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_worktrees (
    run_id text NOT NULL,
    repository_root text NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    workflow_version_id text NOT NULL,
    execution_state text NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    runner_id text,
    working_directory text,
    location_revision bigint,
    worker_credentials_closed_at timestamp with time zone,
    stop_cause jsonb,
    stop_requested_at timestamp with time zone,
    activity_record_revision bigint DEFAULT 0 NOT NULL
);


--
-- Name: source_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_approvals (
    approved_source_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    workspace_id text NOT NULL,
    owner_principal_id text NOT NULL,
    requested_by text NOT NULL,
    command_id text NOT NULL,
    input_hash text NOT NULL,
    state text NOT NULL,
    origin jsonb NOT NULL,
    request jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_approvals_state_check CHECK ((state = ANY (ARRAY['capturing'::text, 'approved'::text, 'failed'::text])))
);


--
-- Name: source_execution_materializations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_execution_materializations (
    materialization_id uuid NOT NULL,
    workspace_id text NOT NULL,
    execution_id text NOT NULL,
    attempt_id text NOT NULL,
    operation_id text NOT NULL,
    root_id uuid NOT NULL,
    binding_revision bigint NOT NULL,
    reservation_id uuid NOT NULL,
    record jsonb NOT NULL,
    state text NOT NULL,
    cleanup_lease_expires_at timestamp with time zone,
    worktree_cleanup jsonb,
    cleanup_deadline_exceeded_at timestamp with time zone,
    CONSTRAINT source_execution_materializations_state_check CHECK ((state = ANY (ARRAY['prepared'::text, 'running'::text, 'uncertain'::text, 'closed'::text])))
);


--
-- Name: source_preparation_reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_preparation_reconciliations (
    operation_id text NOT NULL,
    reconciliation_id uuid NOT NULL,
    workspace_id text NOT NULL,
    principal_id text NOT NULL,
    command_id text NOT NULL,
    status text NOT NULL,
    owner jsonb NOT NULL,
    closure jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    queue_ticket_id uuid,
    CONSTRAINT source_preparation_reconciliations_check CHECK (((status = 'closed'::text) = (closure IS NOT NULL))),
    CONSTRAINT source_preparation_reconciliations_status_check CHECK ((status = ANY (ARRAY['reconciling'::text, 'closed'::text])))
);


--
-- Name: source_root_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_root_bindings (
    root_id uuid NOT NULL,
    binding_revision bigint NOT NULL,
    workspace_id text NOT NULL,
    snapshot_id uuid NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT source_root_bindings_binding_revision_check CHECK ((binding_revision > 0))
);


--
-- Name: source_root_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_root_catalog (
    root_id uuid NOT NULL,
    workspace_id text NOT NULL,
    scope_hash text NOT NULL,
    current_binding_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT source_root_catalog_current_binding_revision_check CHECK ((current_binding_revision >= 0))
);


--
-- Name: source_snapshot_uses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_snapshot_uses (
    use_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    owner jsonb NOT NULL
);


--
-- Name: source_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_snapshots (
    snapshot_id uuid NOT NULL,
    approved_source_id uuid NOT NULL,
    workspace_id text NOT NULL,
    manifest_digest text NOT NULL,
    record jsonb NOT NULL,
    availability text DEFAULT 'retained'::text NOT NULL,
    CONSTRAINT source_snapshots_availability_check CHECK ((availability = ANY (ARRAY['retained'::text, 'unavailable'::text]))),
    CONSTRAINT source_snapshots_manifest_digest_check CHECK ((manifest_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: source_storage_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_storage_reservations (
    reservation_id uuid NOT NULL,
    scope_id text NOT NULL,
    owner_kind text NOT NULL,
    owner_id text NOT NULL,
    reserved_bytes bigint NOT NULL,
    state text NOT NULL,
    record jsonb NOT NULL,
    CONSTRAINT source_storage_reservations_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['capture'::text, 'transfer'::text, 'materialization'::text]))),
    CONSTRAINT source_storage_reservations_reserved_bytes_check CHECK ((reserved_bytes >= 0)),
    CONSTRAINT source_storage_reservations_state_check CHECK ((state = ANY (ARRAY['preparing'::text, 'retained'::text, 'owned'::text, 'uncertain'::text, 'reclaimed'::text])))
);


--
-- Name: worker_credential_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_credential_bindings (
    principal_id text NOT NULL,
    execution_id text NOT NULL,
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    agent_id text NOT NULL,
    environment_variable text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    purpose text DEFAULT 'workflow'::text NOT NULL,
    approval_native_session_id text,
    approval_review_job_id text,
    approval_review_lease_fence bigint,
    approval_connection_generation bigint,
    CONSTRAINT worker_credential_bindings_approval_connection_generation_check CHECK ((approval_connection_generation >= 0)),
    CONSTRAINT worker_credential_bindings_approval_review_lease_fence_check CHECK ((approval_review_lease_fence >= 0)),
    CONSTRAINT worker_credential_bindings_environment_variable_check CHECK ((environment_variable = 'GRAPHQL_MCP_TOKEN'::text)),
    CONSTRAINT worker_credential_bindings_purpose_check CHECK ((purpose = ANY (ARRAY['workflow'::text, 'reviewer'::text])))
);


--
-- Name: workflow_job_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_job_executions (
    run_id text NOT NULL,
    node_execution_id text NOT NULL,
    job_execution_id text NOT NULL,
    reference jsonb NOT NULL,
    input_json text NOT NULL,
    accepted boolean DEFAULT false NOT NULL,
    CONSTRAINT workflow_job_executions_input_json_check CHECK ((octet_length(input_json) <= 4194304))
);


--
-- Name: workflow_job_preparations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_job_preparations (
    slot_id text NOT NULL,
    run_id text NOT NULL,
    preparation jsonb NOT NULL,
    bindings jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: workflow_native_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_native_entries (
    execution_id text NOT NULL,
    run_id text NOT NULL,
    reservation jsonb NOT NULL,
    reservation_json text NOT NULL,
    reservation_digest text NOT NULL,
    phase text NOT NULL,
    transition jsonb,
    source_id text,
    source_digest text,
    CONSTRAINT workflow_native_entries_check CHECK ((reservation_digest = ('sha256:'::text || encode(sha256(convert_to(reservation_json, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT workflow_native_entries_check1 CHECK ((reservation = (reservation_json)::jsonb)),
    CONSTRAINT workflow_native_entries_check2 CHECK ((NOT ((reservation #>> '{execution,executionId}'::text[]) IS DISTINCT FROM execution_id))),
    CONSTRAINT workflow_native_entries_check3 CHECK ((NOT ((reservation #>> '{scope,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT workflow_native_entries_check4 CHECK ((((phase = 'reserved'::text) AND (transition IS NULL) AND (source_id IS NULL) AND (source_digest IS NULL)) OR ((phase <> 'reserved'::text) AND (jsonb_typeof(transition) = 'object'::text) AND (source_id IS NOT NULL) AND (source_digest IS NOT NULL) AND ((transition -> 'reservation'::text) = reservation) AND ((transition ->> 'phase'::text) = phase)))),
    CONSTRAINT workflow_native_entries_phase_check CHECK ((phase = ANY (ARRAY['reserved'::text, 'prepared'::text, 'entered'::text, 'not_submitted'::text]))),
    CONSTRAINT workflow_native_entries_reservation_check CHECK ((NOT ((reservation #> '{scope,executionSemanticsVersion}'::text[]) IS DISTINCT FROM '3'::jsonb))),
    CONSTRAINT workflow_native_entries_reservation_json_check CHECK ((octet_length(reservation_json) <= 4194304)),
    CONSTRAINT workflow_native_entries_source_digest_check CHECK ((source_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: workflow_native_proofs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_native_proofs (
    proof_id text NOT NULL,
    run_id text NOT NULL,
    execution_id text NOT NULL,
    identity_digest text NOT NULL,
    source_digest text NOT NULL,
    record jsonb NOT NULL,
    record_json text NOT NULL,
    CONSTRAINT workflow_native_proofs_check CHECK ((record = (record_json)::jsonb)),
    CONSTRAINT workflow_native_proofs_check1 CHECK ((source_digest = ('sha256:'::text || encode(sha256(convert_to(record_json, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT workflow_native_proofs_check2 CHECK ((NOT ((record ->> 'proofId'::text) IS DISTINCT FROM proof_id))),
    CONSTRAINT workflow_native_proofs_check3 CHECK ((NOT ((record #>> '{scope,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT workflow_native_proofs_check4 CHECK ((NOT ((record #>> '{execution,executionId}'::text[]) IS DISTINCT FROM execution_id))),
    CONSTRAINT workflow_native_proofs_identity_digest_check CHECK ((identity_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_native_proofs_record_check CHECK ((NOT ((record #> '{scope,executionSemanticsVersion}'::text[]) IS DISTINCT FROM '3'::jsonb))),
    CONSTRAINT workflow_native_proofs_record_check1 CHECK (((record #>> '{original,type}'::text[]) = ANY (ARRAY['session_created'::text, 'event'::text, 'history'::text]))),
    CONSTRAINT workflow_native_proofs_record_json_check CHECK ((octet_length(record_json) <= 12582912))
);


--
-- Name: workflow_schedule_authorities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_schedule_authorities (
    workflow_id text NOT NULL,
    workspace_id text NOT NULL,
    schedule_revision bigint NOT NULL,
    owner_principal_id text NOT NULL,
    actor_principal_id text NOT NULL,
    grant_ceiling jsonb NOT NULL,
    CONSTRAINT workflow_schedule_authorities_grant_ceiling_check CHECK ((jsonb_typeof(grant_ceiling) = 'array'::text)),
    CONSTRAINT workflow_schedule_authorities_schedule_revision_check CHECK (((schedule_revision >= 1) AND (schedule_revision <= '9007199254740991'::bigint)))
);


--
-- Name: workflow_schedule_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_schedule_occurrences (
    id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    schedule_revision bigint NOT NULL,
    status text NOT NULL,
    reason text,
    workflow_version_id text,
    run_id text,
    record jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_schedule_occurrences_check CHECK (((((status = 'accepted'::text) AND (reason IS NULL) AND (workflow_version_id IS NOT NULL) AND (run_id IS NOT NULL)) OR ((workflow_version_id IS NULL) AND (run_id IS NULL) AND (((status = 'skipped'::text) AND (reason = ANY (ARRAY['overlap'::text, 'disabled'::text]))) OR ((status = 'missed'::text) AND (reason = ANY (ARRAY['outside_grace'::text, 'superseded'::text]))) OR ((status = 'rejected'::text) AND ((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 200)))))) IS TRUE)),
    CONSTRAINT workflow_schedule_occurrences_check1 CHECK ((((jsonb_typeof(record) = 'object'::text) AND ((record ->> 'id'::text) = id) AND ((record ->> 'workspaceId'::text) = workspace_id) AND ((record ->> 'workflowId'::text) = workflow_id) AND (((record ->> 'dueAt'::text))::timestamp with time zone = due_at) AND (((record ->> 'scheduleRevision'::text))::bigint = schedule_revision) AND ((record ->> 'status'::text) = status) AND (NOT ((record ->> 'reason'::text) IS DISTINCT FROM reason)) AND (NOT ((record ->> 'workflowVersionId'::text) IS DISTINCT FROM workflow_version_id)) AND (NOT ((record ->> 'runId'::text) IS DISTINCT FROM run_id))) IS TRUE)),
    CONSTRAINT workflow_schedule_occurrences_due_at_check CHECK ((due_at = date_trunc('milliseconds'::text, due_at))),
    CONSTRAINT workflow_schedule_occurrences_schedule_revision_check CHECK (((schedule_revision >= 1) AND (schedule_revision <= '9007199254740991'::bigint))),
    CONSTRAINT workflow_schedule_occurrences_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'skipped'::text, 'missed'::text, 'rejected'::text])))
);


--
-- Name: workflow_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_schedules (
    workflow_id text NOT NULL,
    workspace_id text NOT NULL,
    revision bigint NOT NULL,
    record jsonb,
    enabled boolean NOT NULL,
    next_occurrence_at timestamp with time zone,
    cleared_at timestamp with time zone,
    updated_by_principal_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_schedules_check CHECK (((((record IS NULL) AND (cleared_at IS NOT NULL) AND (NOT enabled) AND (next_occurrence_at IS NULL)) OR ((record IS NOT NULL) AND (cleared_at IS NULL) AND (jsonb_typeof(record) = 'object'::text) AND ((record ->> 'workspaceId'::text) = workspace_id) AND ((record ->> 'workflowId'::text) = workflow_id) AND (((record ->> 'revision'::text))::bigint = revision) AND (((record ->> 'enabled'::text))::boolean = enabled) AND (NOT (((record ->> 'nextOccurrenceAt'::text))::timestamp with time zone IS DISTINCT FROM next_occurrence_at)))) IS TRUE)),
    CONSTRAINT workflow_schedules_check1 CHECK ((enabled OR (next_occurrence_at IS NULL))),
    CONSTRAINT workflow_schedules_next_occurrence_at_check CHECK ((next_occurrence_at = date_trunc('milliseconds'::text, next_occurrence_at))),
    CONSTRAINT workflow_schedules_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint)))
);


--
-- Name: workflow_stop_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_stop_intents (
    principal_id text NOT NULL,
    command_id text NOT NULL,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    request_hash text NOT NULL,
    source_id text NOT NULL,
    source_digest text NOT NULL,
    record jsonb NOT NULL,
    record_json text NOT NULL,
    CONSTRAINT workflow_stop_intents_check CHECK ((record = (record_json)::jsonb)),
    CONSTRAINT workflow_stop_intents_check1 CHECK ((source_digest = ('sha256:'::text || encode(sha256(convert_to(record_json, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT workflow_stop_intents_check2 CHECK ((NOT ((record ->> 'principalId'::text) IS DISTINCT FROM principal_id))),
    CONSTRAINT workflow_stop_intents_check3 CHECK ((NOT ((record ->> 'commandId'::text) IS DISTINCT FROM command_id))),
    CONSTRAINT workflow_stop_intents_check4 CHECK ((NOT ((record ->> 'workspaceId'::text) IS DISTINCT FROM workspace_id))),
    CONSTRAINT workflow_stop_intents_check5 CHECK ((NOT ((record ->> 'runId'::text) IS DISTINCT FROM run_id))),
    CONSTRAINT workflow_stop_intents_check6 CHECK ((NOT ((record ->> 'requestHash'::text) IS DISTINCT FROM request_hash))),
    CONSTRAINT workflow_stop_intents_check7 CHECK ((NOT ((record #>> '{receipt,runId}'::text[]) IS DISTINCT FROM run_id))),
    CONSTRAINT workflow_stop_intents_command_id_check CHECK ((command_id <> ''::text)),
    CONSTRAINT workflow_stop_intents_record_check CHECK ((NOT ((record #> '{receipt,processStopped}'::text[]) IS DISTINCT FROM 'false'::jsonb))),
    CONSTRAINT workflow_stop_intents_record_check1 CHECK (((record #>> '{receipt,status}'::text[]) = ANY (ARRAY['accepted'::text, 'already_terminal'::text]))),
    CONSTRAINT workflow_stop_intents_record_json_check CHECK ((octet_length(record_json) <= 4194304)),
    CONSTRAINT workflow_stop_intents_request_hash_check CHECK ((request_hash ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: workflow_trigger_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_trigger_jobs (
    id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    principal_id text NOT NULL,
    trigger_revision bigint NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    run_id text,
    error_code text,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_trigger_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'leased'::text, 'started'::text, 'blocked'::text])))
);


--
-- Name: workflow_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_triggers (
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    principal_id text NOT NULL,
    record jsonb NOT NULL,
    enabled boolean NOT NULL,
    next_fire_at timestamp with time zone,
    last_error text
);


--
-- Name: workflow_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_versions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    workflow_id text NOT NULL,
    version integer NOT NULL,
    entry_node_id text NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    execution_semantics_version smallint DEFAULT 3 NOT NULL,
    CONSTRAINT repeat_version_record_pin CHECK (((execution_semantics_version <> 3) OR ((((record -> 'executionSemanticsVersion'::text) = '3'::jsonb) AND ((record #> '{definition,executionSemanticsVersion}'::text[]) = '3'::jsonb) AND ((record ->> 'id'::text) = id) AND ((record ->> 'workspaceId'::text) = workspace_id) AND ((record ->> 'workflowId'::text) = workflow_id) AND
CASE
    WHEN (NOT ((record -> 'definition'::text) ? 'repeat'::text)) THEN true
    WHEN ((jsonb_typeof((record #> '{definition,repeat}'::text[])) = 'object'::text) AND ((record #> '{definition,repeat,contractVersion}'::text[]) = '1'::jsonb) AND (jsonb_typeof((record #> '{definition,repeat,blocks}'::text[])) = 'array'::text)) THEN ((jsonb_array_length((record #> '{definition,repeat,blocks}'::text[])) >= 1) AND (jsonb_array_length((record #> '{definition,repeat,blocks}'::text[])) <= 1000))
    ELSE false
END) IS TRUE))),
    CONSTRAINT run_graph_semantics_pin_matches_record CHECK ((execution_semantics_version = COALESCE((((record ->> 'executionSemanticsVersion'::text))::smallint)::integer, 1))),
    CONSTRAINT workflow_versions_execution_semantics_version_check CHECK ((execution_semantics_version = ANY (ARRAY[1, 2, 3])))
);


--
-- Name: workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflows (
    id text NOT NULL,
    workspace_id text NOT NULL,
    current_version_id text,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    archived_at timestamp with time zone,
    order_position bigint NOT NULL,
    CONSTRAINT workflow_order_position_positive CHECK ((order_position > 0))
);


--
-- Name: workspace_project_provisioning; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_project_provisioning (
    id text NOT NULL,
    principal_id text NOT NULL,
    command_id text NOT NULL,
    workspace_id text NOT NULL,
    root_path text NOT NULL,
    staging_path text NOT NULL,
    identity jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_repository_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_repository_imports (
    import_id uuid NOT NULL,
    principal_id text NOT NULL,
    workspace_id text NOT NULL,
    command_id text NOT NULL,
    input_hash text NOT NULL,
    input jsonb NOT NULL,
    phase text NOT NULL,
    preparation jsonb NOT NULL,
    results jsonb DEFAULT '{}'::jsonb NOT NULL,
    failure jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT workspace_repository_imports_phase_check CHECK ((phase = ANY (ARRAY['reserved'::text, 'cloned'::text, 'published'::text, 'metadata'::text, 'location'::text, 'approved'::text, 'bound'::text, 'ready'::text])))
);


--
-- Name: workspace_root_host_configuration_heads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_root_host_configuration_heads (
    host_scope text NOT NULL,
    configuration_revision bigint NOT NULL
);


--
-- Name: workspace_root_host_configurations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_root_host_configurations (
    host_scope text NOT NULL,
    configuration_revision bigint NOT NULL,
    main_id uuid NOT NULL,
    application_installation_id uuid NOT NULL,
    record jsonb NOT NULL,
    digest text NOT NULL,
    CONSTRAINT workspace_root_host_configurations_configuration_revision_check CHECK ((configuration_revision > 0))
);


--
-- Name: workspace_root_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_root_policies (
    root_policy_id uuid NOT NULL,
    root_policy_revision bigint NOT NULL,
    workspace_id text NOT NULL,
    host_scope text NOT NULL,
    location_revision bigint NOT NULL,
    record jsonb NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT workspace_root_policies_root_policy_revision_check CHECK ((root_policy_revision > 0))
);


--
-- Name: workspace_root_policy_heads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_root_policy_heads (
    workspace_id text NOT NULL,
    host_scope text NOT NULL,
    root_policy_id uuid NOT NULL,
    root_policy_revision bigint NOT NULL
);


--
-- Name: workspace_skill_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_skill_versions (
    workspace_id text NOT NULL,
    skill_id text NOT NULL,
    version text NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sequence integer NOT NULL
);


--
-- Name: workspace_skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_skills (
    workspace_id text NOT NULL,
    skill_id text NOT NULL,
    head_version text NOT NULL,
    revision bigint NOT NULL,
    version_count integer NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_skills_revision_check CHECK ((revision > 0)),
    CONSTRAINT workspace_skills_version_count_check CHECK ((version_count > 0))
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id text NOT NULL,
    record jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    archived_at timestamp with time zone,
    execution_location jsonb,
    execution_location_identity jsonb,
    location_revision bigint DEFAULT 0 NOT NULL,
    created_project_folder jsonb,
    workflow_order_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT workspaces_workflow_order_revision_check CHECK ((workflow_order_revision >= 0))
);


--
-- Data for Name: checkpoint_blobs; Type: TABLE DATA; Schema: langgraph; Owner: -
--



--
-- Data for Name: checkpoint_migrations; Type: TABLE DATA; Schema: langgraph; Owner: -
--

INSERT INTO langgraph.checkpoint_migrations VALUES (0);
INSERT INTO langgraph.checkpoint_migrations VALUES (1);
INSERT INTO langgraph.checkpoint_migrations VALUES (2);
INSERT INTO langgraph.checkpoint_migrations VALUES (3);
INSERT INTO langgraph.checkpoint_migrations VALUES (4);


--
-- Data for Name: checkpoint_writes; Type: TABLE DATA; Schema: langgraph; Owner: -
--



--
-- Data for Name: checkpoints; Type: TABLE DATA; Schema: langgraph; Owner: -
--



--
-- Data for Name: agent_configuration_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: agents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: application_installation; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.application_installation VALUES (true, '1baa563b-f384-4c65-b2d5-e630db853be9');


--
-- Data for Name: application_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.application_migrations VALUES (1, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (3, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (4, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (100, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (400, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (401, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (500, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (501, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (502, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (503, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (507, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (508, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (509, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (700, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (701, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (800, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (1701, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (1702, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (170017, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (170019, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (170020, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (170021, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (170022, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (170023, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (170024, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (170025, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (170026, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (250001, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (250002, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (250003, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (250005, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264201, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264401, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264501, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264502, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264601, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264602, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264603, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264604, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (26090501, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (265501, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (265502, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264402, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264403, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264404, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264405, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (264701, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (267201, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (267202, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (267203, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (268201, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (269301, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (269401, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (269501, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (270203, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (270205, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (270204, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (273601, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (273636, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (273640, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (273605, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (273637, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (278001, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285001, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285002, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285003, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (282101, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (282501, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (282502, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (282503, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283401, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283402, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283801, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285801, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283802, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283803, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283804, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283805, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283806, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283807, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283808, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (284301, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (284401, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (284501, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285201, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285202, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285203, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285204, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (284302, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (283809, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285205, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285206, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285207, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100602, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100603, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100604, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (282504, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (288601, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (288603, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (3101001, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285901, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285902, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (270206, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (270207, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (284101, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285802, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (269302, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (269303, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (269304, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (269305, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101010, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (269306, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (269307, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (269308, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285208, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285209, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285210, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100401, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100501, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100601, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100607, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100605, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100606, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100859, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101605, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285905, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100860, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100861, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (285903, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (286015, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100901, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100902, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100905, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100910, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026100912, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101001, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101002, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101003, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101011, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101012, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101013, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101014, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101015, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101101, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101102, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101103, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101104, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101201, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101210, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101211, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101212, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101213, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101214, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101220, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101304, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101311, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101330, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101401, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101346, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101350, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101451, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101477, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101501, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101502, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101503, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101504, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101510, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101517, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101505, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101520, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101521, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101601, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101602, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101603, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101604, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101606, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101607, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101608, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101609, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101610, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101701, '2026-10-17 17:30:09.883134+00');
INSERT INTO public.application_migrations VALUES (2026101702, '2026-10-17 17:30:09.883134+00');


--
-- Data for Name: application_operators; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.application_operators VALUES ('application-operator', 'application-operator-config-v1-755e5b4c-835d-4e2a-bc96-c848611daa9d', '{"id": "application-operator", "name": "Operator", "role": "operator", "createdAt": "2026-10-17T17:30:11.102Z", "updatedAt": "2026-10-17T17:30:11.102Z", "currentConfigurationVersionId": "application-operator-config-v1-755e5b4c-835d-4e2a-bc96-c848611daa9d"}', '2026-10-17 17:30:11.099067+00', '2026-10-17 17:30:11.099067+00');


--
-- Data for Name: application_setting_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: application_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: approval_execution_state; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: bug_reports; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: build_computer_preferences; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ci_dispatch_claims; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ci_enrollment_computers; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ci_enrollment_workspaces; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ci_file_durations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ci_group_requesters; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ci_request_groups; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ci_runs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ci_runtime_preparations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ci_test_result_cache; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: claude_callback_receipts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: computer_sync_identities; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: computer_sync_preferences; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: conversation_session_controls; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: conversation_session_defaults; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: current_workflow_publications; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: device_authorization_secret; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: device_pairing_grants; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: device_registrations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: durable_interactions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: execution_dispatch_intents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: execution_dispatch_owner_grants; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: execution_native_closures; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: execution_native_placements; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: execution_native_recoveries; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: execution_native_sessions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: execution_work_result_repairs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_allocations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_artifact_edge_reads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_artifact_edges; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_retention_preferences; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_revisions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_tool_artifacts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_tool_copy_receipts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_tool_publications; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_tool_read_provenance; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_tool_sessions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: files; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: graph_drafts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: graph_edit_intents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: harness_executions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: harness_instance_profile_evidence; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: harness_instance_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: harness_mcp_change_plans; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: harness_native_events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: harness_qualifications; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: host_harness_measurements; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: interaction_delivery_attempts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: interaction_graph_resumes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: interaction_reconciliation_evidence; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_admission_queue; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_computer_selections; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_definition_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_definitions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_dispatch_intents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_executions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_log_chunks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_preparations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_runtime_profile_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_runtime_profiles; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: job_runtime_qualification_approvals; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: local_human_principal; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.local_human_principal VALUES (true, 'principal-local-human');


--
-- Data for Name: local_workflow_native_output_chunks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: local_workflow_native_output_commands; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: local_workflow_native_outputs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: management_audit; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: management_command_receipts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: management_principals; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.management_principals VALUES ('principal-local-human', 'Local human', 'operator', NULL, '[{"scope": {}, "actions": ["provider_accounts:read", "provider_accounts:manage", "bug_reports:report", "bug_reports:read", "bug_reports:update", "sources:read", "sources:approve", "sources:reconcile", "source_roots:read", "source_roots:bind", "job_definitions:read", "job_definitions:write", "jobs:start", "jobs:read", "jobs:cancel", "job_logs:read", "job_artifacts:read", "ci", "jobs:prioritize", "agents:create", "agents:update", "agents:archive", "agents:restore", "workspaces:restore", "workflows:restore", "workspace_locations:provision", "skills:read", "skills:publish", "workflow_triggers:read", "workflow_triggers:update", "workflow_triggers:fire", "runs:resume", "capabilities:read", "operator_chat:read", "operator_chat:write", "operator_chat:cancel", "operator_chat:respond", "operator_handoff:read", "agent_chat:read", "agent_chat:write", "agent_chat:cancel", "agent_chat:respond", "harnesses:read", "harnesses:update", "devices:read", "devices:metrics:read", "settings:read", "settings:update", "workspaces:read", "workspaces:create", "workspaces:update", "workspaces:archive", "workspace_locations:read", "workspace_locations:validate", "workspace_locations:update", "workflows:read", "workflows:create", "workflows:update", "workflows:archive", "agents:read", "graph:read", "graph:edit", "graph:save", "runs:read", "runs:start", "runs:stop", "runs:subagents:input", "interactions:read", "interactions:respond"]}, {"scope": {}, "actions": ["bug_reports:report", "bug_reports:read", "bug_reports:update"]}]', '9999-12-31 23:59:59+00', NULL, '2026-10-17 17:30:09.883134+00', NULL, NULL);


--
-- Data for Name: native_session_lanes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: operator_chat_credentials; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: operator_configuration_versions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.operator_configuration_versions VALUES ('application-operator-config-v1-755e5b4c-835d-4e2a-bc96-c848611daa9d', 'application-operator', 1, '{"id": "application-operator-config-v1-755e5b4c-835d-4e2a-bc96-c848611daa9d", "harness": {"model": "gpt-5.6-luna", "harness": "codex", "sandbox": "danger-full-access", "advanced": {"webSearch": "cached", "mcpServers": {}, "approvalPolicy": "never", "shellEnvironment": {"set": {}, "filters": {}, "inherit": "all", "ignoreDefaultExcludes": false}, "approvalsReviewer": "user", "sessionPersistence": "persistent", "additionalWritableDirectories": []}, "serviceTier": "standard", "reasoningEffort": "medium"}, "version": 1, "createdAt": "2026-10-17T17:30:11.102Z", "operatorId": "application-operator", "contentHash": "sha256:5fdeed7798fa7cd6993ed2c66e9af6fbbe1987934678b02f5fb1c0b16db64ba9", "showThinking": true}', '2026-10-17 17:30:11.099067+00');


--
-- Data for Name: operator_conversation_activity; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: operator_conversation_messages; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: operator_conversation_turns; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: operator_conversations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: provider_account_accepted_bindings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: provider_account_authentication_operations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: provider_account_observations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: remote_dispatch_origins; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: remote_execution_owner_reconciliations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: remote_execution_receipts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: remote_execution_recovery_audit; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: repeat_workflow_publications; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: review_jobs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: review_native_entries; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: review_native_proofs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_activity; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_activity_streams; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_authority_principals; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_board_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_checkpoint_owners; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_cleanup_intents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_graph_batches; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_graph_effects; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_graph_heads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_graph_public_projection; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_graph_sources; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_input_bindings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_native_activity; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_native_correlations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_native_projection_checkpoints; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_node_placements; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_node_resolutions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_reference_file_pins; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_reference_file_reads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_repeat_bindings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_repeat_decisions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_repeat_effects; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_repeat_executions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_repeat_occurrences; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_repeat_resolutions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_repeat_results; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_repeat_slots; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_subagent_backfill_state; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_subagent_command_receipts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_subagent_items; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_subagent_lifecycle; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_subagent_message_roles; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_subagent_pending_events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_subagent_projection_queue; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_subagent_sources; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_subagents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_activations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_connection_usage; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_denials; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_direction_responses; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_direction_waits; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_join_dispatches; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_notices; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_requests; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_results; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_returns; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_work_unresolved; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: run_worktrees; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: runs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: source_approvals; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: source_execution_materializations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: source_preparation_reconciliations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: source_root_bindings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: source_root_catalog; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: source_snapshot_uses; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: source_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: source_storage_reservations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: worker_credential_bindings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_job_executions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_job_preparations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_native_entries; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_native_proofs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_schedule_authorities; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_schedule_occurrences; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_schedules; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_stop_intents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_trigger_jobs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_triggers; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflow_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workflows; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workspace_project_provisioning; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workspace_repository_imports; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workspace_root_host_configuration_heads; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.workspace_root_host_configuration_heads VALUES ('main:1baa563b-f384-4c65-b2d5-e630db853be9', 1);


--
-- Data for Name: workspace_root_host_configurations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.workspace_root_host_configurations VALUES ('main:1baa563b-f384-4c65-b2d5-e630db853be9', 1, '1baa563b-f384-4c65-b2d5-e630db853be9', '1baa563b-f384-4c65-b2d5-e630db853be9', '{"bases": [{"baseId": "316c3d65-2b92-5c9a-a4bb-854478c5cef7", "filesystem": {"inode": "9712997", "device": "66305", "mountId": "27"}, "accessModes": ["read-only", "read-write"], "filesystemId": "35b60f8473d0c15", "canonicalPath": "/home/runner/.cache/foreman-capture/c-ljkMEE/r-4ScEEV/app/projects"}], "hostRef": {"kind": "main", "mainId": "1baa563b-f384-4c65-b2d5-e630db853be9"}, "schemaVersion": 1, "runtimeFilesystem": {"inode": "9713000", "device": "66305", "mountId": "27"}, "managedRuntimeRoot": "/home/runner/.cache/foreman-capture/c-ljkMEE/r-4ScEEV/app/workspaces", "runtimeFilesystemId": "35b60f8473d0c15", "configurationRevision": "1", "applicationInstallationId": "1baa563b-f384-4c65-b2d5-e630db853be9"}', '5656698be399cfa7d41b7ca5933d47573f6c0ee77254920be1a1bdce280f71c8');


--
-- Data for Name: workspace_root_policies; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workspace_root_policy_heads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workspace_skill_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workspace_skills; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workspaces; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: execution_native_closures_generation_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.execution_native_closures_generation_seq', 1, false);


--
-- Name: file_tool_read_provenance_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.file_tool_read_provenance_id_seq', 1, false);


--
-- Name: interaction_reconciliation_evidence_sequence_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.interaction_reconciliation_evidence_sequence_seq', 1, false);


--
-- Name: job_admission_queue_sequence; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.job_admission_queue_sequence', 1, false);


--
-- Name: management_audit_sequence_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.management_audit_sequence_seq', 1, false);


--
-- Name: native_event_ingestion_sequence; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.native_event_ingestion_sequence', 1, false);


--
-- Name: operator_conversation_activity_sequence_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.operator_conversation_activity_sequence_seq', 1, false);


--
-- Name: operator_conversation_messages_sequence_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.operator_conversation_messages_sequence_seq', 1, false);


--
-- Name: operator_conversation_turns_turn_sequence_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.operator_conversation_turns_turn_sequence_seq', 1, false);


--
-- Name: remote_execution_owner_reconciliations_ordinal_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.remote_execution_owner_reconciliations_ordinal_seq', 1, false);


--
-- Name: remote_execution_recovery_audit_ordinal_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.remote_execution_recovery_audit_ordinal_seq', 1, false);


--
-- Name: run_activity_sequence_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.run_activity_sequence_seq', 1, false);


--
-- Name: run_subagent_items_ordinal_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.run_subagent_items_ordinal_seq', 1, false);


--
-- Name: run_work_activations_activation_sequence_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.run_work_activations_activation_sequence_seq', 1, false);


--
-- Name: checkpoint_blobs checkpoint_blobs_pkey; Type: CONSTRAINT; Schema: langgraph; Owner: -
--

ALTER TABLE ONLY langgraph.checkpoint_blobs
    ADD CONSTRAINT checkpoint_blobs_pkey PRIMARY KEY (thread_id, checkpoint_ns, channel, version);


--
-- Name: checkpoint_migrations checkpoint_migrations_pkey; Type: CONSTRAINT; Schema: langgraph; Owner: -
--

ALTER TABLE ONLY langgraph.checkpoint_migrations
    ADD CONSTRAINT checkpoint_migrations_pkey PRIMARY KEY (v);


--
-- Name: checkpoint_writes checkpoint_writes_pkey; Type: CONSTRAINT; Schema: langgraph; Owner: -
--

ALTER TABLE ONLY langgraph.checkpoint_writes
    ADD CONSTRAINT checkpoint_writes_pkey PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx);


--
-- Name: checkpoints checkpoints_pkey; Type: CONSTRAINT; Schema: langgraph; Owner: -
--

ALTER TABLE ONLY langgraph.checkpoints
    ADD CONSTRAINT checkpoints_pkey PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id);


--
-- Name: agent_configuration_versions agent_configuration_versions_agent_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_configuration_versions
    ADD CONSTRAINT agent_configuration_versions_agent_id_version_key UNIQUE (agent_id, version);


--
-- Name: agent_configuration_versions agent_configuration_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_configuration_versions
    ADD CONSTRAINT agent_configuration_versions_pkey PRIMARY KEY (id);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: application_installation application_installation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_installation
    ADD CONSTRAINT application_installation_pkey PRIMARY KEY (singleton);


--
-- Name: application_migrations application_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_migrations
    ADD CONSTRAINT application_migrations_pkey PRIMARY KEY (version);


--
-- Name: application_operators application_operators_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_operators
    ADD CONSTRAINT application_operators_pkey PRIMARY KEY (id);


--
-- Name: application_setting_versions application_setting_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_setting_versions
    ADD CONSTRAINT application_setting_versions_pkey PRIMARY KEY (id);


--
-- Name: application_setting_versions application_setting_versions_setting_key_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_setting_versions
    ADD CONSTRAINT application_setting_versions_setting_key_version_key UNIQUE (setting_key, version);


--
-- Name: application_settings application_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_settings
    ADD CONSTRAINT application_settings_pkey PRIMARY KEY (key);


--
-- Name: approval_execution_state approval_execution_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_execution_state
    ADD CONSTRAINT approval_execution_state_pkey PRIMARY KEY (execution_id);


--
-- Name: bug_reports bug_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bug_reports
    ADD CONSTRAINT bug_reports_pkey PRIMARY KEY (id);


--
-- Name: build_computer_preferences build_computer_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_computer_preferences
    ADD CONSTRAINT build_computer_preferences_pkey PRIMARY KEY (host_key);


--
-- Name: ci_dispatch_claims ci_dispatch_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_dispatch_claims
    ADD CONSTRAINT ci_dispatch_claims_pkey PRIMARY KEY (ticket_id);


--
-- Name: ci_enrollment_computers ci_enrollment_computers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_enrollment_computers
    ADD CONSTRAINT ci_enrollment_computers_pkey PRIMARY KEY (workspace_id, host_key);


--
-- Name: ci_enrollment_workspaces ci_enrollment_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_enrollment_workspaces
    ADD CONSTRAINT ci_enrollment_workspaces_pkey PRIMARY KEY (workspace_id);


--
-- Name: ci_file_durations ci_file_durations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_file_durations
    ADD CONSTRAINT ci_file_durations_pkey PRIMARY KEY (repository, file);


--
-- Name: ci_request_groups ci_request_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_request_groups
    ADD CONSTRAINT ci_request_groups_pkey PRIMARY KEY (group_id);


--
-- Name: ci_runs ci_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_runs
    ADD CONSTRAINT ci_runs_pkey PRIMARY KEY (id);


--
-- Name: ci_runtime_preparations ci_runtime_preparations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_runtime_preparations
    ADD CONSTRAINT ci_runtime_preparations_pkey PRIMARY KEY (id);


--
-- Name: ci_runtime_preparations ci_runtime_preparations_principal_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_runtime_preparations
    ADD CONSTRAINT ci_runtime_preparations_principal_id_command_id_key UNIQUE (principal_id, command_id);


--
-- Name: ci_test_result_cache ci_test_result_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_test_result_cache
    ADD CONSTRAINT ci_test_result_cache_pkey PRIMARY KEY (workspace_id, repository, cache_key);


--
-- Name: claude_callback_receipts claude_callback_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claude_callback_receipts
    ADD CONSTRAINT claude_callback_receipts_pkey PRIMARY KEY (owner_key, callback_key);


--
-- Name: computer_sync_identities computer_sync_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_sync_identities
    ADD CONSTRAINT computer_sync_identities_pkey PRIMARY KEY (host_key, target);


--
-- Name: computer_sync_preferences computer_sync_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_sync_preferences
    ADD CONSTRAINT computer_sync_preferences_pkey PRIMARY KEY (workspace_id, host_key);


--
-- Name: conversation_session_controls conversation_session_controls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_session_controls
    ADD CONSTRAINT conversation_session_controls_pkey PRIMARY KEY (conversation_id);


--
-- Name: conversation_session_defaults conversation_session_defaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_session_defaults
    ADD CONSTRAINT conversation_session_defaults_pkey PRIMARY KEY (principal_id, role, subject, profile_key);


--
-- Name: run_repeat_bindings current_binding_time_required; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.run_repeat_bindings
    ADD CONSTRAINT current_binding_time_required CHECK ((bound_at IS NOT NULL)) NOT VALID;


--
-- Name: current_workflow_publications current_workflow_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_workflow_publications
    ADD CONSTRAINT current_workflow_publications_pkey PRIMARY KEY (workflow_version_id);


--
-- Name: current_workflow_publications current_workflow_publications_principal_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_workflow_publications
    ADD CONSTRAINT current_workflow_publications_principal_id_command_id_key UNIQUE (principal_id, command_id);


--
-- Name: current_workflow_publications current_workflow_publications_workflow_id_expected_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_workflow_publications
    ADD CONSTRAINT current_workflow_publications_workflow_id_expected_revision_key UNIQUE (workflow_id, expected_revision);


--
-- Name: current_workflow_publications current_workflow_publications_workflow_id_publication_xid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_workflow_publications
    ADD CONSTRAINT current_workflow_publications_workflow_id_publication_xid_key UNIQUE (workflow_id, publication_xid);


--
-- Name: device_authorization_secret device_authorization_secret_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_authorization_secret
    ADD CONSTRAINT device_authorization_secret_pkey PRIMARY KEY (singleton);


--
-- Name: device_main_identity device_main_identity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_main_identity
    ADD CONSTRAINT device_main_identity_pkey PRIMARY KEY (main_id);


--
-- Name: device_pairing_grants device_pairing_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_pairing_grants
    ADD CONSTRAINT device_pairing_grants_pkey PRIMARY KEY (id);


--
-- Name: device_pairing_grants device_pairing_grants_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_pairing_grants
    ADD CONSTRAINT device_pairing_grants_token_hash_key UNIQUE (token_hash);


--
-- Name: device_registrations device_registrations_credential_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_registrations
    ADD CONSTRAINT device_registrations_credential_hash_key UNIQUE (credential_hash);


--
-- Name: device_registrations device_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_registrations
    ADD CONSTRAINT device_registrations_pkey PRIMARY KEY (id);


--
-- Name: device_registrations device_registrations_worker_installation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_registrations
    ADD CONSTRAINT device_registrations_worker_installation_id_key UNIQUE (worker_installation_id);


--
-- Name: durable_interactions durable_interactions_harness_native_session_id_native_reque_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_interactions
    ADD CONSTRAINT durable_interactions_harness_native_session_id_native_reque_key UNIQUE (harness, native_session_id, native_request_id);


--
-- Name: durable_interactions durable_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_interactions
    ADD CONSTRAINT durable_interactions_pkey PRIMARY KEY (id);


--
-- Name: execution_dispatch_intents execution_dispatch_intents_attempt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_dispatch_intents
    ADD CONSTRAINT execution_dispatch_intents_attempt_id_key UNIQUE (attempt_id);


--
-- Name: execution_dispatch_intents execution_dispatch_intents_execution_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_dispatch_intents
    ADD CONSTRAINT execution_dispatch_intents_execution_id_key UNIQUE (execution_id);


--
-- Name: execution_dispatch_intents execution_dispatch_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_dispatch_intents
    ADD CONSTRAINT execution_dispatch_intents_pkey PRIMARY KEY (operation_id);


--
-- Name: execution_dispatch_owner_grants execution_dispatch_owner_grants_execution_id_epoch_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_dispatch_owner_grants
    ADD CONSTRAINT execution_dispatch_owner_grants_execution_id_epoch_key UNIQUE (execution_id, epoch);


--
-- Name: execution_dispatch_owner_grants execution_dispatch_owner_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_dispatch_owner_grants
    ADD CONSTRAINT execution_dispatch_owner_grants_pkey PRIMARY KEY (grant_id);


--
-- Name: execution_native_closures execution_native_closures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_closures
    ADD CONSTRAINT execution_native_closures_pkey PRIMARY KEY (generation);


--
-- Name: execution_native_placements execution_native_placements_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_placements
    ADD CONSTRAINT execution_native_placements_operation_id_key UNIQUE (operation_id);


--
-- Name: execution_native_placements execution_native_placements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_placements
    ADD CONSTRAINT execution_native_placements_pkey PRIMARY KEY (execution_id);


--
-- Name: execution_native_recoveries execution_native_recoveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_recoveries
    ADD CONSTRAINT execution_native_recoveries_pkey PRIMARY KEY (generation);


--
-- Name: execution_native_sessions execution_native_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_sessions
    ADD CONSTRAINT execution_native_sessions_pkey PRIMARY KEY (execution_id);


--
-- Name: execution_work_result_repairs execution_work_result_repairs_execution_id_rejected_provide_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_work_result_repairs
    ADD CONSTRAINT execution_work_result_repairs_execution_id_rejected_provide_key UNIQUE (execution_id, rejected_provider_id);


--
-- Name: execution_work_result_repairs execution_work_result_repairs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_work_result_repairs
    ADD CONSTRAINT execution_work_result_repairs_pkey PRIMARY KEY (execution_id, attempt);


--
-- Name: file_allocations file_allocations_owner_principal_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_allocations
    ADD CONSTRAINT file_allocations_owner_principal_id_request_id_key UNIQUE (owner_principal_id, request_id);


--
-- Name: file_allocations file_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_allocations
    ADD CONSTRAINT file_allocations_pkey PRIMARY KEY (allocation_id);


--
-- Name: file_allocations file_allocations_revision_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_allocations
    ADD CONSTRAINT file_allocations_revision_id_key UNIQUE (revision_id);


--
-- Name: file_artifact_edges file_artifact_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_artifact_edges
    ADD CONSTRAINT file_artifact_edges_pkey PRIMARY KEY (edge_id);


--
-- Name: file_artifact_edges file_artifact_edges_receiver_principal_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_artifact_edges
    ADD CONSTRAINT file_artifact_edges_receiver_principal_id_command_id_key UNIQUE (receiver_principal_id, command_id);


--
-- Name: file_retention_preferences file_retention_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_retention_preferences
    ADD CONSTRAINT file_retention_preferences_pkey PRIMARY KEY (owner_principal_id);


--
-- Name: file_revisions file_revisions_file_id_revision_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_revisions
    ADD CONSTRAINT file_revisions_file_id_revision_id_key UNIQUE (file_id, revision_id);


--
-- Name: file_revisions file_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_revisions
    ADD CONSTRAINT file_revisions_pkey PRIMARY KEY (revision_id);


--
-- Name: file_revisions file_revisions_storage_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_revisions
    ADD CONSTRAINT file_revisions_storage_key_key UNIQUE (storage_key);


--
-- Name: file_tool_artifacts file_tool_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_tool_artifacts
    ADD CONSTRAINT file_tool_artifacts_pkey PRIMARY KEY (artifact_id);


--
-- Name: file_tool_copy_receipts file_tool_copy_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_tool_copy_receipts
    ADD CONSTRAINT file_tool_copy_receipts_pkey PRIMARY KEY (owner_principal_id, command_id);


--
-- Name: file_tool_publications file_tool_publications_file_id_revision_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_tool_publications
    ADD CONSTRAINT file_tool_publications_file_id_revision_id_key UNIQUE (file_id, revision_id);


--
-- Name: file_tool_publications file_tool_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_tool_publications
    ADD CONSTRAINT file_tool_publications_pkey PRIMARY KEY (owner_principal_id, request_id);


--
-- Name: file_tool_read_provenance file_tool_read_provenance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_tool_read_provenance
    ADD CONSTRAINT file_tool_read_provenance_pkey PRIMARY KEY (id);


--
-- Name: file_tool_sessions file_tool_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_tool_sessions
    ADD CONSTRAINT file_tool_sessions_pkey PRIMARY KEY (token_hash);


--
-- Name: files files_file_id_owner_principal_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_file_id_owner_principal_id_key UNIQUE (file_id, owner_principal_id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (file_id);


--
-- Name: graph_drafts graph_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_drafts
    ADD CONSTRAINT graph_drafts_pkey PRIMARY KEY (id);


--
-- Name: graph_drafts graph_drafts_workflow_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_drafts
    ADD CONSTRAINT graph_drafts_workflow_id_key UNIQUE (workflow_id);


--
-- Name: graph_edit_intents graph_edit_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_edit_intents
    ADD CONSTRAINT graph_edit_intents_pkey PRIMARY KEY (id);


--
-- Name: harness_executions harness_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_executions
    ADD CONSTRAINT harness_executions_pkey PRIMARY KEY (id);


--
-- Name: harness_instance_profile_evidence harness_instance_profile_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_instance_profile_evidence
    ADD CONSTRAINT harness_instance_profile_evidence_pkey PRIMARY KEY (check_id);


--
-- Name: harness_instance_settings harness_instance_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_instance_settings
    ADD CONSTRAINT harness_instance_settings_pkey PRIMARY KEY (instance_id, revision);


--
-- Name: harness_mcp_change_plans harness_mcp_change_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_mcp_change_plans
    ADD CONSTRAINT harness_mcp_change_plans_pkey PRIMARY KEY (id);


--
-- Name: harness_native_events harness_native_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_native_events
    ADD CONSTRAINT harness_native_events_pkey PRIMARY KEY (execution_id, sequence);


--
-- Name: harness_qualifications harness_qualifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_qualifications
    ADD CONSTRAINT harness_qualifications_pkey PRIMARY KEY (harness, version, binary_sha256, suite_revision);


--
-- Name: host_harness_measurements host_harness_measurements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_harness_measurements
    ADD CONSTRAINT host_harness_measurements_pkey PRIMARY KEY (identity_hash);


--
-- Name: interaction_delivery_attempts interaction_delivery_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interaction_delivery_attempts
    ADD CONSTRAINT interaction_delivery_attempts_pkey PRIMARY KEY (interaction_id, attempt);


--
-- Name: interaction_graph_resumes interaction_graph_resumes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interaction_graph_resumes
    ADD CONSTRAINT interaction_graph_resumes_pkey PRIMARY KEY (interaction_id);


--
-- Name: interaction_reconciliation_evidence interaction_reconciliation_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interaction_reconciliation_evidence
    ADD CONSTRAINT interaction_reconciliation_evidence_pkey PRIMARY KEY (sequence);


--
-- Name: job_admission_queue job_admission_queue_attempt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_admission_queue
    ADD CONSTRAINT job_admission_queue_attempt_id_key UNIQUE (attempt_id);


--
-- Name: job_admission_queue job_admission_queue_enqueue_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_admission_queue
    ADD CONSTRAINT job_admission_queue_enqueue_sequence_key UNIQUE (enqueue_sequence);


--
-- Name: job_admission_queue job_admission_queue_execution_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_admission_queue
    ADD CONSTRAINT job_admission_queue_execution_id_key UNIQUE (execution_id);


--
-- Name: job_admission_queue job_admission_queue_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_admission_queue
    ADD CONSTRAINT job_admission_queue_operation_id_key UNIQUE (operation_id);


--
-- Name: job_admission_queue job_admission_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_admission_queue
    ADD CONSTRAINT job_admission_queue_pkey PRIMARY KEY (id);


--
-- Name: job_admission_queue job_admission_queue_principal_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_admission_queue
    ADD CONSTRAINT job_admission_queue_principal_id_command_id_key UNIQUE (principal_id, command_id);


--
-- Name: job_computer_selections job_computer_selections_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_computer_selections
    ADD CONSTRAINT job_computer_selections_operation_id_key UNIQUE (operation_id);


--
-- Name: job_computer_selections job_computer_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_computer_selections
    ADD CONSTRAINT job_computer_selections_pkey PRIMARY KEY (execution_id);


--
-- Name: job_definition_versions job_definition_versions_definition_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_definition_versions
    ADD CONSTRAINT job_definition_versions_definition_id_revision_key UNIQUE (definition_id, revision);


--
-- Name: job_definition_versions job_definition_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_definition_versions
    ADD CONSTRAINT job_definition_versions_pkey PRIMARY KEY (id);


--
-- Name: job_definitions job_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_definitions
    ADD CONSTRAINT job_definitions_pkey PRIMARY KEY (id);


--
-- Name: job_definitions job_definitions_version_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_definitions
    ADD CONSTRAINT job_definitions_version_id_key UNIQUE (version_id);


--
-- Name: job_definitions job_definitions_workspace_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_definitions
    ADD CONSTRAINT job_definitions_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: job_dispatch_intents job_dispatch_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_dispatch_intents
    ADD CONSTRAINT job_dispatch_intents_pkey PRIMARY KEY (execution_id);


--
-- Name: job_executions job_executions_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_operation_id_key UNIQUE (operation_id);


--
-- Name: job_executions job_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_pkey PRIMARY KEY (id);


--
-- Name: job_executions job_executions_workspace_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: job_log_chunks job_log_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_log_chunks
    ADD CONSTRAINT job_log_chunks_pkey PRIMARY KEY (execution_id, sequence);


--
-- Name: job_preparations job_preparations_attempt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_preparations
    ADD CONSTRAINT job_preparations_attempt_id_key UNIQUE (attempt_id);


--
-- Name: job_preparations job_preparations_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_preparations
    ADD CONSTRAINT job_preparations_operation_id_key UNIQUE (operation_id);


--
-- Name: job_preparations job_preparations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_preparations
    ADD CONSTRAINT job_preparations_pkey PRIMARY KEY (execution_id);


--
-- Name: job_preparations job_preparations_principal_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_preparations
    ADD CONSTRAINT job_preparations_principal_id_command_id_key UNIQUE (principal_id, command_id);


--
-- Name: job_runtime_profile_versions job_runtime_profile_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_profile_versions
    ADD CONSTRAINT job_runtime_profile_versions_pkey PRIMARY KEY (profile_id, revision);


--
-- Name: job_runtime_profiles job_runtime_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_profiles
    ADD CONSTRAINT job_runtime_profiles_pkey PRIMARY KEY (id);


--
-- Name: job_runtime_profiles job_runtime_profiles_workspace_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_profiles
    ADD CONSTRAINT job_runtime_profiles_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: job_runtime_qualification_approvals job_runtime_qualification_app_profile_id_profile_revision_q_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_qualification_approvals
    ADD CONSTRAINT job_runtime_qualification_app_profile_id_profile_revision_q_key UNIQUE (profile_id, profile_revision, qualification_id);


--
-- Name: job_runtime_qualification_approvals job_runtime_qualification_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_qualification_approvals
    ADD CONSTRAINT job_runtime_qualification_approvals_pkey PRIMARY KEY (id);


--
-- Name: job_runtime_qualification_approvals job_runtime_qualification_approvals_qualification_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_qualification_approvals
    ADD CONSTRAINT job_runtime_qualification_approvals_qualification_id_key UNIQUE (qualification_id);


--
-- Name: local_human_principal local_human_principal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_human_principal
    ADD CONSTRAINT local_human_principal_pkey PRIMARY KEY (singleton);


--
-- Name: local_human_principal local_human_principal_principal_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_human_principal
    ADD CONSTRAINT local_human_principal_principal_id_key UNIQUE (principal_id);


--
-- Name: local_workflow_native_output_chunks local_workflow_native_output_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_workflow_native_output_chunks
    ADD CONSTRAINT local_workflow_native_output_chunks_pkey PRIMARY KEY (artifact_id, byte_offset);


--
-- Name: local_workflow_native_output_commands local_workflow_native_output_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_workflow_native_output_commands
    ADD CONSTRAINT local_workflow_native_output_commands_pkey PRIMARY KEY (binding, command_id);


--
-- Name: local_workflow_native_outputs local_workflow_native_outputs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_workflow_native_outputs
    ADD CONSTRAINT local_workflow_native_outputs_pkey PRIMARY KEY (artifact_id);


--
-- Name: management_audit management_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.management_audit
    ADD CONSTRAINT management_audit_pkey PRIMARY KEY (sequence);


--
-- Name: management_command_receipts management_command_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.management_command_receipts
    ADD CONSTRAINT management_command_receipts_pkey PRIMARY KEY (principal_id, operation, command_id);


--
-- Name: management_principals management_principals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.management_principals
    ADD CONSTRAINT management_principals_pkey PRIMARY KEY (id);


--
-- Name: management_principals management_principals_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.management_principals
    ADD CONSTRAINT management_principals_token_hash_key UNIQUE (token_hash);


--
-- Name: native_session_lanes native_session_lanes_harness_native_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.native_session_lanes
    ADD CONSTRAINT native_session_lanes_harness_native_session_id_key UNIQUE (harness, native_session_id);


--
-- Name: native_session_lanes native_session_lanes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.native_session_lanes
    ADD CONSTRAINT native_session_lanes_pkey PRIMARY KEY (id);


--
-- Name: operator_chat_credentials operator_chat_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_chat_credentials
    ADD CONSTRAINT operator_chat_credentials_pkey PRIMARY KEY (principal_id);


--
-- Name: operator_configuration_versions operator_configuration_versions_operator_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_configuration_versions
    ADD CONSTRAINT operator_configuration_versions_operator_id_version_key UNIQUE (operator_id, version);


--
-- Name: operator_configuration_versions operator_configuration_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_configuration_versions
    ADD CONSTRAINT operator_configuration_versions_pkey PRIMARY KEY (id);


--
-- Name: operator_conversation_activity operator_conversation_activit_conversation_id_request_id_ac_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversation_activity
    ADD CONSTRAINT operator_conversation_activit_conversation_id_request_id_ac_key UNIQUE (conversation_id, request_id, activity_id);


--
-- Name: operator_conversation_activity operator_conversation_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversation_activity
    ADD CONSTRAINT operator_conversation_activity_pkey PRIMARY KEY (sequence);


--
-- Name: operator_conversation_messages operator_conversation_messages_conversation_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversation_messages
    ADD CONSTRAINT operator_conversation_messages_conversation_id_sequence_key UNIQUE (conversation_id, sequence);


--
-- Name: operator_conversation_messages operator_conversation_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversation_messages
    ADD CONSTRAINT operator_conversation_messages_pkey PRIMARY KEY (id);


--
-- Name: operator_conversation_turns operator_conversation_turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversation_turns
    ADD CONSTRAINT operator_conversation_turns_pkey PRIMARY KEY (conversation_id, request_id);


--
-- Name: operator_conversations operator_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_pkey PRIMARY KEY (id);


--
-- Name: provider_account_accepted_bindings provider_account_accepted_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_account_accepted_bindings
    ADD CONSTRAINT provider_account_accepted_bindings_pkey PRIMARY KEY (owner_kind, owner_id);


--
-- Name: provider_account_authentication_operations provider_account_authenticati_principal_id_command_id_targe_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_account_authentication_operations
    ADD CONSTRAINT provider_account_authenticati_principal_id_command_id_targe_key UNIQUE (principal_id, command_id, target_key);


--
-- Name: provider_account_authentication_operations provider_account_authentication_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_account_authentication_operations
    ADD CONSTRAINT provider_account_authentication_operations_pkey PRIMARY KEY (id);


--
-- Name: provider_account_observations provider_account_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_account_observations
    ADD CONSTRAINT provider_account_observations_pkey PRIMARY KEY (target_key, account_id);


--
-- Name: remote_dispatch_origins remote_dispatch_origins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_dispatch_origins
    ADD CONSTRAINT remote_dispatch_origins_pkey PRIMARY KEY (operation_id);


--
-- Name: remote_execution_owner_reconciliations remote_execution_owner_reconciliations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_execution_owner_reconciliations
    ADD CONSTRAINT remote_execution_owner_reconciliations_pkey PRIMARY KEY (command_id);


--
-- Name: remote_execution_receipts remote_execution_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_execution_receipts
    ADD CONSTRAINT remote_execution_receipts_pkey PRIMARY KEY (operation_id);


--
-- Name: remote_execution_recovery_audit remote_execution_recovery_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_execution_recovery_audit
    ADD CONSTRAINT remote_execution_recovery_audit_pkey PRIMARY KEY (operation_id, ordinal);


--
-- Name: repeat_workflow_publications repeat_workflow_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repeat_workflow_publications
    ADD CONSTRAINT repeat_workflow_publications_pkey PRIMARY KEY (workflow_version_id);


--
-- Name: repeat_workflow_publications repeat_workflow_publications_principal_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repeat_workflow_publications
    ADD CONSTRAINT repeat_workflow_publications_principal_id_command_id_key UNIQUE (principal_id, command_id);


--
-- Name: repeat_workflow_publications repeat_workflow_publications_workflow_id_expected_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repeat_workflow_publications
    ADD CONSTRAINT repeat_workflow_publications_workflow_id_expected_revision_key UNIQUE (workflow_id, expected_revision);


--
-- Name: repeat_workflow_publications repeat_workflow_publications_workflow_id_publication_xid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repeat_workflow_publications
    ADD CONSTRAINT repeat_workflow_publications_workflow_id_publication_xid_key UNIQUE (workflow_id, publication_xid);


--
-- Name: review_jobs review_jobs_interaction_id_reviewer_agent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_jobs
    ADD CONSTRAINT review_jobs_interaction_id_reviewer_agent_id_key UNIQUE (interaction_id, reviewer_agent_id);


--
-- Name: review_jobs review_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_jobs
    ADD CONSTRAINT review_jobs_pkey PRIMARY KEY (id);


--
-- Name: review_native_entries review_native_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_native_entries
    ADD CONSTRAINT review_native_entries_pkey PRIMARY KEY (job_id);


--
-- Name: review_native_proofs review_native_proofs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_native_proofs
    ADD CONSTRAINT review_native_proofs_pkey PRIMARY KEY (proof_id);


--
-- Name: run_activity run_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_activity
    ADD CONSTRAINT run_activity_pkey PRIMARY KEY (run_id, sequence);


--
-- Name: run_activity_streams run_activity_streams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_activity_streams
    ADD CONSTRAINT run_activity_streams_pkey PRIMARY KEY (run_id);


--
-- Name: run_authority_principals run_authority_principals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_authority_principals
    ADD CONSTRAINT run_authority_principals_pkey PRIMARY KEY (principal_id);


--
-- Name: run_authority_principals run_authority_principals_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_authority_principals
    ADD CONSTRAINT run_authority_principals_run_id_key UNIQUE (run_id);


--
-- Name: run_board_snapshots run_board_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_board_snapshots
    ADD CONSTRAINT run_board_snapshots_pkey PRIMARY KEY (run_id);


--
-- Name: run_checkpoint_owners run_checkpoint_owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_checkpoint_owners
    ADD CONSTRAINT run_checkpoint_owners_pkey PRIMARY KEY (run_id);


--
-- Name: run_cleanup_intents run_cleanup_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_cleanup_intents
    ADD CONSTRAINT run_cleanup_intents_pkey PRIMARY KEY (run_id);


--
-- Name: run_graph_batches run_graph_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_batches
    ADD CONSTRAINT run_graph_batches_pkey PRIMARY KEY (run_id, sequence);


--
-- Name: run_graph_batches run_graph_batches_run_id_batch_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_batches
    ADD CONSTRAINT run_graph_batches_run_id_batch_id_key UNIQUE (run_id, batch_id);


--
-- Name: run_graph_batches run_graph_batches_run_id_publication_xid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_batches
    ADD CONSTRAINT run_graph_batches_run_id_publication_xid_key UNIQUE (run_id, publication_xid);


--
-- Name: run_graph_effects run_graph_effects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_effects
    ADD CONSTRAINT run_graph_effects_pkey PRIMARY KEY (run_id, effect_kind, entity_id);


--
-- Name: run_graph_heads run_graph_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_heads
    ADD CONSTRAINT run_graph_heads_pkey PRIMARY KEY (run_id);


--
-- Name: run_graph_public_projection run_graph_public_projection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_public_projection
    ADD CONSTRAINT run_graph_public_projection_pkey PRIMARY KEY (run_id);


--
-- Name: run_graph_sources run_graph_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_sources
    ADD CONSTRAINT run_graph_sources_pkey PRIMARY KEY (run_id, source_kind, source_id, source_revision);


--
-- Name: run_input_bindings run_input_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_input_bindings
    ADD CONSTRAINT run_input_bindings_pkey PRIMARY KEY (run_id, binding_id);


--
-- Name: run_input_bindings run_input_bindings_run_id_recipient_execution_id_input_ordi_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_input_bindings
    ADD CONSTRAINT run_input_bindings_run_id_recipient_execution_id_input_ordi_key UNIQUE (run_id, recipient_execution_id, input_ordinal);


--
-- Name: run_input_bindings run_input_bindings_run_id_recipient_execution_id_relationsh_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_input_bindings
    ADD CONSTRAINT run_input_bindings_run_id_recipient_execution_id_relationsh_key UNIQUE (run_id, recipient_execution_id, relationship_id);


--
-- Name: run_native_activity run_native_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_activity
    ADD CONSTRAINT run_native_activity_pkey PRIMARY KEY (run_id, execution_id, work_kind, work_id);


--
-- Name: run_native_correlations run_native_correlations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_correlations
    ADD CONSTRAINT run_native_correlations_pkey PRIMARY KEY (run_id, execution_id, work_kind, work_id, correlation_key);


--
-- Name: run_native_projection_checkpoints run_native_projection_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_projection_checkpoints
    ADD CONSTRAINT run_native_projection_checkpoints_pkey PRIMARY KEY (run_id, execution_id, work_kind, work_id);


--
-- Name: run_node_placements run_node_placements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_node_placements
    ADD CONSTRAINT run_node_placements_pkey PRIMARY KEY (run_id, node_id);


--
-- Name: run_node_placements run_node_placements_run_id_node_id_binding_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_node_placements
    ADD CONSTRAINT run_node_placements_run_id_node_id_binding_hash_key UNIQUE (run_id, node_id, binding_hash);


--
-- Name: run_node_resolutions run_node_resolutions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_node_resolutions
    ADD CONSTRAINT run_node_resolutions_pkey PRIMARY KEY (run_id, workflow_node_id);


--
-- Name: run_reference_file_pins run_reference_file_pins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_reference_file_pins
    ADD CONSTRAINT run_reference_file_pins_pkey PRIMARY KEY (run_id, file_id);


--
-- Name: run_reference_file_pins run_reference_file_pins_run_id_file_id_revision_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_reference_file_pins
    ADD CONSTRAINT run_reference_file_pins_run_id_file_id_revision_id_key UNIQUE (run_id, file_id, revision_id);


--
-- Name: run_reference_file_reads run_reference_file_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_reference_file_reads
    ADD CONSTRAINT run_reference_file_reads_pkey PRIMARY KEY (run_id, execution_id, file_id);


--
-- Name: run_repeat_bindings run_repeat_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_bindings
    ADD CONSTRAINT run_repeat_bindings_pkey PRIMARY KEY (binding_id);


--
-- Name: run_repeat_bindings run_repeat_bindings_recipient_execution_id_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_bindings
    ADD CONSTRAINT run_repeat_bindings_recipient_execution_id_ordinal_key UNIQUE (recipient_execution_id, ordinal);


--
-- Name: run_repeat_decisions run_repeat_decisions_decision_id_occurrence_id_result_diges_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_decisions
    ADD CONSTRAINT run_repeat_decisions_decision_id_occurrence_id_result_diges_key UNIQUE (decision_id, occurrence_id, result_digest);


--
-- Name: run_repeat_decisions run_repeat_decisions_occurrence_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_decisions
    ADD CONSTRAINT run_repeat_decisions_occurrence_id_key UNIQUE (occurrence_id);


--
-- Name: run_repeat_decisions run_repeat_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_decisions
    ADD CONSTRAINT run_repeat_decisions_pkey PRIMARY KEY (decision_id);


--
-- Name: run_repeat_effects run_repeat_effects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_effects
    ADD CONSTRAINT run_repeat_effects_pkey PRIMARY KEY (run_id, effect_kind, entity_id);


--
-- Name: run_repeat_executions run_repeat_executions_execution_id_occurrence_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_execution_id_occurrence_id_key UNIQUE (execution_id, occurrence_id);


--
-- Name: run_repeat_executions run_repeat_executions_execution_id_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_execution_id_run_id_key UNIQUE (execution_id, run_id);


--
-- Name: run_repeat_executions run_repeat_executions_execution_id_run_id_occurrence_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_execution_id_run_id_occurrence_key_key UNIQUE (execution_id, run_id, occurrence_key);


--
-- Name: run_repeat_executions run_repeat_executions_execution_id_slot_id_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_execution_id_slot_id_run_id_key UNIQUE (execution_id, slot_id, run_id);


--
-- Name: run_repeat_executions run_repeat_executions_execution_id_slot_id_technical_attemp_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_execution_id_slot_id_technical_attemp_key UNIQUE (execution_id, slot_id, technical_attempt);


--
-- Name: run_repeat_executions run_repeat_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_pkey PRIMARY KEY (execution_id);


--
-- Name: run_repeat_executions run_repeat_executions_previous_execution_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_previous_execution_id_key UNIQUE (previous_execution_id);


--
-- Name: run_repeat_executions run_repeat_executions_slot_id_technical_attempt_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_slot_id_technical_attempt_key UNIQUE (slot_id, technical_attempt);


--
-- Name: run_repeat_occurrences run_repeat_occurrences_binding_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT run_repeat_occurrences_binding_id_key UNIQUE (binding_id);


--
-- Name: run_repeat_occurrences run_repeat_occurrences_occurrence_id_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT run_repeat_occurrences_occurrence_id_run_id_key UNIQUE (occurrence_id, run_id);


--
-- Name: run_repeat_occurrences run_repeat_occurrences_occurrence_id_run_id_workflow_versio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT run_repeat_occurrences_occurrence_id_run_id_workflow_versio_key UNIQUE (occurrence_id, run_id, workflow_version_id, block_id, occurrence_index);


--
-- Name: run_repeat_occurrences run_repeat_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT run_repeat_occurrences_pkey PRIMARY KEY (occurrence_id);


--
-- Name: run_repeat_occurrences run_repeat_occurrences_run_id_workflow_version_id_block_id__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT run_repeat_occurrences_run_id_workflow_version_id_block_id__key UNIQUE (run_id, workflow_version_id, block_id, occurrence_index);


--
-- Name: run_repeat_resolutions run_repeat_resolutions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_resolutions
    ADD CONSTRAINT run_repeat_resolutions_pkey PRIMARY KEY (run_id, occurrence_key, workflow_node_id);


--
-- Name: run_repeat_results run_repeat_results_execution_id_occurrence_id_result_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_results
    ADD CONSTRAINT run_repeat_results_execution_id_occurrence_id_result_digest_key UNIQUE (execution_id, occurrence_id, result_digest);


--
-- Name: run_repeat_results run_repeat_results_execution_id_result_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_results
    ADD CONSTRAINT run_repeat_results_execution_id_result_digest_key UNIQUE (execution_id, result_digest);


--
-- Name: run_repeat_results run_repeat_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_results
    ADD CONSTRAINT run_repeat_results_pkey PRIMARY KEY (execution_id);


--
-- Name: run_repeat_results run_repeat_results_run_id_execution_id_result_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_results
    ADD CONSTRAINT run_repeat_results_run_id_execution_id_result_digest_key UNIQUE (run_id, execution_id, result_digest);


--
-- Name: run_repeat_slots run_repeat_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_slots
    ADD CONSTRAINT run_repeat_slots_pkey PRIMARY KEY (slot_id);


--
-- Name: run_repeat_slots run_repeat_slots_slot_id_input_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_slots
    ADD CONSTRAINT run_repeat_slots_slot_id_input_digest_key UNIQUE (slot_id, input_digest);


--
-- Name: run_repeat_slots run_repeat_slots_slot_id_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_slots
    ADD CONSTRAINT run_repeat_slots_slot_id_run_id_key UNIQUE (slot_id, run_id);


--
-- Name: run_repeat_slots run_repeat_slots_slot_id_run_id_occurrence_key_workflow_nod_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_slots
    ADD CONSTRAINT run_repeat_slots_slot_id_run_id_occurrence_key_workflow_nod_key UNIQUE (slot_id, run_id, occurrence_key, workflow_node_id);


--
-- Name: run_subagent_backfill_state run_subagent_backfill_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_backfill_state
    ADD CONSTRAINT run_subagent_backfill_state_pkey PRIMARY KEY (execution_id);


--
-- Name: run_subagent_command_receipts run_subagent_command_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_command_receipts
    ADD CONSTRAINT run_subagent_command_receipts_pkey PRIMARY KEY (id);


--
-- Name: run_subagent_command_receipts run_subagent_command_receipts_principal_id_operation_comman_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_command_receipts
    ADD CONSTRAINT run_subagent_command_receipts_principal_id_operation_comman_key UNIQUE (principal_id, operation, command_id);


--
-- Name: run_subagent_items run_subagent_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_items
    ADD CONSTRAINT run_subagent_items_pkey PRIMARY KEY (subagent_id, kind, id);


--
-- Name: run_subagent_items run_subagent_items_subagent_id_kind_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_items
    ADD CONSTRAINT run_subagent_items_subagent_id_kind_ordinal_key UNIQUE (subagent_id, kind, ordinal);


--
-- Name: run_subagent_lifecycle run_subagent_lifecycle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_lifecycle
    ADD CONSTRAINT run_subagent_lifecycle_pkey PRIMARY KEY (subagent_id, execution_id, sequence);


--
-- Name: run_subagent_message_roles run_subagent_message_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_message_roles
    ADD CONSTRAINT run_subagent_message_roles_pkey PRIMARY KEY (execution_id, native_session_id, native_message_id);


--
-- Name: run_subagent_pending_events run_subagent_pending_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_pending_events
    ADD CONSTRAINT run_subagent_pending_events_pkey PRIMARY KEY (execution_id, sequence);


--
-- Name: run_subagent_projection_queue run_subagent_projection_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_projection_queue
    ADD CONSTRAINT run_subagent_projection_queue_pkey PRIMARY KEY (execution_id);


--
-- Name: run_subagent_sources run_subagent_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_sources
    ADD CONSTRAINT run_subagent_sources_pkey PRIMARY KEY (subagent_id, execution_id, sequence);


--
-- Name: run_subagents run_subagents_parent_execution_id_native_mode_parent_native_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagents
    ADD CONSTRAINT run_subagents_parent_execution_id_native_mode_parent_native_key UNIQUE (parent_execution_id, native_mode, parent_native_session_id, provider_child_id);


--
-- Name: run_subagents run_subagents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagents
    ADD CONSTRAINT run_subagents_pkey PRIMARY KEY (id);


--
-- Name: run_work_activations run_work_activations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_activations
    ADD CONSTRAINT run_work_activations_pkey PRIMARY KEY (activation_id);


--
-- Name: run_work_activations run_work_activations_run_id_activation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_activations
    ADD CONSTRAINT run_work_activations_run_id_activation_id_key UNIQUE (run_id, activation_id);


--
-- Name: run_work_activations run_work_activations_run_id_activation_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_activations
    ADD CONSTRAINT run_work_activations_run_id_activation_sequence_key UNIQUE (run_id, activation_sequence);


--
-- Name: run_work_activations run_work_activations_run_id_cause_kind_cause_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_activations
    ADD CONSTRAINT run_work_activations_run_id_cause_kind_cause_id_key UNIQUE (run_id, cause_kind, cause_id);


--
-- Name: run_work_connection_usage run_work_connection_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_connection_usage
    ADD CONSTRAINT run_work_connection_usage_pkey PRIMARY KEY (run_id, workflow_version_id, relationship_id);


--
-- Name: run_work_denials run_work_denials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_denials
    ADD CONSTRAINT run_work_denials_pkey PRIMARY KEY (denial_id);


--
-- Name: run_work_denials run_work_denials_run_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_denials
    ADD CONSTRAINT run_work_denials_run_id_request_id_key UNIQUE (run_id, request_id);


--
-- Name: run_work_denials run_work_denials_run_id_requester_execution_id_relationship_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_denials
    ADD CONSTRAINT run_work_denials_run_id_requester_execution_id_relationship_key UNIQUE (run_id, requester_execution_id, relationship_id);


--
-- Name: run_work_direction_responses run_work_direction_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_direction_responses
    ADD CONSTRAINT run_work_direction_responses_pkey PRIMARY KEY (interaction_id);


--
-- Name: run_work_direction_waits run_work_direction_waits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_direction_waits
    ADD CONSTRAINT run_work_direction_waits_pkey PRIMARY KEY (run_id);


--
-- Name: run_work_join_dispatches run_work_join_dispatches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_join_dispatches
    ADD CONSTRAINT run_work_join_dispatches_pkey PRIMARY KEY (run_id, activation_id);


--
-- Name: run_work_notices run_work_notices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_notices
    ADD CONSTRAINT run_work_notices_pkey PRIMARY KEY (notice_id);


--
-- Name: run_work_notices run_work_notices_run_id_cause_kind_cause_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_notices
    ADD CONSTRAINT run_work_notices_run_id_cause_kind_cause_id_key UNIQUE (run_id, cause_kind, cause_id);


--
-- Name: run_work_notices run_work_notices_run_id_continuation_activation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_notices
    ADD CONSTRAINT run_work_notices_run_id_continuation_activation_id_key UNIQUE (run_id, continuation_activation_id);


--
-- Name: run_work_requests run_work_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_requests
    ADD CONSTRAINT run_work_requests_pkey PRIMARY KEY (request_id);


--
-- Name: run_work_requests run_work_requests_run_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_requests
    ADD CONSTRAINT run_work_requests_run_id_request_id_key UNIQUE (run_id, request_id);


--
-- Name: run_work_requests run_work_requests_run_id_requester_execution_id_relationshi_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_requests
    ADD CONSTRAINT run_work_requests_run_id_requester_execution_id_relationshi_key UNIQUE (run_id, requester_execution_id, relationship_id);


--
-- Name: run_work_requests run_work_requests_run_id_workflow_version_id_relationship_i_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_requests
    ADD CONSTRAINT run_work_requests_run_id_workflow_version_id_relationship_i_key UNIQUE (run_id, workflow_version_id, relationship_id, ordinal);


--
-- Name: run_work_results run_work_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_results
    ADD CONSTRAINT run_work_results_pkey PRIMARY KEY (execution_id);


--
-- Name: run_work_results run_work_results_run_id_activation_id_execution_id_result_d_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_results
    ADD CONSTRAINT run_work_results_run_id_activation_id_execution_id_result_d_key UNIQUE (run_id, activation_id, execution_id, result_digest);


--
-- Name: run_work_results run_work_results_run_id_execution_id_result_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_results
    ADD CONSTRAINT run_work_results_run_id_execution_id_result_digest_key UNIQUE (run_id, execution_id, result_digest);


--
-- Name: run_work_returns run_work_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_returns
    ADD CONSTRAINT run_work_returns_pkey PRIMARY KEY (return_id);


--
-- Name: run_work_returns run_work_returns_run_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_returns
    ADD CONSTRAINT run_work_returns_run_id_request_id_key UNIQUE (run_id, request_id);


--
-- Name: run_work_returns run_work_returns_run_id_requester_continuation_activation_i_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_returns
    ADD CONSTRAINT run_work_returns_run_id_requester_continuation_activation_i_key UNIQUE (run_id, requester_continuation_activation_id);


--
-- Name: run_work_unresolved run_work_unresolved_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_unresolved
    ADD CONSTRAINT run_work_unresolved_pkey PRIMARY KEY (unresolved_id);


--
-- Name: run_worktrees run_worktrees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_worktrees
    ADD CONSTRAINT run_worktrees_pkey PRIMARY KEY (run_id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);


--
-- Name: source_approvals source_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_approvals
    ADD CONSTRAINT source_approvals_pkey PRIMARY KEY (approved_source_id);


--
-- Name: source_approvals source_approvals_requested_by_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_approvals
    ADD CONSTRAINT source_approvals_requested_by_command_id_key UNIQUE (requested_by, command_id);


--
-- Name: source_approvals source_approvals_snapshot_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_approvals
    ADD CONSTRAINT source_approvals_snapshot_id_key UNIQUE (snapshot_id);


--
-- Name: source_execution_materializations source_execution_materializations_execution_id_attempt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_execution_materializations
    ADD CONSTRAINT source_execution_materializations_execution_id_attempt_id_key UNIQUE (execution_id, attempt_id);


--
-- Name: source_execution_materializations source_execution_materializations_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_execution_materializations
    ADD CONSTRAINT source_execution_materializations_operation_id_key UNIQUE (operation_id);


--
-- Name: source_execution_materializations source_execution_materializations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_execution_materializations
    ADD CONSTRAINT source_execution_materializations_pkey PRIMARY KEY (materialization_id);


--
-- Name: source_preparation_reconciliations source_preparation_reconciliations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_preparation_reconciliations
    ADD CONSTRAINT source_preparation_reconciliations_pkey PRIMARY KEY (operation_id);


--
-- Name: source_preparation_reconciliations source_preparation_reconciliations_reconciliation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_preparation_reconciliations
    ADD CONSTRAINT source_preparation_reconciliations_reconciliation_id_key UNIQUE (reconciliation_id);


--
-- Name: source_root_bindings source_root_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_root_bindings
    ADD CONSTRAINT source_root_bindings_pkey PRIMARY KEY (root_id, binding_revision);


--
-- Name: source_root_catalog source_root_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_root_catalog
    ADD CONSTRAINT source_root_catalog_pkey PRIMARY KEY (root_id);


--
-- Name: source_root_catalog source_root_catalog_scope_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_root_catalog
    ADD CONSTRAINT source_root_catalog_scope_hash_key UNIQUE (scope_hash);


--
-- Name: source_snapshot_uses source_snapshot_uses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshot_uses
    ADD CONSTRAINT source_snapshot_uses_pkey PRIMARY KEY (use_id, snapshot_id);


--
-- Name: source_snapshots source_snapshots_approved_source_id_snapshot_id_manifest_di_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_approved_source_id_snapshot_id_manifest_di_key UNIQUE (approved_source_id, snapshot_id, manifest_digest);


--
-- Name: source_snapshots source_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_pkey PRIMARY KEY (snapshot_id);


--
-- Name: source_snapshots source_snapshots_workspace_id_snapshot_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_workspace_id_snapshot_id_key UNIQUE (workspace_id, snapshot_id);


--
-- Name: source_storage_reservations source_storage_reservations_owner_kind_owner_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_storage_reservations
    ADD CONSTRAINT source_storage_reservations_owner_kind_owner_id_key UNIQUE (owner_kind, owner_id);


--
-- Name: source_storage_reservations source_storage_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_storage_reservations
    ADD CONSTRAINT source_storage_reservations_pkey PRIMARY KEY (reservation_id);


--
-- Name: harness_executions tick_execution_outside; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.harness_executions
    ADD CONSTRAINT tick_execution_outside CHECK (((NOT (tick_index IS DISTINCT FROM ((record #>> '{input,tick,index}'::text[]))::integer)) AND ((tick_index IS NULL) OR ((tick_index > 0) AND (repeat_occurrence_id IS NULL) AND (work_activation_id IS NULL))))) NOT VALID;


--
-- Name: run_repeat_slots tick_slot_outside; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.run_repeat_slots
    ADD CONSTRAINT tick_slot_outside CHECK (((NOT (tick_index IS DISTINCT FROM (((input_json)::jsonb #>> '{tick,index}'::text[]))::integer)) AND ((tick_index IS NULL) OR ((tick_index > 0) AND (occurrence_id IS NULL) AND (work_activation_id IS NULL))))) NOT VALID;


--
-- Name: worker_credential_bindings worker_credential_bindings_execution_id_principal_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_credential_bindings
    ADD CONSTRAINT worker_credential_bindings_execution_id_principal_id_key UNIQUE (execution_id, principal_id);


--
-- Name: worker_credential_bindings worker_credential_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_credential_bindings
    ADD CONSTRAINT worker_credential_bindings_pkey PRIMARY KEY (principal_id);


--
-- Name: workflow_job_executions workflow_job_executions_job_execution_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_job_executions
    ADD CONSTRAINT workflow_job_executions_job_execution_id_key UNIQUE (job_execution_id);


--
-- Name: workflow_job_executions workflow_job_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_job_executions
    ADD CONSTRAINT workflow_job_executions_pkey PRIMARY KEY (run_id, node_execution_id);


--
-- Name: workflow_job_preparations workflow_job_preparations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_job_preparations
    ADD CONSTRAINT workflow_job_preparations_pkey PRIMARY KEY (slot_id);


--
-- Name: workflow_native_entries workflow_native_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_native_entries
    ADD CONSTRAINT workflow_native_entries_pkey PRIMARY KEY (execution_id);


--
-- Name: workflow_native_proofs workflow_native_proofs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_native_proofs
    ADD CONSTRAINT workflow_native_proofs_pkey PRIMARY KEY (proof_id);


--
-- Name: workflows workflow_order_position_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflow_order_position_unique UNIQUE (workspace_id, order_position) DEFERRABLE;


--
-- Name: workflow_schedule_authorities workflow_schedule_authorities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedule_authorities
    ADD CONSTRAINT workflow_schedule_authorities_pkey PRIMARY KEY (workflow_id);


--
-- Name: workflow_schedule_occurrences workflow_schedule_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedule_occurrences
    ADD CONSTRAINT workflow_schedule_occurrences_pkey PRIMARY KEY (id);


--
-- Name: workflow_schedule_occurrences workflow_schedule_occurrences_workflow_id_due_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedule_occurrences
    ADD CONSTRAINT workflow_schedule_occurrences_workflow_id_due_at_key UNIQUE (workflow_id, due_at);


--
-- Name: workflow_schedules workflow_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedules
    ADD CONSTRAINT workflow_schedules_pkey PRIMARY KEY (workflow_id);


--
-- Name: workflow_schedules workflow_schedules_workspace_id_workflow_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedules
    ADD CONSTRAINT workflow_schedules_workspace_id_workflow_id_key UNIQUE (workspace_id, workflow_id);


--
-- Name: workflow_stop_intents workflow_stop_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_stop_intents
    ADD CONSTRAINT workflow_stop_intents_pkey PRIMARY KEY (principal_id, command_id);


--
-- Name: workflow_trigger_jobs workflow_trigger_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_trigger_jobs
    ADD CONSTRAINT workflow_trigger_jobs_pkey PRIMARY KEY (id);


--
-- Name: workflow_triggers workflow_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_triggers
    ADD CONSTRAINT workflow_triggers_pkey PRIMARY KEY (workflow_id);


--
-- Name: workflow_versions workflow_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_pkey PRIMARY KEY (id);


--
-- Name: workflow_versions workflow_versions_workflow_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_workflow_id_version_key UNIQUE (workflow_id, version);


--
-- Name: workflows workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);


--
-- Name: workspace_project_provisioning workspace_project_provisioning_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_project_provisioning
    ADD CONSTRAINT workspace_project_provisioning_pkey PRIMARY KEY (id);


--
-- Name: workspace_project_provisioning workspace_project_provisioning_staging_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_project_provisioning
    ADD CONSTRAINT workspace_project_provisioning_staging_path_key UNIQUE (staging_path);


--
-- Name: workspace_repository_imports workspace_repository_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_repository_imports
    ADD CONSTRAINT workspace_repository_imports_pkey PRIMARY KEY (import_id);


--
-- Name: workspace_repository_imports workspace_repository_imports_principal_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_repository_imports
    ADD CONSTRAINT workspace_repository_imports_principal_id_command_id_key UNIQUE (principal_id, command_id);


--
-- Name: workspace_root_host_configuration_heads workspace_root_host_configuration_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_root_host_configuration_heads
    ADD CONSTRAINT workspace_root_host_configuration_heads_pkey PRIMARY KEY (host_scope);


--
-- Name: workspace_root_host_configurations workspace_root_host_configurations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_root_host_configurations
    ADD CONSTRAINT workspace_root_host_configurations_pkey PRIMARY KEY (host_scope, configuration_revision);


--
-- Name: workspace_root_policies workspace_root_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_root_policies
    ADD CONSTRAINT workspace_root_policies_pkey PRIMARY KEY (root_policy_id, root_policy_revision);


--
-- Name: workspace_root_policy_heads workspace_root_policy_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_root_policy_heads
    ADD CONSTRAINT workspace_root_policy_heads_pkey PRIMARY KEY (workspace_id, host_scope);


--
-- Name: workspace_skill_versions workspace_skill_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_skill_versions
    ADD CONSTRAINT workspace_skill_versions_pkey PRIMARY KEY (workspace_id, skill_id, version);


--
-- Name: workspace_skills workspace_skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_skills
    ADD CONSTRAINT workspace_skills_pkey PRIMARY KEY (workspace_id, skill_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: agents_active_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_active_workspace_idx ON public.agents USING btree (workspace_id, id) WHERE (archived_at IS NULL);


--
-- Name: bug_reports_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bug_reports_recent_idx ON public.bug_reports USING btree (created_at DESC, id DESC);


--
-- Name: bug_reports_title_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bug_reports_title_idx ON public.bug_reports USING btree (workspace_id, title_key);


--
-- Name: bug_reports_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bug_reports_workspace_idx ON public.bug_reports USING btree (workspace_id, status, severity, created_at DESC, id DESC);


--
-- Name: ci_gate_test_files_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_gate_test_files_idx ON public.ci_runs USING gin (((test_results -> 'files'::text)) jsonb_path_ops) WHERE (((record ->> 'gate'::text) = 'true'::text) AND (state = ANY (ARRAY['passed'::text, 'failed'::text])));


--
-- Name: ci_group_requesters_execution_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_group_requesters_execution_idx ON public.ci_group_requesters USING btree (workspace_id, execution_id) WHERE (execution_id IS NOT NULL);


--
-- Name: ci_group_requesters_identity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ci_group_requesters_identity_idx ON public.ci_group_requesters USING btree (group_id, principal_id, COALESCE(execution_id, ''::text));


--
-- Name: ci_group_requesters_principal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_group_requesters_principal_idx ON public.ci_group_requesters USING btree (workspace_id, principal_id);


--
-- Name: ci_passed_gate_integration_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_passed_gate_integration_idx ON public.ci_runs USING btree (created_at DESC) WHERE ((state = 'passed'::text) AND ((record ->> 'suite'::text) = 'integration'::text) AND ((record ->> 'gate'::text) = 'true'::text) AND ((record ->> 'finishedAt'::text) IS NOT NULL));


--
-- Name: ci_request_groups_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_request_groups_key_idx ON public.ci_request_groups USING btree (workspace_id, request_key, created_at DESC);


--
-- Name: ci_runs_active_computer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_active_computer_idx ON public.ci_runs USING btree (host_key) WHERE (state = ANY (ARRAY['starting'::text, 'running'::text]));


--
-- Name: ci_runs_failed_gate_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_failed_gate_group_idx ON public.ci_runs USING btree (group_id) WHERE ((state = ANY (ARRAY['failed'::text, 'lost'::text])) AND ((record ->> 'gate'::text) = 'true'::text));


--
-- Name: ci_runs_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_group_idx ON public.ci_runs USING btree (workspace_id, group_id, created_at, id);


--
-- Name: ci_runs_initiating_execution_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_initiating_execution_idx ON public.ci_runs USING btree (workspace_id, ((record #>> '{initiator,executionId}'::text[])));


--
-- Name: ci_runs_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_queue_idx ON public.ci_runs USING btree (state, created_at, id);


--
-- Name: ci_runs_recovery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_recovery_idx ON public.ci_runs USING btree (id) WHERE ((state = ANY (ARRAY['starting'::text, 'running'::text])) OR ((record ->> 'collection'::text) = 'pending'::text) OR ((state = ANY (ARRAY['passed'::text, 'failed'::text, 'canceled'::text, 'lost'::text])) AND ((record #>> '{observation,status}'::text[]) = 'unavailable'::text)));


--
-- Name: ci_runs_requester_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_requester_history_idx ON public.ci_runs USING btree (workspace_id, ((record #>> '{initiator,principalId}'::text[])), created_at DESC) INCLUDE (group_id);


--
-- Name: ci_runs_retained_executor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_retained_executor_idx ON public.ci_runs USING btree (host_key) WHERE ((record #>> '{deadlineExceeded,executor}'::text[]) = 'retained'::text);


--
-- Name: ci_runs_terminal_computer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_terminal_computer_idx ON public.ci_runs USING gin (((record #> '{computer,hostRef}'::text[])) jsonb_path_ops) WHERE (state = ANY (ARRAY['passed'::text, 'failed'::text, 'canceled'::text, 'lost'::text]));


--
-- Name: ci_runs_terminal_execution_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_terminal_execution_history_idx ON public.ci_runs USING gin (((record -> 'executionHistory'::text)) jsonb_path_ops) WHERE (state = ANY (ARRAY['passed'::text, 'failed'::text, 'canceled'::text, 'lost'::text]));


--
-- Name: ci_runs_terminal_failed_computer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_terminal_failed_computer_idx ON public.ci_runs USING gin (((record #> '{setupRetry,failedComputer}'::text[])) jsonb_path_ops) WHERE (state = ANY (ARRAY['passed'::text, 'failed'::text, 'canceled'::text, 'lost'::text]));


--
-- Name: ci_runs_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runs_workspace_idx ON public.ci_runs USING btree (workspace_id, created_at DESC);


--
-- Name: ci_runtime_preparation_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ci_runtime_preparation_owner ON public.ci_runtime_preparations USING btree (device_id) WHERE active;


--
-- Name: ci_runtime_preparation_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ci_runtime_preparation_workspace ON public.ci_runtime_preparations USING btree (workspace_id, device_id, created_at DESC);


--
-- Name: claude_callback_tool_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX claude_callback_tool_idx ON public.claude_callback_receipts USING btree (owner_key, ((record #>> '{identity,nativeSessionId}'::text[])), ((record #>> '{identity,nativeMessageId}'::text[])), ((record #>> '{identity,generation}'::text[])), ((record #>> '{identity,toolUseId}'::text[])));


--
-- Name: durable_interactions_delivery_recovery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX durable_interactions_delivery_recovery_idx ON public.durable_interactions USING btree (delivery_lease_expires_at, id) WHERE (status = 'delivery_pending'::text);


--
-- Name: durable_interactions_execution_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX durable_interactions_execution_latest_idx ON public.durable_interactions USING btree (execution_id, created_at DESC, id DESC);


--
-- Name: durable_interactions_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX durable_interactions_scope_idx ON public.durable_interactions USING btree (workspace_id, workflow_id, status, created_at, id);


--
-- Name: eng05_exec_run_node_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eng05_exec_run_node_page ON public.harness_executions USING btree (run_id, workflow_node_id, created_at DESC, id DESC);


--
-- Name: eng05_exec_run_occurrence_node_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eng05_exec_run_occurrence_node_page ON public.harness_executions USING btree (run_id, repeat_occurrence_id, workflow_node_id, created_at DESC, id DESC);


--
-- Name: eng05_exec_run_occurrence_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eng05_exec_run_occurrence_page ON public.harness_executions USING btree (run_id, repeat_occurrence_id, created_at DESC, id DESC);


--
-- Name: eng05_exec_run_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eng05_exec_run_page ON public.harness_executions USING btree (run_id, created_at DESC, id DESC);


--
-- Name: eng05_execution_bindings_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eng05_execution_bindings_page ON public.run_repeat_bindings USING btree (run_id, recipient_execution_id, ordinal);


--
-- Name: execution_native_closures_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX execution_native_closures_latest_idx ON public.execution_native_closures USING btree (execution_id, generation DESC);


--
-- Name: execution_native_recoveries_execution; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX execution_native_recoveries_execution ON public.execution_native_recoveries USING btree (execution_id, generation);


--
-- Name: file_job_execution_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_job_execution_idx ON public.files USING btree (workspace_id, job_execution_id, created_at, file_id) WHERE (scope_kind = 'job_execution'::text);


--
-- Name: file_job_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_job_expiry_idx ON public.files USING btree (expires_at, file_id) WHERE ((scope_kind = 'job_execution'::text) AND (state = ANY (ARRAY['pending'::text, 'ready'::text])));


--
-- Name: file_job_output_publication_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX file_job_output_publication_idx ON public.file_tool_publications USING btree (binding, ((record ->> 'path'::text))) WHERE ((record ->> 'kind'::text) = 'job_execution'::text);


--
-- Name: file_tool_artifacts_binding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_tool_artifacts_binding_idx ON public.file_tool_artifacts USING btree (binding);


--
-- Name: file_tool_publications_binding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_tool_publications_binding_idx ON public.file_tool_publications USING btree (binding);


--
-- Name: file_tool_read_provenance_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_tool_read_provenance_run_idx ON public.file_tool_read_provenance USING btree (run_id, execution_id);


--
-- Name: files_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_conversation_idx ON public.files USING btree (conversation_id, created_at, file_id) WHERE (scope_kind = 'temporary'::text);


--
-- Name: files_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_expiry_idx ON public.files USING btree (expires_at, file_id) WHERE ((scope_kind = 'temporary'::text) AND (state = ANY (ARRAY['pending'::text, 'ready'::text])));


--
-- Name: files_live_retention_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_live_retention_owner_idx ON public.files USING btree (owner_principal_id, expires_at, file_id) WHERE ((scope_kind = 'temporary'::text) AND (state = ANY (ARRAY['pending'::text, 'ready'::text])));


--
-- Name: files_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_owner_idx ON public.files USING btree (owner_principal_id, file_id);


--
-- Name: files_reference_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_reference_idx ON public.files USING btree (scope_kind, workspace_id, workflow_id, created_at, file_id) WHERE (scope_kind = ANY (ARRAY['workflow_reference'::text, 'workspace_reference'::text]));


--
-- Name: graph_edit_intents_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX graph_edit_intents_one_open ON public.graph_edit_intents USING btree (principal_id, workspace_id, workflow_id) WHERE (state <> ALL (ARRAY['saved'::text, 'discarded'::text]));


--
-- Name: graph_edit_intents_owner_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX graph_edit_intents_owner_scope ON public.graph_edit_intents USING btree (principal_id, workspace_id, workflow_id, created_at DESC, id);


--
-- Name: harness_executions_legacy_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX harness_executions_legacy_attempt ON public.harness_executions USING btree (run_id, workflow_node_id, attempt) WHERE ((repeat_occurrence_id IS NULL) AND (work_activation_id IS NULL) AND (tick_index IS NULL));


--
-- Name: harness_executions_repeat_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX harness_executions_repeat_attempt ON public.harness_executions USING btree (run_id, repeat_occurrence_id, workflow_node_id, attempt) WHERE (repeat_occurrence_id IS NOT NULL);


--
-- Name: harness_executions_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harness_executions_run_idx ON public.harness_executions USING btree (run_id, created_at);


--
-- Name: harness_executions_tick_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX harness_executions_tick_attempt ON public.harness_executions USING btree (run_id, workflow_node_id, tick_index, attempt) WHERE (tick_index IS NOT NULL);


--
-- Name: harness_executions_work_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX harness_executions_work_attempt ON public.harness_executions USING btree (run_id, work_activation_id, workflow_node_id, attempt) WHERE (work_activation_id IS NOT NULL);


--
-- Name: harness_instance_profile_evidence_instance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harness_instance_profile_evidence_instance_idx ON public.harness_instance_profile_evidence USING btree (instance_id, instance_revision, created_at DESC);


--
-- Name: harness_instance_settings_host_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harness_instance_settings_host_idx ON public.harness_instance_settings USING btree (host_key, application_installation_id, instance_id, revision DESC);


--
-- Name: harness_mcp_plans_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harness_mcp_plans_status_idx ON public.harness_mcp_change_plans USING btree (harness, status, created_at DESC);


--
-- Name: harness_native_activity_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harness_native_activity_latest_idx ON public.harness_native_events USING btree (execution_id, activity_identity, sequence DESC) INCLUDE (activity_finished) WHERE (activity_identity IS NOT NULL);


--
-- Name: harness_native_event_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harness_native_event_time_idx ON public.harness_native_events USING btree (execution_id, occurred_at DESC) WHERE (occurred_at IS NOT NULL);


--
-- Name: host_harness_measurements_binary; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_harness_measurements_binary ON public.host_harness_measurements USING btree (harness, binary_sha256, suite_revision);


--
-- Name: interaction_delivery_attempts_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX interaction_delivery_attempts_open_idx ON public.interaction_delivery_attempts USING btree (interaction_id, attempt DESC) WHERE (state = ANY (ARRAY['submitted'::text, 'uncertain'::text]));


--
-- Name: interaction_delivery_attempts_reconcile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX interaction_delivery_attempts_reconcile_idx ON public.interaction_delivery_attempts USING btree (state, created_at, interaction_id);


--
-- Name: interaction_graph_resumes_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX interaction_graph_resumes_pending_idx ON public.interaction_graph_resumes USING btree (lease_expires_at, interaction_id) WHERE (state = 'pending'::text);


--
-- Name: interaction_graph_resumes_recovery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX interaction_graph_resumes_recovery_idx ON public.interaction_graph_resumes USING btree (lease_expires_at, interaction_id) WHERE (state = ANY (ARRAY['pending'::text, 'resuming'::text, 'blocked'::text]));


--
-- Name: interaction_graph_resumes_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX interaction_graph_resumes_run_idx ON public.interaction_graph_resumes USING btree (run_id, state, interaction_id);


--
-- Name: interaction_reconciliation_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX interaction_reconciliation_history_idx ON public.interaction_reconciliation_evidence USING btree (interaction_id, sequence);


--
-- Name: job_admission_queue_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_admission_queue_pending ON public.job_admission_queue USING btree (enqueue_sequence) WHERE ((record ->> 'state'::text) = ANY (ARRAY['waiting'::text, 'blocked'::text, 'claimed'::text]));


--
-- Name: job_admission_queue_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_admission_queue_workspace ON public.job_admission_queue USING btree (workspace_id, enqueue_sequence DESC);


--
-- Name: job_computer_capacity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_computer_capacity ON public.job_computer_selections USING btree (host_key) WHERE (released_at IS NULL);


--
-- Name: job_execution_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_execution_workspace ON public.job_executions USING btree (workspace_id, id);


--
-- Name: job_input_admission_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX job_input_admission_recipient_idx ON public.management_command_receipts USING btree (((result #>> '{manifest,recipient,executionId}'::text[])), ((result #>> '{manifest,recipient,attemptId}'::text[]))) WHERE (operation = 'job.inputs.bind'::text);


--
-- Name: job_input_admission_transfers_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_input_admission_transfers_idx ON public.management_command_receipts USING gin (((result -> 'transfers'::text)) jsonb_path_ops) WHERE (operation = 'job.inputs.bind'::text);


--
-- Name: job_output_admission_slot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX job_output_admission_slot_idx ON public.management_command_receipts USING btree (((result #>> '{input,executionId}'::text[])), ((result #>> '{input,attemptId}'::text[])), ((result #>> '{input,path}'::text[]))) WHERE (operation = 'job.output.admit'::text);


--
-- Name: job_output_admission_transfer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX job_output_admission_transfer_idx ON public.management_command_receipts USING btree (((result #>> '{intent,transferId}'::text[]))) WHERE (operation = 'job.output.admit'::text);


--
-- Name: job_runtime_native_admission_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX job_runtime_native_admission_lease ON public.job_runtime_qualification_approvals USING btree (((native_admission ->> 'leaseId'::text))) WHERE (native_admission IS NOT NULL);


--
-- Name: local_workflow_native_outputs_execution; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX local_workflow_native_outputs_execution ON public.local_workflow_native_outputs USING btree (execution_id);


--
-- Name: management_audit_command_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX management_audit_command_retry_idx ON public.management_audit USING btree (principal_id, action, ((details ->> 'commandId'::text)), occurred_at DESC) WHERE ((outcome = 'succeeded'::text) OR ((details ->> 'phase'::text) = 'reserved'::text));


--
-- Name: management_audit_principal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX management_audit_principal_idx ON public.management_audit USING btree (principal_id, sequence DESC);


--
-- Name: management_command_transfer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX management_command_transfer_idx ON public.management_command_receipts USING btree (operation, (((result -> 'intent'::text) ->> 'transferId'::text)));


--
-- Name: management_receipts_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX management_receipts_retention_idx ON public.management_command_receipts USING btree (operation, created_at, principal_id, command_id);


--
-- Name: management_worker_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX management_worker_agent_idx ON public.management_principals USING btree (agent_id) WHERE (audience = 'worker'::text);


--
-- Name: native_event_source_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX native_event_source_identity ON public.harness_native_events USING btree (execution_id, connection_id, source_sequence);


--
-- Name: operator_activity_conversation_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_activity_conversation_sequence ON public.operator_conversation_activity USING btree (conversation_id, sequence DESC);


--
-- Name: operator_activity_unresolved_summary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_activity_unresolved_summary_idx ON public.operator_conversation_activity USING btree (conversation_id, ((record ->> 'status'::text))) WHERE (((record ->> 'kind'::text) <> 'thinking'::text) AND ((record ->> 'status'::text) = ANY (ARRAY['pending'::text, 'running'::text, 'unknown'::text])));


--
-- Name: operator_chat_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_chat_owner_idx ON public.operator_conversations USING btree (owner_principal_id, updated_at DESC, id);


--
-- Name: operator_conversations_agent_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_conversations_agent_key_idx ON public.operator_conversations USING btree (agent_key) WHERE ((kind = 'agent'::text) AND (deleted_at IS NULL));


--
-- Name: operator_conversations_fork_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_conversations_fork_request_idx ON public.operator_conversations USING btree (parent_conversation_id, fork_request_id) WHERE (parent_conversation_id IS NOT NULL);


--
-- Name: operator_conversations_native_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_conversations_native_session_idx ON public.operator_conversations USING btree (harness, native_session_id) WHERE (native_session_id IS NOT NULL);


--
-- Name: operator_conversations_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_conversations_recent_idx ON public.operator_conversations USING btree (updated_at DESC, id);


--
-- Name: operator_messages_native_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_messages_native_idx ON public.operator_conversation_messages USING btree (conversation_id, native_message_id) WHERE (native_message_id IS NOT NULL);


--
-- Name: operator_messages_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_messages_request_idx ON public.operator_conversation_messages USING btree (conversation_id, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: operator_turns_agent_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_turns_agent_open_idx ON public.operator_conversation_turns USING btree (conversation_id, turn_sequence) WHERE (delivery = ANY (ARRAY['queued'::text, 'submitting'::text, 'accepted'::text, 'unknown'::text]));


--
-- Name: provider_account_accepted_uses; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_account_accepted_uses ON public.provider_account_accepted_bindings USING btree (account_id) WHERE (account_id IS NOT NULL);


--
-- Name: provider_account_authentication_slot_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_account_authentication_slot_owner ON public.provider_account_authentication_operations USING btree (account_id, target_key) WHERE (NOT native_closed);


--
-- Name: remote_native_artifact_context_slot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX remote_native_artifact_context_slot_idx ON public.management_command_receipts USING btree (target_key) WHERE (operation = 'remote.native-artifact.context'::text);


--
-- Name: remote_native_artifact_output_slot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX remote_native_artifact_output_slot_idx ON public.management_command_receipts USING btree (target_key) WHERE (operation = 'remote.native-artifact.output'::text);


--
-- Name: review_jobs_recovery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX review_jobs_recovery_idx ON public.review_jobs USING btree (reviewer_agent_id, state, lease_expires_at, created_at, id);


--
-- Name: review_native_entries_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX review_native_entries_run ON public.review_native_entries USING btree (run_id, execution_id, job_id);


--
-- Name: review_native_proofs_execution; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX review_native_proofs_execution ON public.review_native_proofs USING btree (run_id, execution_id, job_id, proof_id);


--
-- Name: run_activity_execution_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_activity_execution_time_idx ON public.run_activity USING btree (run_id, harness_execution_id, occurred_at DESC);


--
-- Name: run_activity_reactivation_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_activity_reactivation_once ON public.run_activity USING btree (run_id, ((payload ->> 'activationId'::text))) WHERE (kind = 'work_requester_reactivated'::text);


--
-- Name: run_activity_reroute_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_activity_reroute_once ON public.run_activity USING btree (run_id, ((payload ->> 'requestId'::text))) WHERE (kind = 'work_rerouted'::text);


--
-- Name: run_activity_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_activity_run_idx ON public.run_activity USING btree (run_id, sequence);


--
-- Name: run_activity_worker_ack_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_activity_worker_ack_once ON public.run_activity USING btree (run_id, ((payload ->> 'interactionId'::text))) WHERE (kind = 'interaction_worker_ack'::text);


--
-- Name: run_cleanup_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_cleanup_pending_idx ON public.run_cleanup_intents USING btree (run_id) WHERE pending;


--
-- Name: run_graph_execution_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_graph_execution_current_idx ON public.harness_executions USING btree (run_id, workflow_node_id, id);


--
-- Name: run_graph_execution_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_graph_execution_identity ON public.harness_executions USING btree (run_id, id, workflow_node_id, attempt);


--
-- Name: run_graph_interaction_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_graph_interaction_identity ON public.durable_interactions USING btree (run_id, id);


--
-- Name: run_graph_interaction_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_graph_interaction_open_idx ON public.durable_interactions USING btree (run_id, id) WHERE (status <> ALL (ARRAY['delivered'::text, 'canceled'::text]));


--
-- Name: run_graph_review_host_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_graph_review_host_identity ON public.review_jobs USING btree (id, execution_id);


--
-- Name: run_graph_review_request_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_graph_review_request_identity ON public.review_jobs USING btree (id, execution_id, interaction_id);


--
-- Name: run_graph_review_unsettled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_graph_review_unsettled_idx ON public.review_jobs USING btree (execution_id, id) WHERE (((record ->> 'state'::text) <> 'completed'::text) AND (((record ->> 'state'::text) <> 'failed'::text) OR (((record -> 'cleanup'::text) ->> 'completedAt'::text) IS NULL)));


--
-- Name: run_native_activity_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_native_activity_current_idx ON public.run_native_activity USING btree (run_id, workflow_node_id, execution_id, work_kind, work_id) WHERE ((activity ->> 'status'::text) = ANY (ARRAY['active'::text, 'stale'::text, 'unknown'::text]));


--
-- Name: run_native_activity_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_native_activity_workflow_idx ON public.run_native_activity USING btree (run_id, workflow_node_id) WHERE (work_kind = 'workflow'::text);


--
-- Name: run_repeat_executions_work_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_repeat_executions_work_recent ON public.run_repeat_executions USING btree (run_id, workflow_node_id, work_activation_id, technical_attempt DESC) WHERE (work_activation_id IS NOT NULL);


--
-- Name: run_repeat_occurrences_head; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_repeat_occurrences_head ON public.run_repeat_occurrences USING btree (run_id, block_id, occurrence_index DESC);


--
-- Name: run_repeat_slots_occurrence; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_repeat_slots_occurrence ON public.run_repeat_slots USING btree (occurrence_id, workflow_node_id) WHERE (occurrence_id IS NOT NULL);


--
-- Name: run_repeat_slots_outside; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_repeat_slots_outside ON public.run_repeat_slots USING btree (run_id, workflow_node_id) WHERE ((occurrence_id IS NULL) AND (work_activation_id IS NULL) AND (tick_index IS NULL));


--
-- Name: run_repeat_slots_tick; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_repeat_slots_tick ON public.run_repeat_slots USING btree (run_id, workflow_node_id, tick_index) WHERE (tick_index IS NOT NULL);


--
-- Name: run_repeat_slots_work; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_repeat_slots_work ON public.run_repeat_slots USING btree (run_id, work_activation_id, workflow_node_id) WHERE (work_activation_id IS NOT NULL);


--
-- Name: run_subagent_items_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_subagent_items_page ON public.run_subagent_items USING btree (subagent_id, kind, ordinal);


--
-- Name: run_subagent_lifecycle_spawn_alias; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_subagent_lifecycle_spawn_alias ON public.run_subagent_lifecycle USING btree (execution_id, ((fact ->> 'spawnToolUseId'::text)));


--
-- Name: run_subagent_lifecycle_task_alias; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_subagent_lifecycle_task_alias ON public.run_subagent_lifecycle USING btree (execution_id, ((fact ->> 'taskId'::text)));


--
-- Name: run_subagents_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_subagents_page ON public.run_subagents USING btree (run_id, id);


--
-- Name: run_work_activations_node_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_work_activations_node_recent ON public.run_work_activations USING btree (run_id, workflow_node_id, activation_sequence DESC);


--
-- Name: run_work_notices_run_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_work_notices_run_state ON public.run_work_notices USING btree (run_id, delivery_state, created_at, notice_id);


--
-- Name: run_work_requests_activation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_work_requests_activation ON public.run_work_requests USING btree (run_id, requester_activation_id, accepted_at, request_id);


--
-- Name: run_work_results_activation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_work_results_activation ON public.run_work_results USING btree (run_id, activation_id, accepted_at, execution_id);


--
-- Name: run_work_unresolved_finish; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_work_unresolved_finish ON public.run_work_unresolved USING btree (run_id, execution_id) WHERE (relationship_id IS NULL);


--
-- Name: run_work_unresolved_route; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_work_unresolved_route ON public.run_work_unresolved USING btree (run_id, execution_id, relationship_id) WHERE (relationship_id IS NOT NULL);


--
-- Name: run_work_unresolved_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_work_unresolved_run ON public.run_work_unresolved USING btree (run_id, created_at, unresolved_id);


--
-- Name: runs_board_snapshot_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_board_snapshot_scope_idx ON public.runs USING btree (id, workspace_id, workflow_id, workflow_version_id);


--
-- Name: runs_dropdown_admission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_dropdown_admission_idx ON public.runs USING btree (workspace_id, workflow_id, created_at DESC, id COLLATE "C" DESC);


--
-- Name: runs_workspace_location_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_workspace_location_idx ON public.runs USING btree (workspace_id, location_revision) WHERE (location_revision IS NOT NULL);


--
-- Name: runs_workspace_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_workspace_workflow_idx ON public.runs USING btree (workspace_id, workflow_id, created_at DESC);


--
-- Name: source_preparation_queue_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_preparation_queue_cleanup ON public.source_preparation_reconciliations USING btree (queue_ticket_id) WHERE (queue_ticket_id IS NOT NULL);


--
-- Name: source_snapshot_uses_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_snapshot_uses_snapshot_idx ON public.source_snapshot_uses USING btree (snapshot_id);


--
-- Name: source_storage_reservations_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_storage_reservations_scope_idx ON public.source_storage_reservations USING btree (scope_id, state);


--
-- Name: worker_credential_bindings_execution_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_credential_bindings_execution_idx ON public.worker_credential_bindings USING btree (execution_id, revoked_at);


--
-- Name: worker_credential_bindings_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_credential_bindings_run_idx ON public.worker_credential_bindings USING btree (run_id, principal_id);


--
-- Name: workflow_native_entries_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_native_entries_run ON public.workflow_native_entries USING btree (run_id, execution_id);


--
-- Name: workflow_native_proofs_execution; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_native_proofs_execution ON public.workflow_native_proofs USING btree (run_id, execution_id, proof_id);


--
-- Name: workflow_schedule_inflight_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_schedule_inflight_idx ON public.workflow_schedule_occurrences USING btree (workspace_id, workflow_id, run_id) WHERE (status = 'accepted'::text);


--
-- Name: workflow_schedule_occurrences_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_schedule_occurrences_recent_idx ON public.workflow_schedule_occurrences USING btree (workspace_id, workflow_id, due_at DESC);


--
-- Name: workflow_schedule_workflow_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_schedule_workflow_scope_idx ON public.workflows USING btree (workspace_id, id);


--
-- Name: workflow_schedules_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_schedules_due_idx ON public.workflow_schedules USING btree (next_occurrence_at, workflow_id) WHERE (enabled AND (cleared_at IS NULL) AND (next_occurrence_at IS NOT NULL));


--
-- Name: workflow_stop_intents_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_stop_intents_run ON public.workflow_stop_intents USING btree (run_id, principal_id, command_id);


--
-- Name: workflow_trigger_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_trigger_due_idx ON public.workflow_triggers USING btree (next_fire_at, workflow_id) WHERE enabled;


--
-- Name: workflow_trigger_jobs_expired_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_trigger_jobs_expired_idx ON public.workflow_trigger_jobs USING btree (lease_expires_at, id) WHERE (status = 'leased'::text);


--
-- Name: workflow_trigger_jobs_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_trigger_jobs_ready_idx ON public.workflow_trigger_jobs USING btree (available_at, created_at, id) WHERE (status = 'queued'::text);


--
-- Name: workflows_workspace_id_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflows_workspace_id_page_idx ON public.workflows USING btree (workspace_id, id);


--
-- Name: workspace_repository_import_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_repository_import_pending ON public.workspace_repository_imports USING btree (workspace_id) WHERE (finished_at IS NULL);


--
-- Name: workspace_repository_import_readback; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_repository_import_readback ON public.workspace_repository_imports USING btree (workspace_id, created_at DESC);


--
-- Name: workspace_skill_versions_sequence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_skill_versions_sequence_idx ON public.workspace_skill_versions USING btree (workspace_id, skill_id, sequence);


--
-- Name: review_native_entries a2_entry_monotonic; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a2_entry_monotonic BEFORE DELETE OR UPDATE ON public.review_native_entries FOR EACH ROW EXECUTE FUNCTION public.a2_native_entry_monotonic();


--
-- Name: workflow_native_entries a2_entry_monotonic; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a2_entry_monotonic BEFORE DELETE OR UPDATE ON public.workflow_native_entries FOR EACH ROW EXECUTE FUNCTION public.a2_native_entry_monotonic();


--
-- Name: review_native_entries a2_entry_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a2_entry_no_truncate BEFORE TRUNCATE ON public.review_native_entries FOR EACH STATEMENT EXECUTE FUNCTION public.a2_native_record_immutable();


--
-- Name: workflow_native_entries a2_entry_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a2_entry_no_truncate BEFORE TRUNCATE ON public.workflow_native_entries FOR EACH STATEMENT EXECUTE FUNCTION public.a2_native_record_immutable();


--
-- Name: review_native_entries a2_entry_receipt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER a2_entry_receipt AFTER INSERT OR UPDATE ON public.review_native_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.a2_entry_committed();


--
-- Name: workflow_native_entries a2_entry_receipt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER a2_entry_receipt AFTER INSERT OR UPDATE ON public.workflow_native_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.a2_entry_committed();


--
-- Name: review_native_proofs a2_native_receipt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER a2_native_receipt AFTER INSERT ON public.review_native_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.a2_proof_committed();


--
-- Name: workflow_native_proofs a2_native_receipt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER a2_native_receipt AFTER INSERT ON public.workflow_native_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.a2_proof_committed();


--
-- Name: run_graph_public_projection a2_public_projection_receipt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER a2_public_projection_receipt AFTER INSERT OR UPDATE ON public.run_graph_public_projection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.a2_public_projection_committed();


--
-- Name: review_native_proofs a2_record_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a2_record_immutable BEFORE DELETE OR UPDATE ON public.review_native_proofs FOR EACH ROW EXECUTE FUNCTION public.a2_native_record_immutable();


--
-- Name: workflow_native_proofs a2_record_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a2_record_immutable BEFORE DELETE OR UPDATE ON public.workflow_native_proofs FOR EACH ROW EXECUTE FUNCTION public.a2_native_record_immutable();


--
-- Name: workflow_stop_intents a2_record_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a2_record_immutable BEFORE DELETE OR UPDATE ON public.workflow_stop_intents FOR EACH ROW EXECUTE FUNCTION public.a2_native_record_immutable();


--
-- Name: review_native_proofs a2_record_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a2_record_no_truncate BEFORE TRUNCATE ON public.review_native_proofs FOR EACH STATEMENT EXECUTE FUNCTION public.a2_native_record_immutable();


--
-- Name: workflow_native_proofs a2_record_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a2_record_no_truncate BEFORE TRUNCATE ON public.workflow_native_proofs FOR EACH STATEMENT EXECUTE FUNCTION public.a2_native_record_immutable();


--
-- Name: workflow_stop_intents a2_record_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a2_record_no_truncate BEFORE TRUNCATE ON public.workflow_stop_intents FOR EACH STATEMENT EXECUTE FUNCTION public.a2_native_record_immutable();


--
-- Name: workflow_stop_intents a2_stop_intent_receipt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER a2_stop_intent_receipt AFTER INSERT ON public.workflow_stop_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.a2_stop_intent_committed();


--
-- Name: runs activity_stream_created; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER activity_stream_created AFTER INSERT ON public.runs FOR EACH ROW EXECUTE FUNCTION public.create_run_activity_stream();


--
-- Name: execution_native_placements agent_native_placement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_native_placement BEFORE INSERT ON public.execution_native_placements FOR EACH ROW EXECUTE FUNCTION public.guard_agent_native_placement();


--
-- Name: execution_dispatch_owner_grants agent_owner_grant; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER agent_owner_grant AFTER INSERT ON public.execution_dispatch_owner_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_agent_owner_grant();


--
-- Name: file_artifact_edges artifact_edge_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artifact_edge_immutable BEFORE DELETE OR UPDATE ON public.file_artifact_edges FOR EACH ROW EXECUTE FUNCTION public.artifact_edge_fact_immutable();


--
-- Name: file_artifact_edge_reads artifact_edge_read_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artifact_edge_read_immutable BEFORE DELETE OR UPDATE ON public.file_artifact_edge_reads FOR EACH ROW EXECUTE FUNCTION public.artifact_edge_fact_immutable();


--
-- Name: ci_runs ci_activity_record_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ci_activity_record_revision BEFORE UPDATE ON public.ci_runs FOR EACH ROW EXECUTE FUNCTION public.advance_ci_activity_record_revision();


--
-- Name: ci_runs ci_ticket_changed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ci_ticket_changed AFTER UPDATE ON public.ci_runs FOR EACH ROW WHEN ((((old.record ->> 'state'::text) IS DISTINCT FROM (new.record ->> 'state'::text)) OR ((old.record ->> 'step'::text) IS DISTINCT FROM (new.record ->> 'step'::text)) OR ((old.record ->> 'collection'::text) IS DISTINCT FROM (new.record ->> 'collection'::text)))) EXECUTE FUNCTION public.notify_ci_ticket_changed();


--
-- Name: ci_runs ci_ticket_inserted; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ci_ticket_inserted AFTER INSERT ON public.ci_runs FOR EACH ROW EXECUTE FUNCTION public.notify_ci_ticket_changed();


--
-- Name: management_command_receipts command_activity_record_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER command_activity_record_revision BEFORE UPDATE ON public.management_command_receipts FOR EACH ROW EXECUTE FUNCTION public.advance_activity_record_revision();


--
-- Name: durable_interactions current_approval_interaction_publication; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER current_approval_interaction_publication AFTER INSERT OR UPDATE ON public.durable_interactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.current_approval_requires_publication();


--
-- Name: review_jobs current_approval_review_publication; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER current_approval_review_publication AFTER INSERT OR UPDATE ON public.review_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.current_approval_requires_publication();


--
-- Name: durable_interactions durable_interaction_lifecycle; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER durable_interaction_lifecycle AFTER INSERT OR UPDATE ON public.durable_interactions FOR EACH ROW EXECUTE FUNCTION public.audit_interaction_lifecycle();


--
-- Name: current_workflow_publications eng04_current_publication_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER eng04_current_publication_immutable BEFORE DELETE OR UPDATE ON public.current_workflow_publications FOR EACH ROW EXECUTE FUNCTION public.eng04_repeat_publication_immutable();


--
-- Name: current_workflow_publications eng04_current_publication_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER eng04_current_publication_no_truncate BEFORE TRUNCATE ON public.current_workflow_publications FOR EACH STATEMENT EXECUTE FUNCTION public.eng04_repeat_publication_immutable();


--
-- Name: current_workflow_publications eng04_current_publication_receipt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER eng04_current_publication_receipt AFTER INSERT ON public.current_workflow_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.eng04_current_publication_committed();


--
-- Name: current_workflow_publications eng04_current_publication_validated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER eng04_current_publication_validated BEFORE INSERT ON public.current_workflow_publications FOR EACH ROW EXECUTE FUNCTION public.eng04_check_current_publication();


--
-- Name: repeat_workflow_publications eng04_repeat_publication_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER eng04_repeat_publication_immutable BEFORE DELETE OR UPDATE ON public.repeat_workflow_publications FOR EACH ROW EXECUTE FUNCTION public.eng04_repeat_publication_immutable();


--
-- Name: repeat_workflow_publications eng04_repeat_publication_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER eng04_repeat_publication_no_truncate BEFORE TRUNCATE ON public.repeat_workflow_publications FOR EACH STATEMENT EXECUTE FUNCTION public.eng04_repeat_publication_immutable();


--
-- Name: repeat_workflow_publications eng04_repeat_publication_receipt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER eng04_repeat_publication_receipt AFTER INSERT ON public.repeat_workflow_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.eng04_repeat_publication_committed();


--
-- Name: repeat_workflow_publications eng04_repeat_publication_validated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER eng04_repeat_publication_validated BEFORE INSERT ON public.repeat_workflow_publications FOR EACH ROW EXECUTE FUNCTION public.eng04_check_repeat_publication();


--
-- Name: workflows eng04_repeat_workflow_pin_writer; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER eng04_repeat_workflow_pin_writer BEFORE UPDATE OF current_version_id, id, workspace_id, revision ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.wave25_approval_no_downgrade();


--
-- Name: harness_executions execution_activity_record_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER execution_activity_record_revision BEFORE UPDATE ON public.harness_executions FOR EACH ROW EXECUTE FUNCTION public.advance_activity_record_revision();


--
-- Name: harness_executions execution_dispatch_complete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER execution_dispatch_complete AFTER INSERT ON public.harness_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_execution_dispatch_complete();


--
-- Name: execution_dispatch_intents execution_dispatch_intent_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER execution_dispatch_intent_immutable BEFORE DELETE OR UPDATE ON public.execution_dispatch_intents FOR EACH ROW EXECUTE FUNCTION public.guard_placement_immutable();


--
-- Name: execution_dispatch_intents execution_dispatch_intent_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER execution_dispatch_intent_no_truncate BEFORE TRUNCATE ON public.execution_dispatch_intents FOR EACH STATEMENT EXECUTE FUNCTION public.guard_placement_immutable();


--
-- Name: execution_dispatch_intents execution_dispatch_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER execution_dispatch_owner AFTER INSERT ON public.execution_dispatch_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_dispatch_owner();


--
-- Name: execution_native_closures execution_native_closure_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER execution_native_closure_immutable BEFORE UPDATE ON public.execution_native_closures FOR EACH ROW EXECUTE FUNCTION public.immutable_execution_native_closure();


--
-- Name: execution_native_placements execution_native_placement_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER execution_native_placement_immutable BEFORE DELETE OR UPDATE ON public.execution_native_placements FOR EACH ROW EXECUTE FUNCTION public.guard_placement_immutable();


--
-- Name: execution_native_placements execution_native_placement_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER execution_native_placement_no_truncate BEFORE TRUNCATE ON public.execution_native_placements FOR EACH STATEMENT EXECUTE FUNCTION public.guard_placement_immutable();


--
-- Name: execution_native_recoveries execution_native_recovery_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER execution_native_recovery_guard BEFORE INSERT OR DELETE OR UPDATE ON public.execution_native_recoveries FOR EACH ROW EXECUTE FUNCTION public.guard_execution_native_recovery();


--
-- Name: execution_native_recoveries execution_native_recovery_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER execution_native_recovery_no_truncate BEFORE TRUNCATE ON public.execution_native_recoveries FOR EACH STATEMENT EXECUTE FUNCTION public.guard_execution_native_recovery();


--
-- Name: files file_activity_record_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_activity_record_revision BEFORE UPDATE ON public.files FOR EACH ROW EXECUTE FUNCTION public.advance_activity_record_revision();


--
-- Name: files file_reference_immutable_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_reference_immutable_identity BEFORE DELETE OR UPDATE ON public.files FOR EACH ROW EXECUTE FUNCTION public.file_reference_immutable_identity();


--
-- Name: file_revisions file_revision_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_revision_immutable BEFORE DELETE OR UPDATE ON public.file_revisions FOR EACH ROW EXECUTE FUNCTION public.file_revision_immutable();


--
-- Name: file_tool_copy_receipts file_tool_copy_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_tool_copy_immutable BEFORE DELETE OR UPDATE ON public.file_tool_copy_receipts FOR EACH ROW EXECUTE FUNCTION public.file_tool_fact_immutable();


--
-- Name: file_tool_publications file_tool_publication_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_tool_publication_immutable BEFORE DELETE OR UPDATE ON public.file_tool_publications FOR EACH ROW EXECUTE FUNCTION public.file_tool_fact_immutable();


--
-- Name: file_tool_read_provenance file_tool_read_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_tool_read_immutable BEFORE DELETE OR UPDATE ON public.file_tool_read_provenance FOR EACH ROW EXECUTE FUNCTION public.file_tool_fact_immutable();


--
-- Name: graph_edit_intents graph_edit_intents_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graph_edit_intents_immutable BEFORE UPDATE ON public.graph_edit_intents FOR EACH ROW EXECUTE FUNCTION public.protect_graph_edit_intent();


--
-- Name: run_cleanup_intents graphql_live_cleanup; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graphql_live_cleanup AFTER INSERT OR UPDATE OF pending ON public.run_cleanup_intents FOR EACH ROW EXECUTE FUNCTION public.graphql_live_cleanup_trigger();


--
-- Name: harness_executions graphql_live_execution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graphql_live_execution AFTER INSERT OR UPDATE OF record ON public.harness_executions FOR EACH ROW EXECUTE FUNCTION public.graphql_live_execution_trigger();


--
-- Name: durable_interactions graphql_live_interaction; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graphql_live_interaction AFTER INSERT OR UPDATE OF record ON public.durable_interactions FOR EACH ROW EXECUTE FUNCTION public.graphql_live_interaction_trigger();


--
-- Name: review_jobs graphql_live_review; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graphql_live_review AFTER INSERT OR UPDATE OF record ON public.review_jobs FOR EACH ROW EXECUTE FUNCTION public.graphql_live_review_trigger();


--
-- Name: runs graphql_live_run; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graphql_live_run AFTER INSERT OR UPDATE OF record ON public.runs FOR EACH ROW EXECUTE FUNCTION public.graphql_live_run_trigger();


--
-- Name: runs graphql_run_reliability_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graphql_run_reliability_fence BEFORE UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.graphql_run_reliability_fence();


--
-- Name: runs graphql_run_stop_cause; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graphql_run_stop_cause BEFORE INSERT OR UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.graphql_keep_run_stop_cause();


--
-- Name: workflow_versions historical_workflow_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER historical_workflow_version_immutable BEFORE DELETE OR UPDATE ON public.workflow_versions FOR EACH ROW WHEN ((old.execution_semantics_version <> 3)) EXECUTE FUNCTION public.protect_historical_workflow_version();


--
-- Name: ci_runs host_ci_run_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER host_ci_run_activity AFTER INSERT OR UPDATE OF record ON public.ci_runs FOR EACH ROW EXECUTE FUNCTION public.record_host_ci_state_change();


--
-- Name: interaction_delivery_attempts interaction_delivery_attempt_lifecycle; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER interaction_delivery_attempt_lifecycle AFTER INSERT OR UPDATE ON public.interaction_delivery_attempts FOR EACH ROW EXECUTE FUNCTION public.audit_interaction_delivery_attempt();


--
-- Name: job_executions job_acceptance_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_acceptance_immutable BEFORE UPDATE ON public.job_executions FOR EACH ROW EXECUTE FUNCTION public.preserve_job_acceptance();


--
-- Name: job_executions job_accepted_identity_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_accepted_identity_immutable BEFORE UPDATE ON public.job_executions FOR EACH ROW EXECUTE FUNCTION public.preserve_job_accepted_identity();


--
-- Name: job_admission_queue job_admission_queue_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_admission_queue_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.job_admission_queue FOR EACH ROW EXECUTE FUNCTION public.preserve_job_admission_queue();


--
-- Name: files job_artifact_file_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_artifact_file_identity BEFORE INSERT OR DELETE OR UPDATE ON public.files FOR EACH ROW EXECUTE FUNCTION public.job_artifact_file_identity();


--
-- Name: file_revisions job_artifact_revision_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_artifact_revision_scope BEFORE INSERT ON public.file_revisions FOR EACH ROW EXECUTE FUNCTION public.job_artifact_revision_scope();


--
-- Name: job_computer_selections job_computer_selection_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_computer_selection_immutable BEFORE UPDATE ON public.job_computer_selections FOR EACH ROW EXECUTE FUNCTION public.preserve_job_computer_selection();


--
-- Name: job_definition_versions job_definition_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_definition_version_immutable BEFORE DELETE OR UPDATE ON public.job_definition_versions FOR EACH ROW EXECUTE FUNCTION public.preserve_job_definition_version();


--
-- Name: job_dispatch_intents job_dispatch_identity_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_dispatch_identity_immutable BEFORE UPDATE ON public.job_dispatch_intents FOR EACH ROW EXECUTE FUNCTION public.preserve_job_dispatch_identity();


--
-- Name: job_executions job_execution_activity_record_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_execution_activity_record_revision BEFORE UPDATE ON public.job_executions FOR EACH ROW EXECUTE FUNCTION public.advance_activity_record_revision();


--
-- Name: management_command_receipts job_input_admission_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_input_admission_immutable BEFORE DELETE OR UPDATE ON public.management_command_receipts FOR EACH ROW EXECUTE FUNCTION public.job_input_admission_immutable();


--
-- Name: management_command_receipts job_output_admission_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_output_admission_immutable BEFORE DELETE OR UPDATE ON public.management_command_receipts FOR EACH ROW EXECUTE FUNCTION public.job_output_admission_immutable();


--
-- Name: job_dispatch_intents job_run_cleanup_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_run_cleanup_immutable BEFORE UPDATE ON public.job_dispatch_intents FOR EACH ROW EXECUTE FUNCTION public.preserve_job_run_cleanup();


--
-- Name: job_runtime_qualification_approvals job_runtime_native_admission_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_runtime_native_admission_immutable BEFORE UPDATE ON public.job_runtime_qualification_approvals FOR EACH ROW EXECUTE FUNCTION public.preserve_job_runtime_native_admission();


--
-- Name: job_runtime_profile_versions job_runtime_profile_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_runtime_profile_version_immutable BEFORE DELETE OR UPDATE ON public.job_runtime_profile_versions FOR EACH ROW EXECUTE FUNCTION public.preserve_job_runtime_profile_version();


--
-- Name: ci_group_requesters joined_ci_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER joined_ci_activity AFTER INSERT ON public.ci_group_requesters FOR EACH ROW EXECUTE FUNCTION public.record_joined_ci_activity();


--
-- Name: operator_conversation_messages message_activity_record_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_activity_record_revision BEFORE UPDATE ON public.operator_conversation_messages FOR EACH ROW EXECUTE FUNCTION public.advance_activity_record_revision();


--
-- Name: harness_native_events native_event_occurred_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER native_event_occurred_at BEFORE INSERT OR UPDATE OF record ON public.harness_native_events FOR EACH ROW EXECUTE FUNCTION public.set_native_event_occurred_at();


--
-- Name: harness_native_events queue_run_subagent_projection; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER queue_run_subagent_projection AFTER INSERT ON public.harness_native_events FOR EACH ROW EXECUTE FUNCTION public.queue_run_subagent_projection();


--
-- Name: remote_dispatch_origins remote_dispatch_origin_no_rebind; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER remote_dispatch_origin_no_rebind BEFORE DELETE OR UPDATE ON public.remote_dispatch_origins FOR EACH ROW EXECUTE FUNCTION public.remote_dispatch_origin_immutable();


--
-- Name: remote_dispatch_origins remote_dispatch_origin_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER remote_dispatch_origin_no_truncate BEFORE TRUNCATE ON public.remote_dispatch_origins FOR EACH STATEMENT EXECUTE FUNCTION public.remote_dispatch_origin_immutable();


--
-- Name: management_command_receipts remote_native_artifact_output_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER remote_native_artifact_output_immutable BEFORE DELETE OR UPDATE ON public.management_command_receipts FOR EACH ROW EXECUTE FUNCTION public.remote_native_artifact_output_immutable();


--
-- Name: interaction_delivery_attempts remote_owner_control_snapshot_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER remote_owner_control_snapshot_immutable BEFORE DELETE OR UPDATE ON public.interaction_delivery_attempts FOR EACH ROW EXECUTE FUNCTION public.remote_owner_control_snapshot_immutable();


--
-- Name: run_repeat_results repeat_accepted_result; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_accepted_result AFTER INSERT ON public.run_repeat_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_accepted_result();


--
-- Name: run_repeat_bindings repeat_binding_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_binding_evidence AFTER INSERT ON public.run_repeat_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_binding();


--
-- Name: run_repeat_decisions repeat_decision_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_decision_evidence AFTER INSERT ON public.run_repeat_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_decision();


--
-- Name: run_repeat_effects repeat_effect_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_effect_scope AFTER INSERT ON public.run_repeat_effects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_effect_scope();


--
-- Name: run_repeat_executions repeat_execution_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_execution_evidence AFTER INSERT ON public.run_repeat_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_execution_evidence();


--
-- Name: harness_executions repeat_execution_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_execution_scope AFTER INSERT OR UPDATE ON public.harness_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_execution_scope();


--
-- Name: harness_executions repeat_native_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_native_identity BEFORE UPDATE ON public.harness_executions FOR EACH ROW EXECUTE FUNCTION public.protect_repeat_native_identity();


--
-- Name: run_repeat_bindings repeat_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_truncate BEFORE TRUNCATE ON public.run_repeat_bindings FOR EACH STATEMENT EXECUTE FUNCTION public.reject_repeat_evidence_truncate();


--
-- Name: run_repeat_decisions repeat_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_truncate BEFORE TRUNCATE ON public.run_repeat_decisions FOR EACH STATEMENT EXECUTE FUNCTION public.reject_repeat_evidence_truncate();


--
-- Name: run_repeat_effects repeat_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_truncate BEFORE TRUNCATE ON public.run_repeat_effects FOR EACH STATEMENT EXECUTE FUNCTION public.reject_repeat_evidence_truncate();


--
-- Name: run_repeat_executions repeat_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_truncate BEFORE TRUNCATE ON public.run_repeat_executions FOR EACH STATEMENT EXECUTE FUNCTION public.reject_repeat_evidence_truncate();


--
-- Name: run_repeat_occurrences repeat_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_truncate BEFORE TRUNCATE ON public.run_repeat_occurrences FOR EACH STATEMENT EXECUTE FUNCTION public.reject_repeat_evidence_truncate();


--
-- Name: run_repeat_resolutions repeat_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_truncate BEFORE TRUNCATE ON public.run_repeat_resolutions FOR EACH STATEMENT EXECUTE FUNCTION public.reject_repeat_evidence_truncate();


--
-- Name: run_repeat_results repeat_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_truncate BEFORE TRUNCATE ON public.run_repeat_results FOR EACH STATEMENT EXECUTE FUNCTION public.reject_repeat_evidence_truncate();


--
-- Name: run_repeat_slots repeat_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_truncate BEFORE TRUNCATE ON public.run_repeat_slots FOR EACH STATEMENT EXECUTE FUNCTION public.reject_repeat_evidence_truncate();


--
-- Name: run_repeat_bindings repeat_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_update BEFORE UPDATE ON public.run_repeat_bindings FOR EACH ROW EXECUTE FUNCTION public.reject_repeat_evidence_update();


--
-- Name: run_repeat_decisions repeat_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_update BEFORE UPDATE ON public.run_repeat_decisions FOR EACH ROW EXECUTE FUNCTION public.reject_repeat_evidence_update();


--
-- Name: run_repeat_effects repeat_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_update BEFORE UPDATE ON public.run_repeat_effects FOR EACH ROW EXECUTE FUNCTION public.reject_repeat_evidence_update();


--
-- Name: run_repeat_executions repeat_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_update BEFORE UPDATE ON public.run_repeat_executions FOR EACH ROW EXECUTE FUNCTION public.reject_repeat_evidence_update();


--
-- Name: run_repeat_occurrences repeat_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_update BEFORE UPDATE ON public.run_repeat_occurrences FOR EACH ROW EXECUTE FUNCTION public.reject_repeat_evidence_update();


--
-- Name: run_repeat_resolutions repeat_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_update BEFORE UPDATE ON public.run_repeat_resolutions FOR EACH ROW EXECUTE FUNCTION public.reject_repeat_evidence_update();


--
-- Name: run_repeat_results repeat_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_update BEFORE UPDATE ON public.run_repeat_results FOR EACH ROW EXECUTE FUNCTION public.reject_repeat_evidence_update();


--
-- Name: run_repeat_slots repeat_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_no_update BEFORE UPDATE ON public.run_repeat_slots FOR EACH ROW EXECUTE FUNCTION public.reject_repeat_evidence_update();


--
-- Name: run_repeat_occurrences repeat_occurrence_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_occurrence_scope AFTER INSERT ON public.run_repeat_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_occurrence_scope();


--
-- Name: run_repeat_occurrences repeat_occurrence_sources; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_occurrence_sources AFTER INSERT ON public.run_repeat_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_frozen_sources();


--
-- Name: run_repeat_resolutions repeat_resolution_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_resolution_evidence AFTER INSERT ON public.run_repeat_resolutions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_resolution();


--
-- Name: run_repeat_bindings repeat_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_retention AFTER DELETE ON public.run_repeat_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_evidence_retention();


--
-- Name: run_repeat_decisions repeat_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_retention AFTER DELETE ON public.run_repeat_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_evidence_retention();


--
-- Name: run_repeat_effects repeat_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_retention AFTER DELETE ON public.run_repeat_effects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_evidence_retention();


--
-- Name: run_repeat_executions repeat_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_retention AFTER DELETE ON public.run_repeat_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_evidence_retention();


--
-- Name: run_repeat_occurrences repeat_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_retention AFTER DELETE ON public.run_repeat_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_evidence_retention();


--
-- Name: run_repeat_resolutions repeat_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_retention AFTER DELETE ON public.run_repeat_resolutions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_evidence_retention();


--
-- Name: run_repeat_results repeat_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_retention AFTER DELETE ON public.run_repeat_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_evidence_retention();


--
-- Name: run_repeat_slots repeat_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_retention AFTER DELETE ON public.run_repeat_slots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_evidence_retention();


--
-- Name: runs repeat_run_pin; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_run_pin BEFORE UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.protect_repeat_run_pin();


--
-- Name: runs repeat_run_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_run_scope AFTER INSERT OR UPDATE ON public.runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_run_pin();


--
-- Name: run_repeat_slots repeat_slot_input; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_slot_input AFTER INSERT ON public.run_repeat_slots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_slot();


--
-- Name: run_repeat_slots repeat_slot_sources; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_slot_sources AFTER INSERT ON public.run_repeat_slots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_frozen_sources();


--
-- Name: workflow_versions repeat_version_pin; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repeat_version_pin BEFORE UPDATE ON public.workflow_versions FOR EACH ROW EXECUTE FUNCTION public.protect_repeat_version_pin();


--
-- Name: workflow_versions repeat_version_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER repeat_version_scope AFTER INSERT OR UPDATE ON public.workflow_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_repeat_version_scope();


--
-- Name: review_jobs review_job_lease; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER review_job_lease BEFORE INSERT OR UPDATE ON public.review_jobs FOR EACH ROW EXECUTE FUNCTION public.sync_review_job_lease();


--
-- Name: review_jobs review_job_lifecycle; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER review_job_lifecycle AFTER INSERT OR UPDATE ON public.review_jobs FOR EACH ROW EXECUTE FUNCTION public.audit_review_job_lifecycle();


--
-- Name: run_activity run_activity_commit_order; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER run_activity_commit_order AFTER INSERT ON public.run_activity DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.order_run_activity_commit();


--
-- Name: runs run_activity_record_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_activity_record_revision BEFORE UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.advance_activity_record_revision();


--
-- Name: run_board_snapshots run_board_snapshot_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_board_snapshot_immutable BEFORE DELETE OR UPDATE ON public.run_board_snapshots FOR EACH ROW EXECUTE FUNCTION public.protect_run_board_snapshot();


--
-- Name: run_cleanup_intents run_cleanup_episode; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_cleanup_episode BEFORE UPDATE ON public.run_cleanup_intents FOR EACH ROW EXECUTE FUNCTION public.start_run_cleanup_episode();


--
-- Name: runs run_dropdown_order_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_dropdown_order_immutable BEFORE UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.protect_run_dropdown_order();


--
-- Name: run_node_placements run_node_placement_admission; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_node_placement_admission BEFORE INSERT ON public.run_node_placements FOR EACH ROW EXECUTE FUNCTION public.guard_placement_admission();


--
-- Name: run_node_placements run_node_placement_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_node_placement_immutable BEFORE DELETE OR UPDATE ON public.run_node_placements FOR EACH ROW EXECUTE FUNCTION public.guard_placement_immutable();


--
-- Name: run_node_placements run_node_placement_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_node_placement_no_truncate BEFORE TRUNCATE ON public.run_node_placements FOR EACH STATEMENT EXECUTE FUNCTION public.guard_placement_immutable();


--
-- Name: runs run_placement_complete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER run_placement_complete AFTER INSERT ON public.runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_run_placement_complete();


--
-- Name: run_reference_file_pins run_reference_pin_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_reference_pin_validate BEFORE INSERT ON public.run_reference_file_pins FOR EACH ROW EXECUTE FUNCTION public.run_reference_pin_validate();


--
-- Name: run_reference_file_pins run_reference_pins_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_reference_pins_immutable BEFORE DELETE OR UPDATE ON public.run_reference_file_pins FOR EACH ROW EXECUTE FUNCTION public.run_reference_provenance_immutable();


--
-- Name: run_reference_file_reads run_reference_read_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_reference_read_validate BEFORE INSERT ON public.run_reference_file_reads FOR EACH ROW EXECUTE FUNCTION public.run_reference_read_validate();


--
-- Name: run_reference_file_reads run_reference_reads_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_reference_reads_immutable BEFORE DELETE OR UPDATE ON public.run_reference_file_reads FOR EACH ROW EXECUTE FUNCTION public.run_reference_provenance_immutable();


--
-- Name: source_root_bindings source_roots_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_roots_immutable BEFORE DELETE OR UPDATE ON public.source_root_bindings FOR EACH ROW EXECUTE FUNCTION public.source_fact_immutable();


--
-- Name: source_snapshots source_snapshots_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_snapshots_immutable BEFORE DELETE OR UPDATE ON public.source_snapshots FOR EACH ROW EXECUTE FUNCTION public.source_snapshot_immutable();


--
-- Name: graph_drafts wave25_approval_draft_writer; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wave25_approval_draft_writer BEFORE UPDATE OF record ON public.graph_drafts FOR EACH ROW EXECUTE FUNCTION public.wave25_approval_no_downgrade();


--
-- Name: native_session_lanes wave25_approval_generation_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wave25_approval_generation_guard BEFORE UPDATE ON public.native_session_lanes FOR EACH ROW EXECUTE FUNCTION public.wave25_approval_generation_monotonic();


--
-- Name: durable_interactions wave25_approval_interaction_publication; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER wave25_approval_interaction_publication AFTER INSERT OR UPDATE ON public.durable_interactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.wave25_approval_requires_publication();


--
-- Name: review_jobs wave25_approval_review_publication; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER wave25_approval_review_publication AFTER INSERT OR UPDATE ON public.review_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.wave25_approval_requires_publication();


--
-- Name: workflow_versions wave25_approval_version_writer; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wave25_approval_version_writer BEFORE UPDATE ON public.workflow_versions FOR EACH ROW EXECUTE FUNCTION public.wave25_approval_immutable_version();


--
-- Name: workflows wave25_approval_workflow_writer; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wave25_approval_workflow_writer BEFORE UPDATE OF record ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.wave25_approval_no_downgrade();


--
-- Name: run_work_results work_accepted_result; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_accepted_result AFTER INSERT ON public.run_work_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_accepted_result();


--
-- Name: harness_executions work_activation_native_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_activation_native_identity BEFORE UPDATE ON public.harness_executions FOR EACH ROW EXECUTE FUNCTION public.protect_work_activation_identity();


--
-- Name: run_work_activations work_activation_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_activation_scope AFTER INSERT OR UPDATE ON public.run_work_activations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_handoff_scope();


--
-- Name: run_work_activations work_activation_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_activation_update BEFORE UPDATE ON public.run_work_activations FOR EACH ROW EXECUTE FUNCTION public.protect_work_activation_update();


--
-- Name: run_repeat_executions work_attempt_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_attempt_identity AFTER INSERT ON public.run_repeat_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_attempt_identity();


--
-- Name: run_work_denials work_denial_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_denial_evidence AFTER INSERT ON public.run_work_denials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_denial();


--
-- Name: run_work_denials work_denial_notice; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_denial_notice AFTER INSERT ON public.run_work_denials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_work_notice();


--
-- Name: run_work_direction_waits work_direction_wait_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_direction_wait_evidence AFTER INSERT ON public.run_work_direction_waits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_direction_wait();


--
-- Name: run_work_direction_waits work_direction_wait_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_direction_wait_no_update BEFORE UPDATE ON public.run_work_direction_waits FOR EACH ROW EXECUTE FUNCTION public.protect_work_unresolved();


--
-- Name: run_work_direction_waits work_direction_wait_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_direction_wait_retention AFTER DELETE ON public.run_work_direction_waits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.retain_work_notice();


--
-- Name: run_work_join_dispatches work_join_dispatch_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_join_dispatch_evidence AFTER INSERT ON public.run_work_join_dispatches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_join_dispatch();


--
-- Name: run_work_join_dispatches work_join_dispatch_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_join_dispatch_no_update BEFORE UPDATE ON public.run_work_join_dispatches FOR EACH ROW EXECUTE FUNCTION public.protect_work_join_dispatch();


--
-- Name: run_work_returns work_last_return_notice; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_last_return_notice AFTER INSERT ON public.run_work_returns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_work_notice();


--
-- Name: harness_executions work_native_activation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_native_activation AFTER INSERT OR UPDATE ON public.harness_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.tick_index IS NULL)) EXECUTE FUNCTION public.assert_work_native_activation();


--
-- Name: run_work_activations work_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_no_truncate BEFORE TRUNCATE ON public.run_work_activations FOR EACH STATEMENT EXECUTE FUNCTION public.reject_work_evidence_truncate();


--
-- Name: run_work_connection_usage work_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_no_truncate BEFORE TRUNCATE ON public.run_work_connection_usage FOR EACH STATEMENT EXECUTE FUNCTION public.reject_work_evidence_truncate();


--
-- Name: run_work_denials work_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_no_truncate BEFORE TRUNCATE ON public.run_work_denials FOR EACH STATEMENT EXECUTE FUNCTION public.reject_work_evidence_truncate();


--
-- Name: run_work_requests work_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_no_truncate BEFORE TRUNCATE ON public.run_work_requests FOR EACH STATEMENT EXECUTE FUNCTION public.reject_work_evidence_truncate();


--
-- Name: run_work_results work_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_no_truncate BEFORE TRUNCATE ON public.run_work_results FOR EACH STATEMENT EXECUTE FUNCTION public.reject_work_evidence_truncate();


--
-- Name: run_work_returns work_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_no_truncate BEFORE TRUNCATE ON public.run_work_returns FOR EACH STATEMENT EXECUTE FUNCTION public.reject_work_evidence_truncate();


--
-- Name: run_work_denials work_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_no_update BEFORE UPDATE ON public.run_work_denials FOR EACH ROW EXECUTE FUNCTION public.reject_work_evidence_update();


--
-- Name: run_work_requests work_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_no_update BEFORE UPDATE ON public.run_work_requests FOR EACH ROW EXECUTE FUNCTION public.reject_work_evidence_update();


--
-- Name: run_work_results work_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_no_update BEFORE UPDATE ON public.run_work_results FOR EACH ROW EXECUTE FUNCTION public.reject_work_evidence_update();


--
-- Name: run_work_returns work_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_no_update BEFORE UPDATE ON public.run_work_returns FOR EACH ROW EXECUTE FUNCTION public.reject_work_evidence_update();


--
-- Name: run_work_notices work_notice_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_notice_retention AFTER DELETE ON public.run_work_notices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.retain_work_notice();


--
-- Name: run_work_notices work_notice_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_notice_scope AFTER INSERT OR UPDATE ON public.run_work_notices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_notice_scope();


--
-- Name: run_work_notices work_notice_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_notice_update BEFORE UPDATE ON public.run_work_notices FOR EACH ROW EXECUTE FUNCTION public.protect_work_notice_update();


--
-- Name: run_repeat_slots work_parent_input; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_parent_input AFTER INSERT ON public.run_repeat_slots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_parent_input();


--
-- Name: run_work_requests work_request_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_request_evidence AFTER INSERT ON public.run_work_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_request();


--
-- Name: run_work_activations work_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_retention AFTER DELETE ON public.run_work_activations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_evidence_retention();


--
-- Name: run_work_connection_usage work_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_retention AFTER DELETE ON public.run_work_connection_usage DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_evidence_retention();


--
-- Name: run_work_denials work_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_retention AFTER DELETE ON public.run_work_denials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_evidence_retention();


--
-- Name: run_work_requests work_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_retention AFTER DELETE ON public.run_work_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_evidence_retention();


--
-- Name: run_work_results work_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_retention AFTER DELETE ON public.run_work_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_evidence_retention();


--
-- Name: run_work_returns work_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_retention AFTER DELETE ON public.run_work_returns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_evidence_retention();


--
-- Name: run_work_returns work_return_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_return_evidence AFTER INSERT ON public.run_work_returns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_return();


--
-- Name: run_repeat_slots work_slot_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_slot_identity AFTER INSERT ON public.run_repeat_slots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.tick_index IS NULL)) EXECUTE FUNCTION public.assert_work_slot_identity();


--
-- Name: run_work_unresolved work_unresolved_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_unresolved_evidence AFTER INSERT ON public.run_work_unresolved DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_unresolved();


--
-- Name: run_work_unresolved work_unresolved_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_unresolved_no_update BEFORE UPDATE ON public.run_work_unresolved FOR EACH ROW EXECUTE FUNCTION public.protect_work_unresolved();


--
-- Name: run_work_unresolved work_unresolved_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_unresolved_retention AFTER DELETE ON public.run_work_unresolved DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.retain_work_notice();


--
-- Name: run_work_connection_usage work_usage_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER work_usage_scope AFTER INSERT OR UPDATE ON public.run_work_connection_usage DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_work_handoff_scope();


--
-- Name: run_work_connection_usage work_usage_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_usage_update BEFORE UPDATE ON public.run_work_connection_usage FOR EACH ROW EXECUTE FUNCTION public.protect_work_usage_update();


--
-- Name: operator_conversations workflow_native_file_context_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workflow_native_file_context_immutable BEFORE DELETE OR UPDATE ON public.operator_conversations FOR EACH ROW EXECUTE FUNCTION public.workflow_native_file_context_immutable();


--
-- Name: workflows workflow_order_membership; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workflow_order_membership AFTER INSERT OR DELETE OR UPDATE OF workspace_id, archived_at ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.revise_workflow_order();


--
-- Name: workflows workflow_order_prepare; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workflow_order_prepare BEFORE INSERT OR DELETE OR UPDATE OF workspace_id, archived_at ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.prepare_workflow_order();


--
-- Name: workflow_schedule_occurrences workflow_schedule_occurrences_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workflow_schedule_occurrences_immutable BEFORE DELETE OR UPDATE ON public.workflow_schedule_occurrences FOR EACH ROW EXECUTE FUNCTION public.workflow_schedule_occurrence_immutable();


--
-- Name: workflow_schedules workflow_schedule_suppresses_legacy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workflow_schedule_suppresses_legacy AFTER INSERT ON public.workflow_schedules FOR EACH ROW EXECUTE FUNCTION public.suppress_legacy_workflow_schedule();


--
-- Name: workflow_triggers workflow_trigger_new_schedule_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workflow_trigger_new_schedule_guard BEFORE INSERT OR UPDATE ON public.workflow_triggers FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_workflow_schedule();


--
-- Name: interaction_graph_resumes workflow_worker_ack_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workflow_worker_ack_activity AFTER UPDATE OF approval_native_ack_id ON public.interaction_graph_resumes FOR EACH ROW EXECUTE FUNCTION public.record_workflow_worker_ack_activity();


--
-- Name: workspace_root_host_configurations workspace_root_config_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_root_config_immutable BEFORE DELETE OR UPDATE ON public.workspace_root_host_configurations FOR EACH ROW EXECUTE FUNCTION public.workspace_root_fact_immutable();


--
-- Name: workspace_root_policies workspace_root_policy_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_root_policy_immutable BEFORE DELETE OR UPDATE ON public.workspace_root_policies FOR EACH ROW EXECUTE FUNCTION public.workspace_root_policy_immutable();


--
-- Name: agent_configuration_versions agent_configuration_versions_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_configuration_versions
    ADD CONSTRAINT agent_configuration_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: agent_configuration_versions agent_configuration_versions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_configuration_versions
    ADD CONSTRAINT agent_configuration_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: agents agents_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: bug_reports bug_reports_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bug_reports
    ADD CONSTRAINT bug_reports_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: bug_reports bug_reports_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bug_reports
    ADD CONSTRAINT bug_reports_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id);


--
-- Name: bug_reports bug_reports_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bug_reports
    ADD CONSTRAINT bug_reports_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: build_computer_preferences build_computer_preferences_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_computer_preferences
    ADD CONSTRAINT build_computer_preferences_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.management_principals(id);


--
-- Name: ci_enrollment_computers ci_enrollment_computers_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_enrollment_computers
    ADD CONSTRAINT ci_enrollment_computers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: ci_enrollment_workspaces ci_enrollment_workspaces_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_enrollment_workspaces
    ADD CONSTRAINT ci_enrollment_workspaces_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: ci_group_requesters ci_group_requesters_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_group_requesters
    ADD CONSTRAINT ci_group_requesters_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: ci_request_groups ci_request_groups_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_request_groups
    ADD CONSTRAINT ci_request_groups_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: ci_runs ci_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_runs
    ADD CONSTRAINT ci_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: ci_runtime_preparations ci_runtime_preparations_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_runtime_preparations
    ADD CONSTRAINT ci_runtime_preparations_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: ci_runtime_preparations ci_runtime_preparations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_runtime_preparations
    ADD CONSTRAINT ci_runtime_preparations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: ci_test_result_cache ci_test_result_cache_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ci_test_result_cache
    ADD CONSTRAINT ci_test_result_cache_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: computer_sync_preferences computer_sync_preferences_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_sync_preferences
    ADD CONSTRAINT computer_sync_preferences_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.management_principals(id);


--
-- Name: computer_sync_preferences computer_sync_preferences_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_sync_preferences
    ADD CONSTRAINT computer_sync_preferences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: conversation_session_controls conversation_session_controls_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_session_controls
    ADD CONSTRAINT conversation_session_controls_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.operator_conversations(id) ON DELETE CASCADE;


--
-- Name: current_workflow_publications current_workflow_publications_base_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_workflow_publications
    ADD CONSTRAINT current_workflow_publications_base_version_id_fkey FOREIGN KEY (base_version_id) REFERENCES public.workflow_versions(id);


--
-- Name: current_workflow_publications current_workflow_publications_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_workflow_publications
    ADD CONSTRAINT current_workflow_publications_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: current_workflow_publications current_workflow_publications_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_workflow_publications
    ADD CONSTRAINT current_workflow_publications_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id);


--
-- Name: current_workflow_publications current_workflow_publications_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_workflow_publications
    ADD CONSTRAINT current_workflow_publications_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_versions(id);


--
-- Name: current_workflow_publications current_workflow_publications_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_workflow_publications
    ADD CONSTRAINT current_workflow_publications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: device_pairing_grants device_pairing_grants_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_pairing_grants
    ADD CONSTRAINT device_pairing_grants_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.device_registrations(id);


--
-- Name: device_pairing_grants device_pairing_grants_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_pairing_grants
    ADD CONSTRAINT device_pairing_grants_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: durable_interactions durable_interactions_approval_native_request_proof_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_interactions
    ADD CONSTRAINT durable_interactions_approval_native_request_proof_id_fkey FOREIGN KEY (approval_native_request_proof_id) REFERENCES public.workflow_native_proofs(proof_id);


--
-- Name: durable_interactions durable_interactions_approval_reviewer_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_interactions
    ADD CONSTRAINT durable_interactions_approval_reviewer_execution_id_fkey FOREIGN KEY (approval_reviewer_execution_id) REFERENCES public.harness_executions(id);


--
-- Name: execution_dispatch_intents execution_dispatch_intents_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_dispatch_intents
    ADD CONSTRAINT execution_dispatch_intents_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: execution_dispatch_intents execution_dispatch_intents_run_id_node_id_binding_hash_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_dispatch_intents
    ADD CONSTRAINT execution_dispatch_intents_run_id_node_id_binding_hash_fkey FOREIGN KEY (run_id, node_id, binding_hash) REFERENCES public.run_node_placements(run_id, node_id, binding_hash);


--
-- Name: execution_dispatch_owner_grants execution_dispatch_owner_grants_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_dispatch_owner_grants
    ADD CONSTRAINT execution_dispatch_owner_grants_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: execution_dispatch_owner_grants execution_dispatch_owner_grants_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_dispatch_owner_grants
    ADD CONSTRAINT execution_dispatch_owner_grants_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.execution_dispatch_intents(operation_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: execution_native_closures execution_native_closures_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_closures
    ADD CONSTRAINT execution_native_closures_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE;


--
-- Name: execution_native_placements execution_native_placements_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_placements
    ADD CONSTRAINT execution_native_placements_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: execution_native_placements execution_native_placements_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_placements
    ADD CONSTRAINT execution_native_placements_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.execution_dispatch_intents(operation_id);


--
-- Name: execution_native_recoveries execution_native_recoveries_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_recoveries
    ADD CONSTRAINT execution_native_recoveries_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: execution_native_recoveries execution_native_recoveries_generation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_recoveries
    ADD CONSTRAINT execution_native_recoveries_generation_fkey FOREIGN KEY (generation) REFERENCES public.execution_native_closures(generation);


--
-- Name: execution_native_sessions execution_native_sessions_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_native_sessions
    ADD CONSTRAINT execution_native_sessions_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE;


--
-- Name: execution_work_result_repairs execution_work_result_repairs_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_work_result_repairs
    ADD CONSTRAINT execution_work_result_repairs_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE;


--
-- Name: file_allocations file_allocations_file_id_owner_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_allocations
    ADD CONSTRAINT file_allocations_file_id_owner_principal_id_fkey FOREIGN KEY (file_id, owner_principal_id) REFERENCES public.files(file_id, owner_principal_id);


--
-- Name: file_allocations file_allocations_file_id_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_allocations
    ADD CONSTRAINT file_allocations_file_id_revision_id_fkey FOREIGN KEY (file_id, revision_id) REFERENCES public.file_revisions(file_id, revision_id);


--
-- Name: file_artifact_edge_reads file_artifact_edge_reads_edge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_artifact_edge_reads
    ADD CONSTRAINT file_artifact_edge_reads_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES public.file_artifact_edges(edge_id);


--
-- Name: file_artifact_edges file_artifact_edges_file_id_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_artifact_edges
    ADD CONSTRAINT file_artifact_edges_file_id_revision_id_fkey FOREIGN KEY (file_id, revision_id) REFERENCES public.file_revisions(file_id, revision_id);


--
-- Name: file_retention_preferences file_retention_preferences_owner_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_retention_preferences
    ADD CONSTRAINT file_retention_preferences_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.management_principals(id);


--
-- Name: file_revisions file_revisions_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_revisions
    ADD CONSTRAINT file_revisions_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(file_id);


--
-- Name: file_tool_publications file_tool_publications_file_id_owner_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_tool_publications
    ADD CONSTRAINT file_tool_publications_file_id_owner_principal_id_fkey FOREIGN KEY (file_id, owner_principal_id) REFERENCES public.files(file_id, owner_principal_id);


--
-- Name: file_tool_publications file_tool_publications_file_id_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_tool_publications
    ADD CONSTRAINT file_tool_publications_file_id_revision_id_fkey FOREIGN KEY (file_id, revision_id) REFERENCES public.file_revisions(file_id, revision_id);


--
-- Name: file_tool_publications file_tool_publications_owner_principal_id_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_tool_publications
    ADD CONSTRAINT file_tool_publications_owner_principal_id_request_id_fkey FOREIGN KEY (owner_principal_id, request_id) REFERENCES public.file_allocations(owner_principal_id, request_id);


--
-- Name: file_tool_read_provenance file_tool_read_provenance_file_id_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_tool_read_provenance
    ADD CONSTRAINT file_tool_read_provenance_file_id_revision_id_fkey FOREIGN KEY (file_id, revision_id) REFERENCES public.file_revisions(file_id, revision_id);


--
-- Name: files files_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.operator_conversations(id);


--
-- Name: files files_head_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_head_fk FOREIGN KEY (file_id, current_revision_id) REFERENCES public.file_revisions(file_id, revision_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: files files_job_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_job_execution_id_fkey FOREIGN KEY (job_execution_id) REFERENCES public.job_executions(id);


--
-- Name: graph_drafts graph_drafts_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_drafts
    ADD CONSTRAINT graph_drafts_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id);


--
-- Name: graph_drafts graph_drafts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_drafts
    ADD CONSTRAINT graph_drafts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: graph_edit_intents graph_edit_intents_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_edit_intents
    ADD CONSTRAINT graph_edit_intents_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: graph_edit_intents graph_edit_intents_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_edit_intents
    ADD CONSTRAINT graph_edit_intents_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id);


--
-- Name: graph_edit_intents graph_edit_intents_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_edit_intents
    ADD CONSTRAINT graph_edit_intents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: harness_executions harness_executions_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_executions
    ADD CONSTRAINT harness_executions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: harness_executions harness_executions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_executions
    ADD CONSTRAINT harness_executions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: harness_instance_profile_evidence harness_instance_profile_evid_instance_id_instance_revisio_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_instance_profile_evidence
    ADD CONSTRAINT harness_instance_profile_evid_instance_id_instance_revisio_fkey FOREIGN KEY (instance_id, instance_revision) REFERENCES public.harness_instance_settings(instance_id, revision);


--
-- Name: harness_instance_settings harness_instance_settings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_instance_settings
    ADD CONSTRAINT harness_instance_settings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.management_principals(id);


--
-- Name: harness_mcp_change_plans harness_mcp_change_plans_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_mcp_change_plans
    ADD CONSTRAINT harness_mcp_change_plans_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.management_principals(id);


--
-- Name: harness_mcp_change_plans harness_mcp_change_plans_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_mcp_change_plans
    ADD CONSTRAINT harness_mcp_change_plans_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.management_principals(id);


--
-- Name: harness_native_events harness_native_events_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_native_events
    ADD CONSTRAINT harness_native_events_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE;


--
-- Name: interaction_delivery_attempts interaction_delivery_attempts_interaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interaction_delivery_attempts
    ADD CONSTRAINT interaction_delivery_attempts_interaction_id_fkey FOREIGN KEY (interaction_id) REFERENCES public.durable_interactions(id) ON DELETE CASCADE;


--
-- Name: interaction_graph_resumes interaction_graph_resumes_interaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interaction_graph_resumes
    ADD CONSTRAINT interaction_graph_resumes_interaction_id_fkey FOREIGN KEY (interaction_id) REFERENCES public.durable_interactions(id) ON DELETE CASCADE;


--
-- Name: interaction_reconciliation_evidence interaction_reconciliation_evidence_interaction_id_attempt_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interaction_reconciliation_evidence
    ADD CONSTRAINT interaction_reconciliation_evidence_interaction_id_attempt_fkey FOREIGN KEY (interaction_id, attempt) REFERENCES public.interaction_delivery_attempts(interaction_id, attempt);


--
-- Name: interaction_reconciliation_evidence interaction_reconciliation_evidence_interaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interaction_reconciliation_evidence
    ADD CONSTRAINT interaction_reconciliation_evidence_interaction_id_fkey FOREIGN KEY (interaction_id) REFERENCES public.durable_interactions(id) ON DELETE CASCADE;


--
-- Name: job_admission_queue job_admission_queue_definition_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_admission_queue
    ADD CONSTRAINT job_admission_queue_definition_version_id_fkey FOREIGN KEY (definition_version_id) REFERENCES public.job_definition_versions(id);


--
-- Name: job_admission_queue job_admission_queue_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_admission_queue
    ADD CONSTRAINT job_admission_queue_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: job_admission_queue job_admission_queue_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_admission_queue
    ADD CONSTRAINT job_admission_queue_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: job_computer_selections job_computer_selections_definition_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_computer_selections
    ADD CONSTRAINT job_computer_selections_definition_version_id_fkey FOREIGN KEY (definition_version_id) REFERENCES public.job_definition_versions(id);


--
-- Name: job_computer_selections job_computer_selections_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_computer_selections
    ADD CONSTRAINT job_computer_selections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: job_definition_versions job_definition_versions_definition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_definition_versions
    ADD CONSTRAINT job_definition_versions_definition_id_fkey FOREIGN KEY (definition_id) REFERENCES public.job_definitions(id);


--
-- Name: job_definition_versions job_definition_versions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_definition_versions
    ADD CONSTRAINT job_definition_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: job_definitions job_definitions_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_definitions
    ADD CONSTRAINT job_definitions_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.management_principals(id);


--
-- Name: job_definitions job_definitions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_definitions
    ADD CONSTRAINT job_definitions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: job_dispatch_intents job_dispatch_intents_cancel_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_dispatch_intents
    ADD CONSTRAINT job_dispatch_intents_cancel_principal_id_fkey FOREIGN KEY (cancel_principal_id) REFERENCES public.management_principals(id);


--
-- Name: job_dispatch_intents job_dispatch_intents_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_dispatch_intents
    ADD CONSTRAINT job_dispatch_intents_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.job_executions(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: job_dispatch_intents job_dispatch_intents_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_dispatch_intents
    ADD CONSTRAINT job_dispatch_intents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: job_executions job_executions_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.management_principals(id);


--
-- Name: job_executions job_executions_definition_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_definition_version_id_fkey FOREIGN KEY (definition_version_id) REFERENCES public.job_definition_versions(id);


--
-- Name: job_executions job_executions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: job_log_chunks job_log_chunks_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_log_chunks
    ADD CONSTRAINT job_log_chunks_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.job_executions(id);


--
-- Name: job_preparations job_preparations_definition_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_preparations
    ADD CONSTRAINT job_preparations_definition_version_id_fkey FOREIGN KEY (definition_version_id) REFERENCES public.job_definition_versions(id);


--
-- Name: job_preparations job_preparations_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_preparations
    ADD CONSTRAINT job_preparations_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: job_preparations job_preparations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_preparations
    ADD CONSTRAINT job_preparations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: job_runtime_profile_versions job_runtime_profile_versions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_profile_versions
    ADD CONSTRAINT job_runtime_profile_versions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.job_runtime_profiles(id);


--
-- Name: job_runtime_profiles job_runtime_profiles_root_id_binding_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_profiles
    ADD CONSTRAINT job_runtime_profiles_root_id_binding_revision_fkey FOREIGN KEY (root_id, binding_revision) REFERENCES public.source_root_bindings(root_id, binding_revision);


--
-- Name: job_runtime_profiles job_runtime_profiles_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_profiles
    ADD CONSTRAINT job_runtime_profiles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: job_runtime_qualification_approvals job_runtime_qualification_approvals_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_qualification_approvals
    ADD CONSTRAINT job_runtime_qualification_approvals_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.management_principals(id);


--
-- Name: job_runtime_qualification_approvals job_runtime_qualification_approvals_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_qualification_approvals
    ADD CONSTRAINT job_runtime_qualification_approvals_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.job_runtime_profiles(id);


--
-- Name: job_runtime_qualification_approvals job_runtime_qualification_approvals_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_qualification_approvals
    ADD CONSTRAINT job_runtime_qualification_approvals_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.management_principals(id);


--
-- Name: job_runtime_qualification_approvals job_runtime_qualification_approvals_run_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_qualification_approvals
    ADD CONSTRAINT job_runtime_qualification_approvals_run_principal_id_fkey FOREIGN KEY (run_principal_id) REFERENCES public.management_principals(id);


--
-- Name: job_runtime_qualification_approvals job_runtime_qualification_approvals_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runtime_qualification_approvals
    ADD CONSTRAINT job_runtime_qualification_approvals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: local_human_principal local_human_principal_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_human_principal
    ADD CONSTRAINT local_human_principal_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: local_workflow_native_output_chunks local_workflow_native_output_chunks_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_workflow_native_output_chunks
    ADD CONSTRAINT local_workflow_native_output_chunks_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.local_workflow_native_outputs(artifact_id);


--
-- Name: local_workflow_native_output_commands local_workflow_native_output_commands_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_workflow_native_output_commands
    ADD CONSTRAINT local_workflow_native_output_commands_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: local_workflow_native_outputs local_workflow_native_outputs_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_workflow_native_outputs
    ADD CONSTRAINT local_workflow_native_outputs_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: management_command_receipts management_command_receipts_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.management_command_receipts
    ADD CONSTRAINT management_command_receipts_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: management_principals management_principals_delegated_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.management_principals
    ADD CONSTRAINT management_principals_delegated_from_fkey FOREIGN KEY (delegated_from) REFERENCES public.management_principals(id);


--
-- Name: operator_chat_credentials operator_chat_credentials_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_chat_credentials
    ADD CONSTRAINT operator_chat_credentials_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.operator_conversations(id) ON DELETE CASCADE;


--
-- Name: operator_chat_credentials operator_chat_credentials_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_chat_credentials
    ADD CONSTRAINT operator_chat_credentials_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: operator_configuration_versions operator_configuration_versions_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_configuration_versions
    ADD CONSTRAINT operator_configuration_versions_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.application_operators(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: operator_conversation_activity operator_conversation_activity_conversation_id_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversation_activity
    ADD CONSTRAINT operator_conversation_activity_conversation_id_request_id_fkey FOREIGN KEY (conversation_id, request_id) REFERENCES public.operator_conversation_turns(conversation_id, request_id) ON DELETE CASCADE;


--
-- Name: operator_conversation_messages operator_conversation_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversation_messages
    ADD CONSTRAINT operator_conversation_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.operator_conversations(id) ON DELETE CASCADE;


--
-- Name: operator_conversation_turns operator_conversation_turns_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversation_turns
    ADD CONSTRAINT operator_conversation_turns_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.operator_conversations(id) ON DELETE CASCADE;


--
-- Name: operator_conversation_turns operator_conversation_turns_operator_configuration_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversation_turns
    ADD CONSTRAINT operator_conversation_turns_operator_configuration_version_fkey FOREIGN KEY (operator_configuration_version_id) REFERENCES public.operator_configuration_versions(id);


--
-- Name: operator_conversations operator_conversations_agent_configuration_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_agent_configuration_version_id_fkey FOREIGN KEY (agent_configuration_version_id) REFERENCES public.agent_configuration_versions(id);


--
-- Name: operator_conversations operator_conversations_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: operator_conversations operator_conversations_operator_configuration_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_operator_configuration_version_id_fkey FOREIGN KEY (operator_configuration_version_id) REFERENCES public.operator_configuration_versions(id);


--
-- Name: operator_conversations operator_conversations_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.application_operators(id);


--
-- Name: operator_conversations operator_conversations_origin_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_origin_execution_id_fkey FOREIGN KEY (origin_execution_id) REFERENCES public.harness_executions(id);


--
-- Name: operator_conversations operator_conversations_origin_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_origin_run_id_fkey FOREIGN KEY (origin_run_id) REFERENCES public.runs(id);


--
-- Name: operator_conversations operator_conversations_owner_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.management_principals(id);


--
-- Name: operator_conversations operator_conversations_parent_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_parent_conversation_id_fkey FOREIGN KEY (parent_conversation_id) REFERENCES public.operator_conversations(id);


--
-- Name: operator_conversations operator_conversations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: remote_dispatch_origins remote_dispatch_origins_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_dispatch_origins
    ADD CONSTRAINT remote_dispatch_origins_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.execution_dispatch_intents(operation_id);


--
-- Name: remote_execution_owner_reconciliations remote_execution_owner_reconciliations_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_execution_owner_reconciliations
    ADD CONSTRAINT remote_execution_owner_reconciliations_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.execution_dispatch_intents(operation_id);


--
-- Name: remote_execution_receipts remote_execution_receipts_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_execution_receipts
    ADD CONSTRAINT remote_execution_receipts_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.execution_dispatch_intents(operation_id);


--
-- Name: remote_execution_recovery_audit remote_execution_recovery_audit_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_execution_recovery_audit
    ADD CONSTRAINT remote_execution_recovery_audit_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.execution_dispatch_intents(operation_id);


--
-- Name: harness_executions repeat_execution_occurrence_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_executions
    ADD CONSTRAINT repeat_execution_occurrence_fk FOREIGN KEY (repeat_occurrence_id, run_id) REFERENCES public.run_repeat_occurrences(occurrence_id, run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_occurrences repeat_predecessor_decision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT repeat_predecessor_decision_fk FOREIGN KEY (previous_decision_id, previous_occurrence_id, previous_result_digest) REFERENCES public.run_repeat_decisions(decision_id, occurrence_id, result_digest) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: repeat_workflow_publications repeat_workflow_publications_base_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repeat_workflow_publications
    ADD CONSTRAINT repeat_workflow_publications_base_version_id_fkey FOREIGN KEY (base_version_id) REFERENCES public.workflow_versions(id);


--
-- Name: repeat_workflow_publications repeat_workflow_publications_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repeat_workflow_publications
    ADD CONSTRAINT repeat_workflow_publications_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: repeat_workflow_publications repeat_workflow_publications_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repeat_workflow_publications
    ADD CONSTRAINT repeat_workflow_publications_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id);


--
-- Name: repeat_workflow_publications repeat_workflow_publications_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repeat_workflow_publications
    ADD CONSTRAINT repeat_workflow_publications_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_versions(id);


--
-- Name: repeat_workflow_publications repeat_workflow_publications_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repeat_workflow_publications
    ADD CONSTRAINT repeat_workflow_publications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: review_jobs review_jobs_approval_original_proof_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_jobs
    ADD CONSTRAINT review_jobs_approval_original_proof_id_fkey FOREIGN KEY (approval_original_proof_id) REFERENCES public.review_native_proofs(proof_id);


--
-- Name: review_jobs review_jobs_interaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_jobs
    ADD CONSTRAINT review_jobs_interaction_id_fkey FOREIGN KEY (interaction_id) REFERENCES public.durable_interactions(id) ON DELETE CASCADE;


--
-- Name: review_native_entries review_native_entries_entry_proof_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_native_entries
    ADD CONSTRAINT review_native_entries_entry_proof_id_fkey FOREIGN KEY (entry_proof_id) REFERENCES public.review_native_proofs(proof_id);


--
-- Name: review_native_entries review_native_entries_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_native_entries
    ADD CONSTRAINT review_native_entries_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: review_native_entries review_native_entries_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_native_entries
    ADD CONSTRAINT review_native_entries_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.review_jobs(id);


--
-- Name: review_native_entries review_native_entries_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_native_entries
    ADD CONSTRAINT review_native_entries_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: review_native_proofs review_native_proofs_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_native_proofs
    ADD CONSTRAINT review_native_proofs_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: review_native_proofs review_native_proofs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_native_proofs
    ADD CONSTRAINT review_native_proofs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.review_jobs(id);


--
-- Name: review_native_proofs review_native_proofs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_native_proofs
    ADD CONSTRAINT review_native_proofs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: run_activity run_activity_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_activity
    ADD CONSTRAINT run_activity_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.run_activity_streams(run_id) ON DELETE CASCADE;


--
-- Name: run_activity_streams run_activity_streams_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_activity_streams
    ADD CONSTRAINT run_activity_streams_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_authority_principals run_authority_principals_owner_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_authority_principals
    ADD CONSTRAINT run_authority_principals_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.management_principals(id);


--
-- Name: run_authority_principals run_authority_principals_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_authority_principals
    ADD CONSTRAINT run_authority_principals_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: run_authority_principals run_authority_principals_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_authority_principals
    ADD CONSTRAINT run_authority_principals_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_board_snapshots run_board_snapshots_run_id_workspace_id_workflow_id_workfl_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_board_snapshots
    ADD CONSTRAINT run_board_snapshots_run_id_workspace_id_workflow_id_workfl_fkey FOREIGN KEY (run_id, workspace_id, workflow_id, workflow_version_id) REFERENCES public.runs(id, workspace_id, workflow_id, workflow_version_id) ON DELETE RESTRICT;


--
-- Name: run_cleanup_intents run_cleanup_intents_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_cleanup_intents
    ADD CONSTRAINT run_cleanup_intents_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_graph_batches run_graph_batches_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_batches
    ADD CONSTRAINT run_graph_batches_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.run_graph_heads(run_id) ON DELETE CASCADE;


--
-- Name: run_graph_effects run_graph_effects_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_effects
    ADD CONSTRAINT run_graph_effects_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.run_graph_heads(run_id) ON DELETE CASCADE;


--
-- Name: run_graph_heads run_graph_heads_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_heads
    ADD CONSTRAINT run_graph_heads_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_graph_public_projection run_graph_public_projection_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_public_projection
    ADD CONSTRAINT run_graph_public_projection_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: run_graph_sources run_graph_sources_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_graph_sources
    ADD CONSTRAINT run_graph_sources_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.run_graph_heads(run_id) ON DELETE CASCADE;


--
-- Name: run_input_bindings run_input_bindings_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_input_bindings
    ADD CONSTRAINT run_input_bindings_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_input_bindings run_input_bindings_run_id_recipient_execution_id_recipient_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_input_bindings
    ADD CONSTRAINT run_input_bindings_run_id_recipient_execution_id_recipient_fkey FOREIGN KEY (run_id, recipient_execution_id, recipient_node_id, recipient_attempt) REFERENCES public.harness_executions(run_id, id, workflow_node_id, attempt);


--
-- Name: run_input_bindings run_input_bindings_run_id_sender_execution_id_sender_node__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_input_bindings
    ADD CONSTRAINT run_input_bindings_run_id_sender_execution_id_sender_node__fkey FOREIGN KEY (run_id, sender_execution_id, sender_node_id, sender_attempt) REFERENCES public.harness_executions(run_id, id, workflow_node_id, attempt);


--
-- Name: run_native_activity run_native_activity_review_job_id_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_activity
    ADD CONSTRAINT run_native_activity_review_job_id_execution_id_fkey FOREIGN KEY (review_job_id, execution_id) REFERENCES public.review_jobs(id, execution_id);


--
-- Name: run_native_activity run_native_activity_run_id_execution_id_workflow_node_id_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_activity
    ADD CONSTRAINT run_native_activity_run_id_execution_id_workflow_node_id_a_fkey FOREIGN KEY (run_id, execution_id, workflow_node_id, attempt) REFERENCES public.harness_executions(run_id, id, workflow_node_id, attempt);


--
-- Name: run_native_activity run_native_activity_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_activity
    ADD CONSTRAINT run_native_activity_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_native_correlations run_native_correlations_review_job_id_execution_id_interac_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_correlations
    ADD CONSTRAINT run_native_correlations_review_job_id_execution_id_interac_fkey FOREIGN KEY (review_job_id, execution_id, interaction_id) REFERENCES public.review_jobs(id, execution_id, interaction_id);


--
-- Name: run_native_correlations run_native_correlations_run_id_execution_id_workflow_node__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_correlations
    ADD CONSTRAINT run_native_correlations_run_id_execution_id_workflow_node__fkey FOREIGN KEY (run_id, execution_id, workflow_node_id, attempt) REFERENCES public.harness_executions(run_id, id, workflow_node_id, attempt);


--
-- Name: run_native_correlations run_native_correlations_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_correlations
    ADD CONSTRAINT run_native_correlations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_native_correlations run_native_correlations_run_id_interaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_correlations
    ADD CONSTRAINT run_native_correlations_run_id_interaction_id_fkey FOREIGN KEY (run_id, interaction_id) REFERENCES public.durable_interactions(run_id, id);


--
-- Name: run_native_projection_checkpoints run_native_projection_checkpo_run_id_execution_id_workflow_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_projection_checkpoints
    ADD CONSTRAINT run_native_projection_checkpo_run_id_execution_id_workflow_fkey FOREIGN KEY (run_id, execution_id, workflow_node_id, attempt) REFERENCES public.harness_executions(run_id, id, workflow_node_id, attempt);


--
-- Name: run_native_projection_checkpoints run_native_projection_checkpoints_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_native_projection_checkpoints
    ADD CONSTRAINT run_native_projection_checkpoints_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_node_placements run_node_placements_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_node_placements
    ADD CONSTRAINT run_node_placements_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: run_node_resolutions run_node_resolutions_run_id_execution_id_workflow_node_id__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_node_resolutions
    ADD CONSTRAINT run_node_resolutions_run_id_execution_id_workflow_node_id__fkey FOREIGN KEY (run_id, execution_id, workflow_node_id, attempt) REFERENCES public.harness_executions(run_id, id, workflow_node_id, attempt);


--
-- Name: run_node_resolutions run_node_resolutions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_node_resolutions
    ADD CONSTRAINT run_node_resolutions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_reference_file_pins run_reference_file_pins_file_id_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_reference_file_pins
    ADD CONSTRAINT run_reference_file_pins_file_id_revision_id_fkey FOREIGN KEY (file_id, revision_id) REFERENCES public.file_revisions(file_id, revision_id);


--
-- Name: run_reference_file_pins run_reference_file_pins_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_reference_file_pins
    ADD CONSTRAINT run_reference_file_pins_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: run_reference_file_reads run_reference_file_reads_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_reference_file_reads
    ADD CONSTRAINT run_reference_file_reads_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: run_reference_file_reads run_reference_file_reads_run_id_file_id_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_reference_file_reads
    ADD CONSTRAINT run_reference_file_reads_run_id_file_id_revision_id_fkey FOREIGN KEY (run_id, file_id, revision_id) REFERENCES public.run_reference_file_pins(run_id, file_id, revision_id);


--
-- Name: run_repeat_bindings run_repeat_bindings_recipient_execution_id_slot_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_bindings
    ADD CONSTRAINT run_repeat_bindings_recipient_execution_id_slot_id_run_id_fkey FOREIGN KEY (recipient_execution_id, slot_id, run_id) REFERENCES public.run_repeat_executions(execution_id, slot_id, run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_bindings run_repeat_bindings_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_bindings
    ADD CONSTRAINT run_repeat_bindings_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_bindings run_repeat_bindings_run_id_source_execution_id_source_resu_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_bindings
    ADD CONSTRAINT run_repeat_bindings_run_id_source_execution_id_source_resu_fkey FOREIGN KEY (run_id, source_execution_id, source_result_digest) REFERENCES public.run_repeat_results(run_id, execution_id, result_digest) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_bindings run_repeat_bindings_slot_id_input_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_bindings
    ADD CONSTRAINT run_repeat_bindings_slot_id_input_digest_fkey FOREIGN KEY (slot_id, input_digest) REFERENCES public.run_repeat_slots(slot_id, input_digest) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_decisions run_repeat_decisions_exit_execution_id_occurrence_id_resul_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_decisions
    ADD CONSTRAINT run_repeat_decisions_exit_execution_id_occurrence_id_resul_fkey FOREIGN KEY (exit_execution_id, occurrence_id, result_digest) REFERENCES public.run_repeat_results(execution_id, occurrence_id, result_digest) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_decisions run_repeat_decisions_occurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_decisions
    ADD CONSTRAINT run_repeat_decisions_occurrence_id_fkey FOREIGN KEY (occurrence_id) REFERENCES public.run_repeat_occurrences(occurrence_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_decisions run_repeat_decisions_occurrence_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_decisions
    ADD CONSTRAINT run_repeat_decisions_occurrence_id_run_id_fkey FOREIGN KEY (occurrence_id, run_id) REFERENCES public.run_repeat_occurrences(occurrence_id, run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_effects run_repeat_effects_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_effects
    ADD CONSTRAINT run_repeat_effects_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_executions run_repeat_executions_harness_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_harness_execution_id_fkey FOREIGN KEY (harness_execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_executions run_repeat_executions_job_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_job_execution_id_fkey FOREIGN KEY (job_execution_id) REFERENCES public.job_executions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_executions run_repeat_executions_occurrence_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_occurrence_id_run_id_fkey FOREIGN KEY (occurrence_id, run_id) REFERENCES public.run_repeat_occurrences(occurrence_id, run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_executions run_repeat_executions_previous_execution_id_slot_id_previo_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_previous_execution_id_slot_id_previo_fkey FOREIGN KEY (previous_execution_id, slot_id, previous_technical_attempt) REFERENCES public.run_repeat_executions(execution_id, slot_id, technical_attempt) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_executions run_repeat_executions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_executions run_repeat_executions_slot_id_run_id_occurrence_key_workfl_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT run_repeat_executions_slot_id_run_id_occurrence_key_workfl_fkey FOREIGN KEY (slot_id, run_id, occurrence_key, workflow_node_id) REFERENCES public.run_repeat_slots(slot_id, run_id, occurrence_key, workflow_node_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_occurrences run_repeat_occurrences_previous_occurrence_id_run_id_workf_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT run_repeat_occurrences_previous_occurrence_id_run_id_workf_fkey FOREIGN KEY (previous_occurrence_id, run_id, workflow_version_id, block_id, previous_occurrence_index) REFERENCES public.run_repeat_occurrences(occurrence_id, run_id, workflow_version_id, block_id, occurrence_index) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_occurrences run_repeat_occurrences_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT run_repeat_occurrences_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_occurrences run_repeat_occurrences_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT run_repeat_occurrences_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_occurrences run_repeat_occurrences_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT run_repeat_occurrences_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_versions(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_occurrences run_repeat_occurrences_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_occurrences
    ADD CONSTRAINT run_repeat_occurrences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_resolutions run_repeat_resolutions_execution_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_resolutions
    ADD CONSTRAINT run_repeat_resolutions_execution_id_run_id_fkey FOREIGN KEY (execution_id, run_id) REFERENCES public.run_repeat_executions(execution_id, run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_resolutions run_repeat_resolutions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_resolutions
    ADD CONSTRAINT run_repeat_resolutions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_resolutions run_repeat_resolutions_source_occurrence_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_resolutions
    ADD CONSTRAINT run_repeat_resolutions_source_occurrence_id_run_id_fkey FOREIGN KEY (source_occurrence_id, run_id) REFERENCES public.run_repeat_occurrences(occurrence_id, run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_results run_repeat_results_execution_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_results
    ADD CONSTRAINT run_repeat_results_execution_id_run_id_fkey FOREIGN KEY (execution_id, run_id) REFERENCES public.run_repeat_executions(execution_id, run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_results run_repeat_results_execution_id_run_id_occurrence_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_results
    ADD CONSTRAINT run_repeat_results_execution_id_run_id_occurrence_key_fkey FOREIGN KEY (execution_id, run_id, occurrence_key) REFERENCES public.run_repeat_executions(execution_id, run_id, occurrence_key) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_results run_repeat_results_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_results
    ADD CONSTRAINT run_repeat_results_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_slots run_repeat_slots_occurrence_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_slots
    ADD CONSTRAINT run_repeat_slots_occurrence_id_run_id_fkey FOREIGN KEY (occurrence_id, run_id) REFERENCES public.run_repeat_occurrences(occurrence_id, run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_slots run_repeat_slots_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_slots
    ADD CONSTRAINT run_repeat_slots_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_subagent_backfill_state run_subagent_backfill_state_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_backfill_state
    ADD CONSTRAINT run_subagent_backfill_state_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE;


--
-- Name: run_subagent_command_receipts run_subagent_command_receipts_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_command_receipts
    ADD CONSTRAINT run_subagent_command_receipts_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: run_subagent_command_receipts run_subagent_command_receipts_subagent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_command_receipts
    ADD CONSTRAINT run_subagent_command_receipts_subagent_id_fkey FOREIGN KEY (subagent_id) REFERENCES public.run_subagents(id);


--
-- Name: run_subagent_items run_subagent_items_subagent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_items
    ADD CONSTRAINT run_subagent_items_subagent_id_fkey FOREIGN KEY (subagent_id) REFERENCES public.run_subagents(id) ON DELETE CASCADE;


--
-- Name: run_subagent_lifecycle run_subagent_lifecycle_subagent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_lifecycle
    ADD CONSTRAINT run_subagent_lifecycle_subagent_id_fkey FOREIGN KEY (subagent_id) REFERENCES public.run_subagents(id) ON DELETE CASCADE;


--
-- Name: run_subagent_message_roles run_subagent_message_roles_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_message_roles
    ADD CONSTRAINT run_subagent_message_roles_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE;


--
-- Name: run_subagent_pending_events run_subagent_pending_events_execution_id_sequence_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_pending_events
    ADD CONSTRAINT run_subagent_pending_events_execution_id_sequence_fkey FOREIGN KEY (execution_id, sequence) REFERENCES public.harness_native_events(execution_id, sequence) ON DELETE CASCADE;


--
-- Name: run_subagent_projection_queue run_subagent_projection_queue_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_projection_queue
    ADD CONSTRAINT run_subagent_projection_queue_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE;


--
-- Name: run_subagent_sources run_subagent_sources_subagent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagent_sources
    ADD CONSTRAINT run_subagent_sources_subagent_id_fkey FOREIGN KEY (subagent_id) REFERENCES public.run_subagents(id) ON DELETE CASCADE;


--
-- Name: run_subagents run_subagents_parent_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagents
    ADD CONSTRAINT run_subagents_parent_execution_id_fkey FOREIGN KEY (parent_execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE;


--
-- Name: run_subagents run_subagents_parent_subagent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagents
    ADD CONSTRAINT run_subagents_parent_subagent_id_fkey FOREIGN KEY (parent_subagent_id) REFERENCES public.run_subagents(id);


--
-- Name: run_subagents run_subagents_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_subagents
    ADD CONSTRAINT run_subagents_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_work_activations run_work_activations_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_activations
    ADD CONSTRAINT run_work_activations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_work_activations run_work_activations_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_activations
    ADD CONSTRAINT run_work_activations_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_versions(id);


--
-- Name: run_work_connection_usage run_work_connection_usage_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_connection_usage
    ADD CONSTRAINT run_work_connection_usage_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_work_connection_usage run_work_connection_usage_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_connection_usage
    ADD CONSTRAINT run_work_connection_usage_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_versions(id);


--
-- Name: run_work_denials run_work_denials_requester_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_denials
    ADD CONSTRAINT run_work_denials_requester_execution_id_fkey FOREIGN KEY (requester_execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_denials run_work_denials_run_id_requester_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_denials
    ADD CONSTRAINT run_work_denials_run_id_requester_activation_id_fkey FOREIGN KEY (run_id, requester_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_denials run_work_denials_run_id_workflow_version_id_relationship_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_denials
    ADD CONSTRAINT run_work_denials_run_id_workflow_version_id_relationship_i_fkey FOREIGN KEY (run_id, workflow_version_id, relationship_id) REFERENCES public.run_work_connection_usage(run_id, workflow_version_id, relationship_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_direction_responses run_work_direction_responses_continuation_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_direction_responses
    ADD CONSTRAINT run_work_direction_responses_continuation_run_id_fkey FOREIGN KEY (continuation_run_id) REFERENCES public.runs(id);


--
-- Name: run_work_direction_responses run_work_direction_responses_interaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_direction_responses
    ADD CONSTRAINT run_work_direction_responses_interaction_id_fkey FOREIGN KEY (interaction_id) REFERENCES public.durable_interactions(id) ON DELETE CASCADE;


--
-- Name: run_work_direction_responses run_work_direction_responses_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_direction_responses
    ADD CONSTRAINT run_work_direction_responses_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: run_work_direction_waits run_work_direction_waits_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_direction_waits
    ADD CONSTRAINT run_work_direction_waits_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_work_direction_waits run_work_direction_waits_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_direction_waits
    ADD CONSTRAINT run_work_direction_waits_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_versions(id);


--
-- Name: run_work_join_dispatches run_work_join_dispatches_run_id_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_join_dispatches
    ADD CONSTRAINT run_work_join_dispatches_run_id_activation_id_fkey FOREIGN KEY (run_id, activation_id) REFERENCES public.run_work_activations(run_id, activation_id) ON DELETE CASCADE;


--
-- Name: run_work_join_dispatches run_work_join_dispatches_run_id_source_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_join_dispatches
    ADD CONSTRAINT run_work_join_dispatches_run_id_source_activation_id_fkey FOREIGN KEY (run_id, source_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) ON DELETE CASCADE;


--
-- Name: run_work_notices run_work_notices_acknowledgement_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_notices
    ADD CONSTRAINT run_work_notices_acknowledgement_execution_id_fkey FOREIGN KEY (acknowledgement_execution_id) REFERENCES public.harness_executions(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_notices run_work_notices_run_id_continuation_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_notices
    ADD CONSTRAINT run_work_notices_run_id_continuation_activation_id_fkey FOREIGN KEY (run_id, continuation_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_notices run_work_notices_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_notices
    ADD CONSTRAINT run_work_notices_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_work_notices run_work_notices_run_id_requester_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_notices
    ADD CONSTRAINT run_work_notices_run_id_requester_activation_id_fkey FOREIGN KEY (run_id, requester_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_notices run_work_notices_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_notices
    ADD CONSTRAINT run_work_notices_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_versions(id);


--
-- Name: run_work_requests run_work_requests_requester_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_requests
    ADD CONSTRAINT run_work_requests_requester_execution_id_fkey FOREIGN KEY (requester_execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_requests run_work_requests_run_id_destination_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_requests
    ADD CONSTRAINT run_work_requests_run_id_destination_activation_id_fkey FOREIGN KEY (run_id, destination_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_requests run_work_requests_run_id_requester_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_requests
    ADD CONSTRAINT run_work_requests_run_id_requester_activation_id_fkey FOREIGN KEY (run_id, requester_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_requests run_work_requests_run_id_workflow_version_id_relationship__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_requests
    ADD CONSTRAINT run_work_requests_run_id_workflow_version_id_relationship__fkey FOREIGN KEY (run_id, workflow_version_id, relationship_id) REFERENCES public.run_work_connection_usage(run_id, workflow_version_id, relationship_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_results run_work_results_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_results
    ADD CONSTRAINT run_work_results_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_results run_work_results_run_id_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_results
    ADD CONSTRAINT run_work_results_run_id_activation_id_fkey FOREIGN KEY (run_id, activation_id) REFERENCES public.run_work_activations(run_id, activation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_results run_work_results_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_results
    ADD CONSTRAINT run_work_results_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_work_returns run_work_returns_run_id_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_returns
    ADD CONSTRAINT run_work_returns_run_id_request_id_fkey FOREIGN KEY (run_id, request_id) REFERENCES public.run_work_requests(run_id, request_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_returns run_work_returns_run_id_requester_continuation_activation__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_returns
    ADD CONSTRAINT run_work_returns_run_id_requester_continuation_activation__fkey FOREIGN KEY (run_id, requester_continuation_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_returns run_work_returns_run_id_source_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_returns
    ADD CONSTRAINT run_work_returns_run_id_source_activation_id_fkey FOREIGN KEY (run_id, source_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_returns run_work_returns_source_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_returns
    ADD CONSTRAINT run_work_returns_source_execution_id_fkey FOREIGN KEY (source_execution_id) REFERENCES public.harness_executions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_unresolved run_work_unresolved_run_id_activation_id_execution_id_resu_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_unresolved
    ADD CONSTRAINT run_work_unresolved_run_id_activation_id_execution_id_resu_fkey FOREIGN KEY (run_id, activation_id, execution_id, result_digest) REFERENCES public.run_work_results(run_id, activation_id, execution_id, result_digest) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_work_unresolved run_work_unresolved_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_work_unresolved
    ADD CONSTRAINT run_work_unresolved_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: run_worktrees run_worktrees_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_worktrees
    ADD CONSTRAINT run_worktrees_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: runs runs_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id);


--
-- Name: runs runs_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_versions(id);


--
-- Name: runs runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: source_approvals source_approvals_owner_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_approvals
    ADD CONSTRAINT source_approvals_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.management_principals(id);


--
-- Name: source_approvals source_approvals_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_approvals
    ADD CONSTRAINT source_approvals_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.management_principals(id);


--
-- Name: source_approvals source_approvals_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_approvals
    ADD CONSTRAINT source_approvals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: source_execution_materializations source_execution_materializations_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_execution_materializations
    ADD CONSTRAINT source_execution_materializations_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.source_storage_reservations(reservation_id);


--
-- Name: source_execution_materializations source_execution_materializations_root_id_binding_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_execution_materializations
    ADD CONSTRAINT source_execution_materializations_root_id_binding_revision_fkey FOREIGN KEY (root_id, binding_revision) REFERENCES public.source_root_bindings(root_id, binding_revision);


--
-- Name: source_execution_materializations source_execution_materializations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_execution_materializations
    ADD CONSTRAINT source_execution_materializations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: source_preparation_reconciliations source_preparation_reconciliations_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_preparation_reconciliations
    ADD CONSTRAINT source_preparation_reconciliations_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: source_preparation_reconciliations source_preparation_reconciliations_queue_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_preparation_reconciliations
    ADD CONSTRAINT source_preparation_reconciliations_queue_ticket_id_fkey FOREIGN KEY (queue_ticket_id) REFERENCES public.job_admission_queue(id);


--
-- Name: source_preparation_reconciliations source_preparation_reconciliations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_preparation_reconciliations
    ADD CONSTRAINT source_preparation_reconciliations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: source_root_bindings source_root_bindings_root_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_root_bindings
    ADD CONSTRAINT source_root_bindings_root_id_fkey FOREIGN KEY (root_id) REFERENCES public.source_root_catalog(root_id);


--
-- Name: source_root_bindings source_root_bindings_workspace_id_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_root_bindings
    ADD CONSTRAINT source_root_bindings_workspace_id_snapshot_id_fkey FOREIGN KEY (workspace_id, snapshot_id) REFERENCES public.source_snapshots(workspace_id, snapshot_id);


--
-- Name: source_root_catalog source_root_catalog_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_root_catalog
    ADD CONSTRAINT source_root_catalog_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: source_snapshot_uses source_snapshot_uses_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshot_uses
    ADD CONSTRAINT source_snapshot_uses_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.source_snapshots(snapshot_id);


--
-- Name: source_snapshots source_snapshots_approved_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_approved_source_id_fkey FOREIGN KEY (approved_source_id) REFERENCES public.source_approvals(approved_source_id);


--
-- Name: source_snapshots source_snapshots_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.source_approvals(snapshot_id);


--
-- Name: source_snapshots source_snapshots_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: run_repeat_executions work_attempt_activation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_executions
    ADD CONSTRAINT work_attempt_activation_fk FOREIGN KEY (run_id, work_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: harness_executions work_execution_activation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_executions
    ADD CONSTRAINT work_execution_activation_fk FOREIGN KEY (run_id, work_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_repeat_slots work_slot_activation_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_repeat_slots
    ADD CONSTRAINT work_slot_activation_fk FOREIGN KEY (run_id, work_activation_id) REFERENCES public.run_work_activations(run_id, activation_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: worker_credential_bindings worker_credential_bindings_approval_review_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_credential_bindings
    ADD CONSTRAINT worker_credential_bindings_approval_review_job_id_fkey FOREIGN KEY (approval_review_job_id) REFERENCES public.review_jobs(id);


--
-- Name: workflow_job_executions workflow_job_executions_job_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_job_executions
    ADD CONSTRAINT workflow_job_executions_job_execution_id_fkey FOREIGN KEY (job_execution_id) REFERENCES public.job_executions(id);


--
-- Name: workflow_job_executions workflow_job_executions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_job_executions
    ADD CONSTRAINT workflow_job_executions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: workflow_job_preparations workflow_job_preparations_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_job_preparations
    ADD CONSTRAINT workflow_job_preparations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: workflow_job_preparations workflow_job_preparations_slot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_job_preparations
    ADD CONSTRAINT workflow_job_preparations_slot_id_fkey FOREIGN KEY (slot_id) REFERENCES public.run_repeat_slots(slot_id);


--
-- Name: workflow_native_entries workflow_native_entries_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_native_entries
    ADD CONSTRAINT workflow_native_entries_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: workflow_native_entries workflow_native_entries_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_native_entries
    ADD CONSTRAINT workflow_native_entries_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: workflow_native_proofs workflow_native_proofs_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_native_proofs
    ADD CONSTRAINT workflow_native_proofs_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.harness_executions(id);


--
-- Name: workflow_native_proofs workflow_native_proofs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_native_proofs
    ADD CONSTRAINT workflow_native_proofs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: workflow_schedule_authorities workflow_schedule_authorities_actor_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedule_authorities
    ADD CONSTRAINT workflow_schedule_authorities_actor_principal_id_fkey FOREIGN KEY (actor_principal_id) REFERENCES public.management_principals(id);


--
-- Name: workflow_schedule_authorities workflow_schedule_authorities_owner_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedule_authorities
    ADD CONSTRAINT workflow_schedule_authorities_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.management_principals(id);


--
-- Name: workflow_schedule_authorities workflow_schedule_authorities_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedule_authorities
    ADD CONSTRAINT workflow_schedule_authorities_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES public.workflow_schedules(workspace_id, workflow_id);


--
-- Name: workflow_schedule_occurrences workflow_schedule_occurrences_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedule_occurrences
    ADD CONSTRAINT workflow_schedule_occurrences_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: workflow_schedule_occurrences workflow_schedule_occurrences_workflow_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedule_occurrences
    ADD CONSTRAINT workflow_schedule_occurrences_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES public.workflow_versions(id);


--
-- Name: workflow_schedule_occurrences workflow_schedule_occurrences_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedule_occurrences
    ADD CONSTRAINT workflow_schedule_occurrences_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES public.workflow_schedules(workspace_id, workflow_id);


--
-- Name: workflow_schedules workflow_schedules_updated_by_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedules
    ADD CONSTRAINT workflow_schedules_updated_by_principal_id_fkey FOREIGN KEY (updated_by_principal_id) REFERENCES public.management_principals(id);


--
-- Name: workflow_schedules workflow_schedules_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedules
    ADD CONSTRAINT workflow_schedules_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES public.workflows(workspace_id, id);


--
-- Name: workflow_stop_intents workflow_stop_intents_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_stop_intents
    ADD CONSTRAINT workflow_stop_intents_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: workflow_stop_intents workflow_stop_intents_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_stop_intents
    ADD CONSTRAINT workflow_stop_intents_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: workflow_stop_intents workflow_stop_intents_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_stop_intents
    ADD CONSTRAINT workflow_stop_intents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: workflow_trigger_jobs workflow_trigger_jobs_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_trigger_jobs
    ADD CONSTRAINT workflow_trigger_jobs_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: workflow_trigger_jobs workflow_trigger_jobs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_trigger_jobs
    ADD CONSTRAINT workflow_trigger_jobs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: workflow_trigger_jobs workflow_trigger_jobs_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_trigger_jobs
    ADD CONSTRAINT workflow_trigger_jobs_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id);


--
-- Name: workflow_trigger_jobs workflow_trigger_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_trigger_jobs
    ADD CONSTRAINT workflow_trigger_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: workflow_triggers workflow_triggers_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_triggers
    ADD CONSTRAINT workflow_triggers_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: workflow_triggers workflow_triggers_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_triggers
    ADD CONSTRAINT workflow_triggers_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id);


--
-- Name: workflow_triggers workflow_triggers_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_triggers
    ADD CONSTRAINT workflow_triggers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: workflow_versions workflow_versions_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id);


--
-- Name: workflow_versions workflow_versions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: workflows workflows_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: workspace_repository_imports workspace_repository_imports_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_repository_imports
    ADD CONSTRAINT workspace_repository_imports_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.management_principals(id);


--
-- Name: workspace_repository_imports workspace_repository_imports_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_repository_imports
    ADD CONSTRAINT workspace_repository_imports_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: workspace_root_host_configuration_heads workspace_root_host_configura_host_scope_configuration_rev_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_root_host_configuration_heads
    ADD CONSTRAINT workspace_root_host_configura_host_scope_configuration_rev_fkey FOREIGN KEY (host_scope, configuration_revision) REFERENCES public.workspace_root_host_configurations(host_scope, configuration_revision);


--
-- Name: workspace_root_policies workspace_root_policies_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_root_policies
    ADD CONSTRAINT workspace_root_policies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: workspace_root_policy_heads workspace_root_policy_heads_root_policy_id_root_policy_rev_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_root_policy_heads
    ADD CONSTRAINT workspace_root_policy_heads_root_policy_id_root_policy_rev_fkey FOREIGN KEY (root_policy_id, root_policy_revision) REFERENCES public.workspace_root_policies(root_policy_id, root_policy_revision);


--
-- Name: workspace_root_policy_heads workspace_root_policy_heads_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_root_policy_heads
    ADD CONSTRAINT workspace_root_policy_heads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: workspace_skill_versions workspace_skill_versions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_skill_versions
    ADD CONSTRAINT workspace_skill_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: workspace_skills workspace_skills_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_skills
    ADD CONSTRAINT workspace_skills_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: workspace_skills workspace_skills_workspace_id_skill_id_head_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_skills
    ADD CONSTRAINT workspace_skills_workspace_id_skill_id_head_version_fkey FOREIGN KEY (workspace_id, skill_id, head_version) REFERENCES public.workspace_skill_versions(workspace_id, skill_id, version);


--
-- PostgreSQL database dump complete
--


