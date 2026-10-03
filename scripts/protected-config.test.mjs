import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { protectedFiles } from './protected-config.mjs'

describe('protected files', () => {
  it('covers lint, test, type, CI and dependency configuration', () => {
    const paths = [
      'packages/eslint-config/index.mjs', 'apps/web/eslint.config.mjs', 'apps/web/vitest.config.ts',
      'apps/api/tsconfig.build.json', 'apps/worker/package.json', '.npmrc', 'pnpm-workspace.yaml',
      '.github/workflows/ci.yml', 'scripts/check-lint-suppressions.mjs', 'scripts/heavy-job.mjs', 'AGENTS.md',
      'scripts/test-results.mjs', 'scripts/label-approval.mjs', 'test-policy.json',
      'scripts/stryker.config.mjs', 'scripts/mutation-targets.mjs', 'scripts/run-mutation-tests.mjs',
    ]
    assert.deepEqual(protectedFiles(paths), paths)
  })

  it('leaves application code and tests unprotected', () => {
    assert.deepEqual(protectedFiles(['apps/api/src/app.ts', 'apps/web/src/Board.test.tsx', 'docs/adr/x.md']), [])
  })
})
