export const sessionControlsMigration = {
  version: 288601,
  sql: `create table conversation_session_controls (
    conversation_id text primary key references operator_conversations(id) on delete cascade,
    record jsonb not null
  );`,
}
