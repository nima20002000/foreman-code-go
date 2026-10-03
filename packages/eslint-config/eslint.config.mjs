import js from '@eslint/js'
import globals from 'globals'
import maintainability from './index.mjs'

export default [
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  ...maintainability,
]
