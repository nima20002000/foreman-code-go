import {
  AutoJobDefinitionSpecSchema,
  ResolvedJobDefinitionSpecSchema,
} from '@foreman-code/contracts/jobs'
import {
  AutoVerificationJobSpecSchema,
  ResolvedVerificationJobSpecSchema,
  type JobAuthoringChoicesRecord,
  type JobDefinitionSpecRecord,
  type JobVerificationTemplate,
  type VerificationJobSpec,
} from '@foreman-code/contracts/job-verification'

export function templateKey(template: JobVerificationTemplate) {
  return JSON.stringify([template.profileId, template.profileRevision, template.suite])
}

export function autoPolicyKey(requirement: NonNullable<JobAuthoringChoicesRecord['autoPolicies']>[number]) {
  return JSON.stringify(requirement)
}

export function editorJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must be valid JSON.`, { cause: error })
    throw error
  }
}

export function verificationWithLimits(
  text: string,
  limits: NonNullable<JobAuthoringChoicesRecord['autoPolicies']>[number]['limits'],
): string {
  const request = editorJson(text, 'Verification request')
  if (!request || typeof request !== 'object' || Array.isArray(request) || !('resources' in request)) {
    throw new Error('Verification request must contain a resources object.')
  }
  const resources = request.resources
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    throw new Error('Verification resources must be an object.')
  }
  // Replace limits before validation so a policy choice can repair an invalid reservation.
  return JSON.stringify({ ...request, resources: { ...resources, limits } }, null, 2)
}

export function editorSpec(input: {
  auto: boolean
  target: JobDefinitionSpecRecord['target'] | undefined
  source: JobDefinitionSpecRecord['source'] | undefined
  policy: JobDefinitionSpecRecord['policy'] | undefined
  limits: NonNullable<JobAuthoringChoicesRecord['autoPolicies']>[number]['limits'] | undefined
  argv: string
  cwd: string
  inputs: string
  outputs: string
  verification: VerificationJobSpec['verification'] | undefined
}): JobDefinitionSpecRecord {
  const verification = input.verification
  const schema = input.auto ? AutoJobDefinitionSpecSchema : ResolvedJobDefinitionSpecSchema
  // Choose the editor's mode so validation reports field errors instead of union alternatives.
  const verificationSchema = input.auto ? AutoVerificationJobSpecSchema : ResolvedVerificationJobSpecSchema
  const spec = {
    target: input.auto ? { kind: 'auto' } : input.target,
    ...(input.auto ? { limits: verification?.resources.limits ?? input.limits } : {}),
    source: input.source,
    policy: input.policy,
    argv: editorJson(input.argv, 'Executable and arguments'),
    ...(input.cwd ? { relativeCwd: input.cwd } : {}),
    inputs: editorJson(input.inputs, 'File inputs'),
    outputs: editorJson(input.outputs, 'Output policy'),
    ...(verification ? { verification } : {}),
  }
  if (verification) return verificationSchema.parse(spec)
  return schema.parse(spec)
}
