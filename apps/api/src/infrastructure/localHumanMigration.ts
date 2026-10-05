import { ManagementActionSchema } from '@graphql/contracts/management'

export const localHumanMigration = { version: 2026100401, sql: `
  alter table management_principals alter column token_hash drop not null;
  alter table management_principals add constraint management_principals_credential_required
    check (token_hash is not null or id = 'principal-local-human');
  create table local_human_principal (
    singleton boolean primary key default true check (singleton),
    principal_id text not null unique references management_principals(id)
  );
  do $$
  declare browser_table text; owner_id text;
  begin
    if to_regclass(format('%I.browser_auth_owner', current_schema())) is not null then
      execute format('select principal_id from %I.browser_auth_owner where singleton = true', current_schema())
        into owner_id;
    end if;
    if owner_id is null then
      insert into management_principals(id,name,audience,token_hash,grants,expires_at)
        values('principal-local-human','Local human','operator',null,
          '${JSON.stringify([{ actions: [...ManagementActionSchema.options], scope: {} }])}'::jsonb,
          '9999-12-31T23:59:59Z');
      owner_id := 'principal-local-human';
    end if;
    -- Retain command and resource ownership without changing credentials or accepted facts.
    insert into local_human_principal(singleton,principal_id) values(true,owner_id);
    foreach browser_table in array array[
      'browser_auth_owner', 'browser_auth_session', 'browser_auth_account',
      'browser_auth_verification', 'browser_auth_attempts', 'browser_auth_user'
    ] loop
      execute format('drop table if exists %I.%I', current_schema(), browser_table);
    end loop;
  end $$;
` } as const
