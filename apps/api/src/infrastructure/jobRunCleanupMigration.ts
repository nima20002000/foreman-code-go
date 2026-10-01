/** Additive stop-only owner receipt on the existing job intent, not a queue. */
export const jobRunCleanupMigration={version:283806,sql:String.raw`
alter table job_dispatch_intents add column cancel_cleanup jsonb;
alter table job_dispatch_intents add constraint job_cleanup_actual_subject check(cancel_cleanup is null or (
 (jsonb_typeof(cancel_cleanup)='object' and cancel_cleanup ?& array['schemaVersion','id','commandId','workspaceId','workflowId','workflowVersionId','runId','executionId','attemptId','operationId','bindingHash','jobOwner','runOwner','reason','cleanupRequestedAt','requestedAt']
 and cancel_cleanup->>'schemaVersion'='1' and cancel_cleanup->>'executionId'=execution_id
 and cancel_cleanup->>'commandId'=cancel_command_id
 and cancel_cleanup->>'attemptId'=intent->>'attemptId'
 and cancel_cleanup->>'operationId'=intent->>'operationId'
 and cancel_cleanup->>'bindingHash'=intent->>'bindingHash'
 and cancel_cleanup->'jobOwner'=intent->'owner'
 and intent->'subject'->>'kind'='workflow-node'
 and cancel_cleanup->>'runId'=intent->'subject'->>'runId'
 and cancel_cleanup->>'workflowId'=intent->'subject'->>'workflowId'
 and cancel_cleanup->>'workspaceId'=workspace_id) is true));
`}
