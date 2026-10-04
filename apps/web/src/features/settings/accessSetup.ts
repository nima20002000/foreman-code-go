import { BrowserCredentialSetupSchema, type BrowserCredentialSetup } from '@foreman-code/contracts/management'

/** Quote one POSIX shell argument. No user input is interpolated as shell syntax. */
export function shellArgument(value: string): string {
  if (Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Control characters are not allowed.')
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}
export function browserCredentialCommand(input: BrowserCredentialSetup): string {
  const value = BrowserCredentialSetupSchema.parse(input)
  return ['corepack pnpm --filter @foreman-code/api credential issue', '--name', shellArgument(value.name),
    '--days', String(value.days), '--audience operator', '--access', value.access,
    ...(value.workspaceId ? ['--workspace', shellArgument(value.workspaceId)] : [])].join(' ')
}
export function revokeCredentialCommand(principalId: string): string {
  if (!/^principal-[a-zA-Z0-9-]+$/.test(principalId)) throw new Error('Unexpected principal ID.')
  return `corepack pnpm --filter @foreman-code/api credential revoke ${shellArgument(principalId)}`
}
