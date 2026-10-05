// Verification sets TMPDIR to its private quota-backed executable scratch.
export const persistentFixtureRoot = process.env.TMPDIR ?? '/var/tmp';
