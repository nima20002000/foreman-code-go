import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'
import maintainability from './plugin.mjs'

export const testFiles = ['**/*.test.{ts,tsx,js,mjs,cjs}', '**/test/**', '**/tests/**', '**/__tests__/**']

// Module-level declarations only, so locals such as `nextIndex` and references to other code stay allowed.
const moduleLevelName = (pattern) => `:matches(${[
  ':matches(Program, ExportNamedDeclaration) > :matches(FunctionDeclaration, ClassDeclaration, '
    + 'TSTypeAliasDeclaration, TSInterfaceDeclaration, TSEnumDeclaration) > Identifier.id',
  ':matches(Program, ExportNamedDeclaration) > VariableDeclaration > VariableDeclarator > Identifier.id',
].join(', ')})[name=${pattern}]`

/** Entries for `no-restricted-syntax`. Configs that set that rule must include these. */
export const restrictedSyntax = [
  {
    selector: moduleLevelName('/^(?:current|Current)[A-Z0-9_]|^Next[A-Z]/'),
    message: 'Do not prefix names with Current/Next. Give the live concept its plain name.',
  },
  {
    selector: moduleLevelName('/[a-z]V[0-9]+(?:[A-Z][A-Za-z0-9]*)?$/'),
    message: 'Do not add version suffixes such as V3 to names. Give the live concept its plain name.',
  },
  {
    selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[params.length=0]"
      + ":matches([body.type='Identifier'][body.name='undefined'], [body.raw='null'], "
      + "[body.type='BlockStatement'][body.body.length=0])",
    message: 'Do not silently discard promise rejections. Handle the error or let it propagate.',
  },
  {
    selector: 'CatchClause > BlockStatement.body[body.length=0]',
    message: 'Do not leave a catch block empty. Handle, rethrow or report the error.',
  },
  {
    selector: ":function > AssignmentPattern[right.type='Literal'][right.raw=/^(?:true|false)$/]",
    message: 'Do not use boolean flag parameters. Use an options object or two named functions.',
  },
  {
    selector: "ExpressionStatement > UnaryExpression[operator='void'] > Identifier",
    message: 'Remove unused parameters instead of marking them used with `void`.',
  },
]

const testRestrictedSyntax = [
  {
    selector: 'ImportDeclaration[source.value=/[?]raw$/]',
    message: 'Tests must exercise behavior, not read source text.',
  },
  {
    selector: ':not(ImportDeclaration, ImportExpression, ExportAllDeclaration, ExportNamedDeclaration)'
      + ' > Literal[value=/^[.]{1,2}[\\u002F].*[.](?:ts|tsx|mts)$/]',
    message: 'Tests must exercise behavior, not read source files.',
  },
]

export default [
  // Inline comments cannot disable rules or declare globals; exceptions belong in a package's config.
  { linterOptions: { noInlineConfig: true } },
  { files: ['**/*.{js,mjs,cjs}'], languageOptions: { globals: globals.node } },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    plugins: { '@stylistic': stylistic, maintainability },
    rules: {
      'maintainability/no-ticket-references': 'error',
      '@stylistic/max-len': ['error', {
        code: 120,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true,
      }],
      '@stylistic/max-statements-per-line': ['error', { max: 1 }],
      'one-var': ['error', 'never'],
      'no-nested-ternary': 'error',
      'complexity': ['error', 15],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', ...restrictedSyntax],
    },
  },
  {
    // A describe() callback holds a whole suite, so function length is not a useful signal in tests.
    files: testFiles,
    rules: {
      'max-lines-per-function': 'off',
      'no-restricted-syntax': ['error', ...restrictedSyntax, ...testRestrictedSyntax],
    },
  },
]
