import { basename } from 'node:path'

// Tracker issue keys, delivery-wave numbers and pull-request numbers.
const TICKET_REFERENCE = /(?:^|[^a-z])(?:wave ?\d+|nim-?\d{3,}|eng-?\d{2}|fil-?\d{2}|sch-?\d{2}|feat-?\d{2}|pr\d{2})(?![a-z])/i
const TEST_FUNCTIONS = new Set(['describe', 'it', 'test'])

function testTitle(node) {
  const callee = node.callee.type === 'MemberExpression' ? node.callee.object : node.callee
  if (callee.type !== 'Identifier' || !TEST_FUNCTIONS.has(callee.name)) return undefined
  const [title] = node.arguments
  if (title?.type === 'Literal' && typeof title.value === 'string') return title.value
  if (title?.type === 'TemplateLiteral') return title.quasis.map((quasi) => quasi.value.cooked).join('')
  return undefined
}

const noTicketReferences = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow ticket, wave and pull-request codes in names, comments and test titles.' },
    schema: [],
    messages: {
      file: 'File name "{{name}}" contains a ticket code. Name the file after what it does.',
      identifier: 'Name "{{name}}" contains a ticket code. Name it after the domain concept.',
      comment: 'Comment contains a ticket code. Keep history in git and the pull request description.',
      testTitle: 'Test title contains a ticket code. Describe the behavior under test.',
    },
  },
  create(context) {
    return {
      Program(node) {
        const name = basename(context.filename)
        if (TICKET_REFERENCE.test(name)) context.report({ node, messageId: 'file', data: { name } })
        for (const comment of context.sourceCode.getAllComments()) {
          if (TICKET_REFERENCE.test(comment.value)) context.report({ loc: comment.loc, messageId: 'comment' })
        }
      },
      Identifier(node) {
        if (TICKET_REFERENCE.test(node.name)) {
          context.report({ node, messageId: 'identifier', data: { name: node.name } })
        }
      },
      CallExpression(node) {
        const title = testTitle(node)
        if (title !== undefined && TICKET_REFERENCE.test(title)) {
          context.report({ node: node.arguments[0], messageId: 'testTitle' })
        }
      },
    }
  },
}

export default {
  meta: { name: 'maintainability' },
  rules: { 'no-ticket-references': noTicketReferences },
}
