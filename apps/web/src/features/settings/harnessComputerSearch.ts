import { z } from 'zod'
import { HarnessSettingsSearchSchema } from '@foreman-code/contracts/management'
/** URL selection only; authenticated main/registration readback supplies the host authority. */
export const HarnessComputerSearchSchema = HarnessSettingsSearchSchema.extend({ computer: z.union([z.literal('main'), z.uuid()]).optional() })
