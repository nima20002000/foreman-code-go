import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // These validators reject control characters in file names on purpose.
    files: [
      'src/modules/harnesses/codexFiles/bytes.ts',
      'src/modules/harnesses/opencodeFiles/attachments.ts',
      'src/modules/harnesses/opencodeFiles/host.ts',
    ],
    rules: { 'no-control-regex': 'off' },
  },
)
