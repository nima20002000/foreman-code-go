import { applyOperatorChatSettings, operatorChatSettings, operatorHarnessDefaults, type AgentDefaults, type HarnessConfiguration, type OperatorChatSettings } from '@graphql/contracts'
import { useAgentDefaultsQuery, useHarnessDefaultsQuery, useUpdateAgentDefaultsMutation } from '../../shared/api/query'
import { useRevisionedForm } from '../settings/revisionedForm'

export function useOperatorSettings(enabled: boolean) {
  const query = useAgentDefaultsQuery(enabled)
  const harnesses = useHarnessDefaultsQuery({ enabled })
  const mutation = useUpdateAgentDefaultsMutation()
  const form = useRevisionedForm<AgentDefaults>(query.data, 'operator-chat:defaults')
  const operator = form.draft?.operator
  const settings = operator ? operatorChatSettings(operator.harness, operator.showThinking) : undefined
  const save = () => form.save(async (input) => {
    const result = await mutation.mutateAsync(input)
    return result.value
  })
  function change(settings: OperatorChatSettings) {
    if (!form.draft || !operator || form.isSaving || form.uncertain) return
    const preset = harnesses.data?.defaults[settings.harness]
    const base = operator.harness.harness === settings.harness ? operator.harness : preset ? operatorHarnessDefaults(preset) : undefined
    if (!base) return
    const next = { ...operator, harness: applyOperatorChatSettings(base, settings), showThinking: settings.showThinking }
    if (operator.harness.harness !== settings.harness) delete next.harnessProfileSelection
    form.setDraft({ ...form.draft, operator: next })
    void save()
  }
  function changeAccess(harness: HarnessConfiguration): Promise<boolean> {
    if (!form.draft || !operator || operator.harness.harness !== harness.harness || form.isSaving || form.uncertain) return Promise.resolve(false)
    form.setDraft({ ...form.draft, operator: { ...operator, harness } })
    return save()
  }
  return { query, form, settings, harness: operator?.harness, change, changeAccess, save }
}
