import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'
import vitest from '@vitest/eslint-plugin'
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

const TEST_FUNCTION = '/^(?:describe|suite|it|test)$/'
const SQL_TEXT = '/^[\\s^]*(?:select|insert|update|delete|with)\\b/i'
const SQL_COMPARISON = '/^(?:startsWith|endsWith|includes|indexOf|match|test|toBe|toEqual|toContain|toMatch)$/'

const testRestrictedSyntax = [
  {
    selector: 'ImportDeclaration[source.value=/[?]raw$/]',
    message: 'Tests must exercise behavior, not read source text.',
  },
  {
    // A repository path such as '../src/app.ts' or 'apps/web/src/Board.tsx' passed to readFile, new URL, etc.
    // Collection lookups such as map.get('apps/api/src/app.ts') handle paths as data and are allowed.
    selector: `:matches(CallExpression, NewExpression):not([callee.object.name='vi'], [callee.name=${TEST_FUNCTION}], `
      + '[callee.property.name=/^(?:get|has|set|add|delete|includes|indexOf|push|startsWith|endsWith)$/])'
      + ' > Literal[value=/^(?:[.]{1,2}[\\u002F]|(?:apps|packages)[\\u002F]).*[.](?:ts|tsx|mts|cts|css)$/]',
    message: 'Tests must exercise behavior, not read source files.',
  },
  {
    selector: 'ImportDeclaration[source.value=/^(?:node:)?vm$/], '
      + 'MemberExpression[property.name=/^(?:transpileModule|transpile|stripTypeScriptTypes)$/], '
      + 'ImportSpecifier[imported.name=/^(?:stripTypeScriptTypes|SourceTextModule|transpileModule)$/]',
    message: 'Tests must import production modules normally, not compile or evaluate source files.',
  },
  {
    selector: `CallExpression[callee.property.name=${SQL_COMPARISON}] > Literal[value=${SQL_TEXT}], `
      + `CallExpression[callee.property.name=${SQL_COMPARISON}] > Literal[regex.pattern=${SQL_TEXT}], `
      + `BinaryExpression[operator=/^[!=]==?$/] > Literal[value=${SQL_TEXT}], `
      + `SwitchCase > Literal.test[value=${SQL_TEXT}]`,
    message: 'Do not match SQL text in tests. Fake the repository interface, or use a real database.',
  },
  {
    selector: "MemberExpression > TSAsExpression.object:matches([typeAnnotation.type='TSAnyKeyword'], "
      + "[typeAnnotation.type='TSTypeLiteral'][expression.type='TSAsExpression'])",
    message: 'Tests must use the public interface, not cast to reach private members.',
  },
  {
    selector: `CallExpression[callee.object.name=${TEST_FUNCTION}][callee.property.name=/^(?:skip|todo|only)$/], `
      + `CallExpression[callee.name=${TEST_FUNCTION}] > ObjectExpression > Property[key.name=/^(?:todo|only)$/], `
      + `CallExpression[callee.name=${TEST_FUNCTION}] > ObjectExpression > Property[key.name='skip']`
      + '[value.type=/^(?:Literal|TemplateLiteral)$/]',
    message: 'Do not skip, defer or focus tests. Fix or delete the test.',
  },
  {
    selector: "CallExpression[callee.object.name='assert'][callee.property.name=/^(?:throws|rejects)$/]"
      + '[arguments.length=1]',
    message: 'Assert which error is thrown, not just that something throws.',
  },
  {
    selector: "CallExpression[callee.object.callee.name='expect'][arguments.0.type='Literal']"
      + "[callee.object.arguments.0.type='Literal']",
    message: 'Do not compare two constants. Assert on the result of the code under test.',
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
      'maintainability/test-file-names': 'error',
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
    files: testFiles,
    plugins: { vitest },
    rules: {
      // A describe() callback holds a whole suite, so function length is not a useful signal in tests.
      'max-lines-per-function': 'off',
      'no-restricted-syntax': ['error', ...restrictedSyntax, ...testRestrictedSyntax],
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/no-identical-title': 'error',
      'vitest/no-conditional-expect': 'error',
      'vitest/no-standalone-expect': 'error',
      // Vitest accepts a failure message as the second argument.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      'vitest/valid-expect-in-promise': 'error',
      'vitest/require-to-throw-message': 'error',
      'vitest/expect-expect': ['error', {
        // Testing Library queries fail the test when the element is missing.
        assertFunctionNames: ['expect', 'expect*', 'assert', 'assert*', '*.assert*', 'screen.findBy*', 'screen.getBy*'],
      }],
    },
  },
]
