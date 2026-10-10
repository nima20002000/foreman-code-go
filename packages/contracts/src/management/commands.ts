import { z } from 'zod'

export const CommandIdSchema = z.string().trim().min(8).max(200)
export const ExpectedRevisionSchema = z.number().int().nonnegative()
