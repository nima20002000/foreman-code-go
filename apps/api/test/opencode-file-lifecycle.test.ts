import { it } from 'vitest'
import { registerOpenCodeChatFileCases } from './support/opencodeChatFileCases.js'

registerOpenCodeChatFileCases((name, body) => it(`FIL-09a file lifecycle: ${name}`, body))
