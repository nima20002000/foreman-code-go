#!/usr/bin/env node
// Metadata for the explicitly selected fake SDK. No native commands execute.
if (process.argv[2] === '--version') {
  process.stdout.write('2.1.284 (Claude Code)\n')
} else {
  process.stderr.write('The conformance Claude executable supports metadata only; select sdkEntrypoint for turns.\n')
  process.exitCode = 2
}
