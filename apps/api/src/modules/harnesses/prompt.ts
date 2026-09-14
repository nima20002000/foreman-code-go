import type { HarnessExecutionRequest } from '@graphql/contracts'

export function buildHarnessPrompt(request: HarnessExecutionRequest): string {
  const skills = request.configuration.assignedSkills.length > 0
    ? request.configuration.assignedSkills.map((skill) => `${skill.skillId}@${skill.version}`).join(', ')
    : 'None'
  return [
    'PRODUCT AGENT SYSTEM PROMPT',
    request.configuration.prompt.system,
    '',
    `ASSIGNED SKILLS: ${skills}`,
    '',
    'ACCEPTED INPUT FROM THE WORKFLOW',
    JSON.stringify(request.input),
    '',
    'Treat the accepted input above as authoritative. Do not rediscover or replace it through files, memory, or external research.',
  ].join('\n')
}
