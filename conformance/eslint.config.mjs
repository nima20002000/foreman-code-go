import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { foremanLint } from '../scripts/eslint-plugin-foreman/index.mjs'

export default tseslint.config(
  { ignores: ['results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { '@typescript-eslint/no-floating-promises': 'error' },
  },
  { files: ['**/*.mjs', '**/*.cjs'], languageOptions: { globals: globals.node } },
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  ...foremanLint(import.meta.dirname),
)
