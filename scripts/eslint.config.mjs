import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { foremanLint } from './eslint-plugin-foreman/index.mjs'

const require = createRequire(new URL('../packages/contracts/package.json', import.meta.url))
const js = require('@eslint/js')
const globals = require('globals')
const tseslint = require('typescript-eslint')

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.logs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['scripts/**/*.ts', 'scripts/**/*.mts'] })),
  { files: ['scripts/**/*.mjs', 'scripts/**/*.cjs'], languageOptions: { globals: globals.node } },
  { files: ['scripts/**/*.ts', 'scripts/**/*.mts'], languageOptions: { globals: globals.node } },
  ...foremanLint(fileURLToPath(new URL('..', import.meta.url))),
]
