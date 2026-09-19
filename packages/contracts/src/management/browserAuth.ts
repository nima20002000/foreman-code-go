import { z } from "zod";

const EmailSchema = z.string().trim().toLowerCase().email().max(254);
const PasswordSchema = z.string().min(12).max(128);

/** No caller-supplied role, principal ID, grants, or callback URL is accepted. */
export const OwnerSetupRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: EmailSchema,
  password: PasswordSchema,
  setupSecret: z.string().min(32).max(256),
}).strict();
export type OwnerSetupRequest = z.infer<typeof OwnerSetupRequestSchema>;

export const OwnerSetupStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("complete") }).strict(),
  z.object({ state: z.literal("ready") }).strict(),
  z.object({ state: z.literal("locked"), reason: z.enum([
    "setup-disabled", "existing-installation", "inconsistent-owner",
  ]) }).strict(),
]);
export type OwnerSetupStatus = z.infer<typeof OwnerSetupStatusSchema>;
export const OwnerSetupResponseSchema = z.object({ created: z.literal(true) }).strict();

// Sign-in accepts existing passwords independently of future setup password policy.
export const BrowserSignInRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128),
}).strict();
export type BrowserSignInRequest = z.infer<typeof BrowserSignInRequestSchema>;
export const BrowserSignInResponseSchema = z.object({ signedIn: z.literal(true) }).strict();

function hasUnsafePathCharacters(value: string): boolean {
  return value.includes("\\") || Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
}

/** Only an app-relative path can survive an authentication redirect. */
export function safeAuthReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000 || !value.startsWith("/")
    || value.startsWith("//") || hasUnsafePathCharacters(value)) return "/workspaces";
  try {
    const url = new URL(value, "https://auth-return.invalid");
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
    if (url.origin !== "https://auth-return.invalid" || path.startsWith("//")
      || hasUnsafePathCharacters(path)
      || path === "/sign-in" || path === "/setup" || path.startsWith("/api/")) return "/workspaces";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/workspaces"; }
}
export const BrowserAuthSearchSchema = z.object({
  returnTo: z.unknown().optional().transform(safeAuthReturnTo),
  notice: z.enum(["owner-created", "sign-out-unconfirmed", "signed-out"]).optional().catch(undefined),
});
