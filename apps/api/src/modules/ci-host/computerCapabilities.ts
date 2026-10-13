import type { HostCiComputer } from './service.js'

export function isGitHubComputer(computer: HostCiComputer): boolean {
  return computer.hostRef.kind === 'cloud' && computer.hostRef.provider === 'github'
}

export function supportsUserSystemd(computer: HostCiComputer): boolean {
  return computer.hostRef.kind !== 'cloud' || computer.userSystemd?.supported === true
}

