// Verification sets TMPDIR to private quota-backed executable scratch.
export const persistentFixtureRoot = process.env.TMPDIR ?? '/var/tmp'
