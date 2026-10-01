import { z } from 'zod';

/** Credential mechanism evidence only; resolved credentials never cross this boundary. */
export const McpCredentialArrangementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('environment_variable'),
    environmentVariable: z.literal('GRAPHQL_MCP_TOKEN'),
  }).strict(),
  z.object({ kind: z.literal('scoped_http_header') }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);
export type McpCredentialArrangement = z.infer<typeof McpCredentialArrangementSchema>;
