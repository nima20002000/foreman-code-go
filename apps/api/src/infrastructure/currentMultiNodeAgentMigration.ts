import { currentStagedAgentsMigration } from './currentStagedAgentsMigration.js'
import { currentWorkflowWriterMigration } from './currentWorkflowWriterMigration.js'
/** Remove only the obsolete Agent uniqueness rule. Node identities still remain unique.
 * Existing immutable workflow versions and Run snapshots are not changed. */
const graphValidation = currentWorkflowWriterMigration.sql.slice(
  currentWorkflowWriterMigration.sql.indexOf('create function eng04_validate_current_graph('),
  currentWorkflowWriterMigration.sql.indexOf('create function eng04_preserve_current_geometry('),
)
if (!graphValidation || !graphValidation.includes("count(distinct n->>'agentId')")) throw new Error('Current graph validation contract changed.')
const publication=currentStagedAgentsMigration.sql.match(/create or replace function eng04_check_current_publication\(\)[\s\S]*?end \$\$;/)?.[0]
if(!publication)throw new Error('Current publication validation contract changed.')
export const currentMultiNodeAgentMigration = {version:283802,sql:graphValidation
  .replace('create function eng04_validate_current_graph(', 'create or replace function eng04_validate_current_graph(')
  .replace("    or jsonb_array_length(graph->'nodes')<>(select count(distinct n->>'agentId') from jsonb_array_elements(graph->'nodes') n)\n",'')
  + publication.replace("<>jsonb_array_length(graph->'nodes')","<>(select count(distinct n->>'agentId') from jsonb_array_elements(graph->'nodes') n where coalesce(n->>'kind','agent')='agent')")}
