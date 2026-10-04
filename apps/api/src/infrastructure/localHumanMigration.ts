import { ManagementActionSchema } from '@graphql/contracts/management'

export const localHumanMigration = { version: 2026100401, sql: `
  insert into management_principals(id,name,audience,token_hash,grants,expires_at)
    values('principal-local-human','Local human','operator','local-human:no-credential',
      '${JSON.stringify([{ actions: [...ManagementActionSchema.options], scope: {} }])}'::jsonb,
      '9999-12-31T23:59:59Z');
  create table local_human_principal (
    singleton boolean primary key default true check (singleton),
    principal_id text not null unique references management_principals(id)
  );
  insert into local_human_principal(singleton,principal_id) values(true,'principal-local-human');
  do $$
  declare browser_table text;
  begin
    foreach browser_table in array array[
      'browser_auth_owner', 'browser_auth_session', 'browser_auth_account',
      'browser_auth_verification', 'browser_auth_attempts', 'browser_auth_user'
    ] loop
      execute format('drop table if exists %I.%I', current_schema(), browser_table);
    end loop;
  end $$;
` } as const
