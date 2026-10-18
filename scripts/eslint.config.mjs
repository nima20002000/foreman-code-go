import { createRequire } from 'node:module'
import { foremanLint } from './eslint-plugin-foreman/index.mjs'

const require = createRequire(new URL('../packages/contracts/package.json', import.meta.url))
const js = require('@eslint/js')
const globals = require('globals')

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.logs/**'] },
  js.configs.recommended,
  { files: ['scripts/**/*.mjs', 'scripts/**/*.cjs'], languageOptions: { globals: globals.node } },
  ...foremanLint(new URL('..', import.meta.url).pathname),
]
