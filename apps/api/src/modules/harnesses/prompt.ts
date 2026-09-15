import type { HarnessExecutionRequest } from '@graphql/contracts'

import { HarnessExecutionError } from './errors.js'

/** UTF-8 bytes, including system prompt, skill references, and accepted inputs. */
export const MAX_HARNESS_PROMPT_BYTES = 8 * 1024 * 1024

export function buildHarnessPrompt(request: HarnessExecutionRequest): string {
  const skills = request.configuration.assignedSkills.length > 0
    ? request.configuration.assignedSkills.map((skill) => `${skill.skillId}@${skill.version}`).join(', ')
    : 'None'
  const prompt = [
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
  if (Buffer.byteLength(prompt, 'utf8') > MAX_HARNESS_PROMPT_BYTES) {
    throw new HarnessExecutionError('HARNESS_INPUT_TOO_LARGE', 'The combined harness prompt exceeds the 8 MiB UTF-8 input limit. Reduce the workflow input or predecessor result.')
  }
  return prompt
}
