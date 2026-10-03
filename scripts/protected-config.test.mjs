import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APPROVAL_LABEL, protectedFiles, reviewProtectedChanges } from './protected-config.mjs'

describe('protected files', () => {
  it('covers lint, test, type, CI and dependency configuration', () => {
    const paths = [
      'packages/eslint-config/index.mjs', 'apps/web/eslint.config.mjs', 'apps/web/vitest.config.ts',
      'apps/api/tsconfig.build.json', 'apps/worker/package.json', '.npmrc', 'pnpm-workspace.yaml',
      '.github/workflows/ci.yml', 'scripts/check-lint-suppressions.mjs', 'scripts/heavy-job.mjs', 'AGENTS.md',
    ]
    assert.deepEqual(protectedFiles(paths), paths)
  })

  it('leaves application code and tests unprotected', () => {
    assert.deepEqual(protectedFiles(['apps/api/src/app.ts', 'apps/web/src/Board.test.tsx', 'docs/adr/x.md']), [])
  })
})

describe('protected change review', () => {
  const base = { changedInPullRequest: ['apps/web/eslint.config.mjs'], changedSincePreviousPush: [], isNewPush: false }

  it('passes pull requests that do not touch protected files', () => {
    const result = reviewProtectedChanges({ ...base, changedInPullRequest: ['apps/api/src/app.ts'], labels: [] })
    assert.deepEqual(result, { pass: true, changed: [], revokeApproval: false })
  })

  it('fails protected changes until the approval label is present', () => {
    assert.equal(reviewProtectedChanges({ ...base, labels: [] }).pass, false)
    assert.equal(reviewProtectedChanges({ ...base, labels: [APPROVAL_LABEL] }).pass, true)
  })

  it('keeps approval when a later push only changes unprotected files', () => {
    const result = reviewProtectedChanges({
      ...base, isNewPush: true, changedSincePreviousPush: ['apps/api/src/app.ts'], labels: [APPROVAL_LABEL],
    })
    assert.deepEqual(result, { pass: true, changed: ['apps/web/eslint.config.mjs'], revokeApproval: false })
  })

  it('revokes approval when a later push changes protected files again', () => {
    const result = reviewProtectedChanges({
      ...base, isNewPush: true, changedSincePreviousPush: ['apps/web/eslint.config.mjs'], labels: [APPROVAL_LABEL],
    })
    assert.deepEqual(result, { pass: false, changed: ['apps/web/eslint.config.mjs'], revokeApproval: true })
  })

  it('revokes approval when the previous head cannot be compared', () => {
    const result = reviewProtectedChanges({
      ...base, isNewPush: true, changedSincePreviousPush: undefined, labels: [APPROVAL_LABEL],
    })
    assert.equal(result.revokeApproval, true)
    assert.equal(result.pass, false)
  })
})
