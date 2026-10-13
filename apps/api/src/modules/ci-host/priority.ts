import type { CiRunRecord } from '@foreman-code/contracts'

const infrastructureFiles = new Set([
  'apps/api/src/modules/jobs/dispatch.ts',
  'apps/api/src/modules/jobs/dispatch.test.ts',
  'scripts/test-db.mjs',
  'scripts/test-integration.mjs',
  '.github/workflows/ci.yml',
  '.github/workflows/ci.yaml',
  '.circleci/config.yml',
  '.circleci/config.yaml',
])

export function onlyCiInfrastructure(files: string[]): boolean {
  return files.length > 0 && files.every(file =>
    file.startsWith('apps/api/src/modules/ci-host/')
    || /^apps\/api\/src\/modules\/jobs\/ci[^/]*\.(?:ts|mjs|mts)$/.test(file)
    || /^scripts\/ci-[^/]+\.mjs$/.test(file)
    || infrastructureFiles.has(file))
}

export function compareCiQueue(left: CiRunRecord, right: CiRunRecord): number {
  return Number(!!right.gate) - Number(!!left.gate)
    || Number(right.priority === 'high') - Number(left.priority === 'high')
    || Date.parse(left.queuedAt) - Date.parse(right.queuedAt)
    || (left.gate && right.gate && left.groupId === right.groupId
      ? Number(left.suite === 'integration') - Number(right.suite === 'integration') : 0)
    || left.id.localeCompare(right.id)
}

export function ciQueueReason(run: CiRunRecord): string {
  return run.message ?? 'Waiting for an eligible CI slot; high priority tickets run before normal, oldest first.'
}

export const CI_QUEUE_ORDER = "case when record->>'gate'='true' then 0 else 1 end, "
  + "case when record->>'priority'='high' then 0 else 1 end, record->>'queuedAt', "
  + "case when record->>'gate'='true' and record->>'suite'='integration' then 1 else 0 end,id"
