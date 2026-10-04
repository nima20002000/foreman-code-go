# Live native acceptance

Run `corepack pnpm db:up` and `corepack pnpm test:acceptance` from the repository
root on the computer with provider credentials. The root command uses the heavy
job queue, builds shared contracts, and runs the existing
`eng03-c-native.acceptance.test.ts` file with native execution enabled.

The runner creates a unique loopback PostgreSQL database for each invocation and
supplies it as `ENG03_A_TEST_DATABASE_URL`. It closes the owned test process group
and removes that database after success or failure. The shared application
database and PostgreSQL container remain running. `TEST_DATABASE_URL` is not set.

Set `ENG03_A_OPENCODE_BINARY` to the qualified OpenCode executable when selecting
a pinned installation; the acceptance helper uses this explicit path. PATH alone
does not override its configured binary. Qualification, authentication, scoped
App MCP validation, and harness sandbox checks still run through the native path.
