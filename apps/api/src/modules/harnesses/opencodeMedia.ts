import { createHash, type Hash } from 'node:crypto'

interface JsonFrame {
  kind: 'object' | 'array'
  context: 'messages' | 'message' | 'parts' | 'part' | 'toolState' | 'attachments' | 'attachment' | 'other'
  key: string | undefined
  expectsKey: boolean
}

function frameContext(kind: JsonFrame['kind'], parent: JsonFrame | undefined): JsonFrame['context'] {
  if (!parent) return kind === 'object' ? 'message' : 'messages'
  if (kind === 'object') {
    if (parent.context === 'messages') return 'message'
    if (parent.context === 'parts') return 'part'
    if (parent.context === 'attachments') return 'attachment'
    if (parent.context === 'part' && parent.key === 'state') return 'toolState'
  } else {
    if (parent.context === 'message' && parent.key === 'parts') return 'parts'
    if (parent.context === 'toolState' && parent.key === 'attachments') return 'attachments'
  }
  return 'other'
}

interface JsonString {
  key: boolean
  mediaCandidate: boolean
  raw: string
  prefix: string
  escape: string
  hash: Hash | undefined
}

/** History keeps media identity without copying native inline bytes into recovery or activity state.
 * The URN hashes the decoded data URL; native storage and model input retain the original URL. */
export function openCodeMediaStream(): TransformStream<Uint8Array, Uint8Array> {
  const projection = new MediaProjection()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  return new TransformStream({
    transform(chunk, controller) {
      const text = projection.push(decoder.decode(chunk, { stream: true }))
      if (text) controller.enqueue(encoder.encode(text))
    },
    flush(controller) {
      const text = projection.push(decoder.decode())
      projection.finish()
      if (text) controller.enqueue(encoder.encode(text))
    },
  })
}

class MediaProjection {
  private readonly frames: JsonFrame[] = []
  private string: JsonString | undefined
  private output = ''

  push(input: string): string {
    this.output = ''
    let index = 0
    while (index < input.length) {
      if (this.string) {
        index = this.readString(input, index)
        continue
      }
      const char = input[index++]!
      if (char === '"') this.startString()
      else {
        this.output += char
        this.punctuation(char)
      }
    }
    return this.output
  }

  finish(): void {
    if (this.string || this.frames.length) throw new SyntaxError('Incomplete OpenCode history JSON.')
  }

  private punctuation(char: string): void {
    const parent = this.frames.at(-1)
    if (char === '{' || char === '[') {
      const kind = char === '{' ? 'object' : 'array'
      this.frames.push({ kind, context: frameContext(kind, parent),
        key: undefined, expectsKey: char === '{' })
    } else if (char === '}' || char === ']') {
      const frame = this.frames.pop()
      if (!frame || (char === '}') !== (frame.kind === 'object')) {
        throw new SyntaxError('Invalid OpenCode history JSON container.')
      }
    } else if (parent?.kind === 'object') {
      if (char === ':') parent.expectsKey = false
      if (char === ',') {
        parent.expectsKey = true
        parent.key = undefined
      }
    }
  }

  private startString(): void {
    const frame = this.frames.at(-1)
    const key = frame?.kind === 'object' && frame.expectsKey
    const part = frame?.context === 'part' || frame?.context === 'attachment'
    const mediaCandidate = !key && frame?.key === 'url' && part
    this.string = { key, mediaCandidate, raw: '', prefix: '', escape: '', hash: undefined }
    if (!mediaCandidate) this.output += '"'
  }

  private readString(input: string, start: number): number {
    const token = this.string!
    let index = start
    if (token.escape) {
      while (index < input.length) {
        token.escape += input[index++]!
        const length = token.escape[1] === 'u' ? 6 : 2
        if (token.escape.length < length) continue
        const value = JSON.parse(`"${token.escape}"`) as string
        this.stringContent(token.escape, value)
        token.escape = ''
        break
      }
      return index
    }
    const special = /["\\]/g
    special.lastIndex = index
    const match = special.exec(input)
    const end = match?.index ?? input.length
    const plain = input.slice(index, end)
    if (plain) this.stringContent(plain, plain)
    if (!match) return end
    if (match[0] === '\\') token.escape = '\\'
    else this.endString()
    return end + 1
  }

  private stringContent(raw: string, decoded: string): void {
    const token = this.string!
    if (token.hash) {
      if (!/^[A-Za-z0-9+/=]*$/.test(decoded)) throw new SyntaxError('Invalid inline media encoding.')
      token.hash.update(decoded)
      return
    }
    if (!token.mediaCandidate) {
      if (token.key) token.raw += raw
      this.output += raw
      return
    }
    // Decide from a small prefix even when one network chunk contains an entire image.
    const probe = token.prefix + decoded.slice(0, 256 - token.prefix.length)
    const header = /^data:[A-Za-z0-9.+/-]+;base64,/.exec(probe)?.[0]
    if (header) {
      token.hash = createHash('sha256')
      token.hash.update(token.prefix)
      const tail = decoded.slice(header.length - token.prefix.length)
      if (!/^[A-Za-z0-9+/=]*$/.test(tail)) throw new SyntaxError('Invalid inline media encoding.')
      token.hash.update(decoded)
      token.raw = ''
      token.prefix = ''
      return
    }
    const dataPrefix = 'data:'.startsWith(probe) || probe.startsWith('data:')
    if (!dataPrefix || probe.length === 256) {
      this.output += '"' + token.raw + raw
      token.mediaCandidate = false
      token.raw = ''
      token.prefix = ''
      return
    }
    token.raw += raw
    token.prefix += decoded
  }

  private endString(): void {
    const token = this.string!
    if (token.hash) this.output += JSON.stringify(`urn:opencode:media:sha256:${token.hash.digest('hex')}`)
    else if (token.mediaCandidate) this.output += '"' + token.raw + '"'
    else this.output += '"'
    if (token.key) this.frames.at(-1)!.key = JSON.parse(`"${token.raw}"`) as string
    this.string = undefined
  }
}
