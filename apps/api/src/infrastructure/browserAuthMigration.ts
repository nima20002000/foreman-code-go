/** Better Auth 1.7.5 core schema; application-owned migrations remain authoritative. */
export const browserAuthMigration = { version: 170018, sql: `
  create table browser_auth_user (
    id text primary key,
    name text not null,
    email text not null unique,
    "emailVerified" boolean not null default false,
    image text,
    "createdAt" timestamptz not null default now(),
    "updatedAt" timestamptz not null default now(),
    check (email = lower(email))
  );
  create table browser_auth_session (
    id text primary key,
    token text not null unique,
    "userId" text not null references browser_auth_user(id) on delete cascade,
    "expiresAt" timestamptz not null,
    "ipAddress" text,
    "userAgent" text,
    "createdAt" timestamptz not null default now(),
    "updatedAt" timestamptz not null default now()
  );
  create index browser_auth_session_user_idx on browser_auth_session("userId");
  create index browser_auth_session_expiry_idx on browser_auth_session("expiresAt");
  create table browser_auth_account (
    id text primary key,
    "userId" text not null references browser_auth_user(id) on delete cascade,
    "accountId" text not null,
    "providerId" text not null,
    password text,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamptz,
    "refreshTokenExpiresAt" timestamptz,
    scope text,
    "createdAt" timestamptz not null default now(),
    "updatedAt" timestamptz not null default now(),
    unique ("providerId", "accountId")
  );
  create index browser_auth_account_user_idx on browser_auth_account("userId");
  create table browser_auth_verification (
    id text primary key,
    identifier text not null,
    value text not null,
    "expiresAt" timestamptz not null,
    "createdAt" timestamptz not null default now(),
    "updatedAt" timestamptz not null default now()
  );
  create index browser_auth_verification_identifier_idx on browser_auth_verification(identifier);

  -- Deleting a user/principal must not silently reopen first-owner registration.
  create table browser_auth_owner (
    singleton boolean primary key default true check (singleton),
    user_id text not null unique references browser_auth_user(id) on delete restrict,
    principal_id text not null unique references management_principals(id) on delete restrict,
    created_at timestamptz not null default now()
  );
  -- The key is a digest, never a password, email, setup secret or bearer token.
  create table browser_auth_attempts (
    key text primary key,
    attempts integer not null,
    expires_at timestamptz not null
  );
  create index browser_auth_attempts_expiry_idx on browser_auth_attempts(expires_at);
` } as const
