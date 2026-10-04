# Disposable test resources

Run `corepack pnpm db:up` before database-backed tests. It starts only
`compose.test.yaml`, with the fixed Compose project `graphql-tests`, volume
`graphql-tests_graphql-test-data`, loopback port 55439, and test-only credentials.
The application Compose file and its database are independent. `db:down` checks
test ownership labels before removing only this test project and its volume.

Root and API package test commands provision UUID databases on that instance.
The root unit command also runs the integration-runner and acceptance safety
script tests before the workspace suites.
API Vitest global setup also provisions resources for direct `pnpm exec vitest`
invocations. Ambient database selectors (including DB-gated unit-test selectors)
are replaced with the disposable URL. Real `pg` connections outside the test
endpoint are rejected before connection. No application or default database URL
is a test fallback. Fixture schema search paths exclude `public`.

Each test invocation or integration slot owns a private temporary root containing
its home, app files and workspaces, MCP launcher/routes, Codex and Claude homes,
XDG directories, logs, and acceptance evidence. Cleanup checks filesystem and
PostgreSQL ownership markers before deletion. Uncertain process or cleanup
settlement retains resources. Integration logs are retained in an owned directory
under ignored `.logs/test-integration/`.

Native acceptance uses dedicated authentication. Set `GRAPHQL_TEST_CODEX_AUTH_FILE`
and/or `GRAPHQL_TEST_OPENCODE_AUTH_FILE` to explicit test authentication files;
these are copied into private homes. API-key authentication can use
`GRAPHQL_TEST_OPENAI_API_KEY`, `GRAPHQL_TEST_ANTHROPIC_API_KEY`, or
`GRAPHQL_TEST_OPENCODE_API_KEY`. Ambient provider keys and real harness homes are
not reused. Do not commit credential files. Acceptance fails when its native
prerequisites or dedicated authentication are unavailable.

Run full integration verification with `GRAPHQL_INTEGRATION_SHARDS=12 corepack
pnpm test:integration`. Package integration uses the same runner. Unit and native
acceptance commands use the same provisioner; standalone local acceptance also
uses this dedicated instance. Prepared native acceptance also checks that the
selected API identity matches its owned database before submitting work. Lifecycle and suite runs must not overlap with
`db:down` or the opt-in dependency restart in `test:production`.
