import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { foremanLint } from '../../scripts/eslint-plugin-foreman/index.mjs'

export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...foremanLint(import.meta.dirname),
)
