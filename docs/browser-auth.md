# Browser owner authentication

## What changes

The browser uses Better Auth 1.7.5 with PostgreSQL-backed sessions. The browser does
not need to issue or paste an Operator bearer token. The owner account is linked
to an existing management principal; every protected request rechecks that
principal's current grants, revocation and expiry. The existing route/service
permission checks are still authoritative.

CLI and MCP Bearer authentication are unchanged. An explicit Authorization header
always wins over cookies; malformed or invalid bearer credentials cannot fall
back to an authenticated browser session. Legacy token-to-cookie enrollment is
rejected when Better Auth is configured. The legacy backend path remains available
when browser auth is entirely unconfigured, for existing non-browser callers.

## One-time server configuration

1. Install dependencies with the existing Corepack/pnpm workflow. Do not change the
   48-hour release-age settings or add exclusions. The exact new dependency is
   `better-auth@1.7.5`; regenerate and commit the workspace lockfile locally.
2. Generate TWO DIFFERENT secrets using the following command twice:

   ```sh
   node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))'
   ```

3. Add the following fields to the existing, private `apps/api/.env`, preserving
   its other values. Substitute the generated secrets; the angle-bracket values
   below are documentation placeholders, not usable configuration:

   ```dotenv
   BETTER_AUTH_SECRET=<first-generated-secret>
   BETTER_AUTH_URL=http://127.0.0.1:5173
   OWNER_SETUP_SECRET=<second-generated-secret>
   ```

   `corepack pnpm dev` already loads `apps/api/.env`. For a separate local test
   database, set `GRAPHQL_API_ENV_FILE` to an absolute path to a private env file.
   Keep `BETTER_AUTH_SECRET`
   stable across restarts so existing cookies remain valid. Never use a `VITE_`
   variable for either secret, expose it in a URL, or commit the private `.env`.
   Direct `dev:api`/production starts need the same environment supplied by their
   existing launcher; those commands do not gain a new implicit dotenv loader.

4. On an existing installation, explicitly choose an active, non-delegated
   Operator principal and add its ID:

   ```dotenv
   OWNER_OPERATOR_PRINCIPAL_ID=principal-<existing-id>
   ```

   The selection is SERVER configuration, never a public setup-form field.
   Existing credentials of any audience, including revoked ones, cause setup to
   fail closed unless a principal is explicitly selected. No grants are widened
   and no existing principal's expiry or bearer token is changed.

   This read-only SQL identifies eligible principals using the existing database
   administration workflow:

   ```sql
   select id, name, grants, expires_at
   from management_principals
   where audience = 'operator' and delegated_from is null
     and revoked_at is null and expires_at > now()
   order by name, id;
   ```

   A principal without app-wide `settings:read` / `settings:update` remains unable
   to read / save Workspace defaults respectively. Authentication is not an
   authorization upgrade. Choose the intended existing owner authority, not a
   temporary worker/chat/run credential. If there is no eligible principal, stop
   and resolve that through the existing local credential administration flow;
   do not delete records just to make setup appear fresh.

5. Restart the local API with the new code and environment, then run the normal
   `corepack pnpm dev` flow. The dev launcher may reuse an already-running API,
   so simply starting a second launcher will not reload that process's code or
   environment. No SSH, router or VPS changes are required or included.
6. Open `http://127.0.0.1:5173/setup`, enter the one-time setup secret, your name,
   email and a password of at least 12 characters. After creation, sign in with
   email and password. No application bearer token is shown or stored in browser
   JavaScript. Remove `OWNER_SETUP_SECRET` from the server environment afterward
   and restart the API. The owner stays registered; setup does not reopen.

Use one exact browser origin consistently. `127.0.0.1` and `localhost` are different
origins and cookie hosts, as are different ports. A custom supported loopback
origin must match `BETTER_AUTH_URL` exactly. Existing loopback Host/Origin
restrictions stay in place; this feature does not enable remote public access.
Cookies are HttpOnly, SameSite=Strict and Secure when the configured origin is
HTTPS. Local HTTP uses non-Secure cookies, consistent with the existing local
stack. No wildcard trusted origins or trust-proxy changes are introduced.

## Bootstrap and session guarantees

Setup always requires proof from the private server configuration, even on a new
installation. Account creation, the Better Auth credential-password record, the
Operator authority record (fresh installations only) and the singleton owner link
are committed in one PostgreSQL transaction. An advisory lock serializes setup;
a table lock protects the existing-installation decision against concurrent CLI
credential creation. The singleton/FK constraints prevent a partial delete from
silently reopening registration. An orphaned Better Auth user locks setup rather
than creating another owner.

For a genuinely fresh installation with no management principals, setup creates
an app-wide Operator authority using the existing ManagementActionSchema. Its
expiry is ten years from creation. The generated bearer secret is discarded and
never returned. Browser sessions have a seven-day lifetime with refresh after a
day of active use; any earlier principal expiry still takes precedence. Existing
installations retain their principal's existing permissions and expiry exactly.

Better Auth's normal public sign-up is disabled in its configuration. The app
registers no Better Auth catch-all endpoint: only setup status, owner setup and
email/password sign-in are public, matched by exact path and HTTP method.
`POST /api/auth/sign-up/email` always rejects registration. The app does not expose
password reset, account deletion, email changes, OAuth or user invitation APIs.
No verified-email claim is made: ownership comes from the private setup secret,
not an email-delivery verification service.

Sign-out first asks Better Auth to verify the signed session, then requires a
successful PostgreSQL deletion of that session before reporting success. This is
important because Better Auth 1.7.5's own sign-out handler catches database delete
failures. Cookies are cleared only after the durable operation succeeds. A lost
reply or unavailable database is reported as unconfirmed, with a retry action;
it is never presented as successful global revocation. CLI/MCP credentials and
other browser sessions are not revoked by signing out this browser.

Mutation origins must match the configured browser origin exactly. Setup and
sign-in have shared PostgreSQL attempt limits; user-provided proxy/IP headers are
not trusted. All Set-Cookie values are forwarded separately. The API readback is
an allowlisted principal view, never Better Auth's raw token-bearing response.

## Browser behavior

All network calls remain inside the existing ApiClient boundary and are parsed
with shared Zod contracts. TanStack Query owns request/server state. Identity
changes reuse the app's cancellation generation, cache clearing, persisted-draft
cleanup and cross-tab identity notification; they do not introduce another
credential in localStorage or sessionStorage.

A missing/expired login sends protected routes to `/sign-in` with a sanitized local
return path. A valid login with revoked/expired Operator authority shows 403
without a redirect loop. Backend/session-check failures show a retryable error and
hide protected content. Workspace defaults specifically distinguishes 401, 403
and backend failures: an access denial hides even an unsaved retained draft and
stays latched through subsequent network failures; an ordinary refresh outage
keeps an authorized user's edits. The Account page at `/account` shows the
profile, principal permissions and Sign out instead of token-generation/paste
instructions. The old App access URL redirects there.

## Verification

See the bundle's VERIFY.md for exact commands. Application tests were written but
NOT run while preparing this bundle. No dependency install, full typecheck, lint,
build, live browser verification or PostgreSQL execution was performed. A
syntax-only TypeScript parse is not a passing build or test result.

## Primary implementation references

- Better Auth Fastify integration: https://better-auth.com/docs/integrations/fastify
- Better Auth options: https://better-auth.com/docs/reference/options
- Better Auth database schema: https://better-auth.com/docs/concepts/database
- Better Auth 1.7.5 release: https://github.com/better-auth/better-auth/releases/tag/v1.7.5
- Pinned sign-out implementation: https://github.com/better-auth/better-auth/blob/v1.7.5/packages/better-auth/src/api/routes/sign-out.ts

The official release date was checked, but npm publish times for the complete
resolved dependency graph were not validated here. The unchanged pnpm install
policy is the enforcement gate; a strict frozen-lockfile CI install still requires
the locally regenerated lockfile.
