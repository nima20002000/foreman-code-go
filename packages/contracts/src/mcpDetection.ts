import { z } from 'zod';
import { APP_MCP_TOKEN_NAMES } from './product.js';

/** Credential mechanism evidence only; resolved credentials never cross this boundary. */
export const McpCredentialArrangementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('environment_variable'),
    environmentVariable: z.enum(APP_MCP_TOKEN_NAMES),
  }).strict(),
  z.object({ kind: z.literal('scoped_http_header') }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);
export type McpCredentialArrangement = z.infer<typeof McpCredentialArrangementSchema>;
