import { HarnessExecutionError } from './errors.js'

interface CommandIdentity {
  threadId: string
  turnId: string
  itemId: string
}

/** One qualified transport's command stdout, separated by native thread, turn and item. */
export class CodexCommandOutput {
  private readonly commands = new Map<string, string>()

  append(input: CommandIdentity & { delta: string }): void {
    const key = JSON.stringify([input.threadId, input.turnId, input.itemId])
    const previous = this.commands.get(key) ?? ''
    const output = previous + input.delta
    if (Buffer.byteLength(output) > 64 * 1024 || !this.commands.has(key) && this.commands.size >= 16) {
      throw new HarnessExecutionError('CODEX_COMMAND_OUTPUT_LIMIT', 'Native diagnostic command output exceeds its bound.')
    }
    this.commands.set(key, output)
  }

  read(input: CommandIdentity, aggregate: unknown): string | undefined {
    if (typeof aggregate === 'string') return aggregate
    return this.commands.get(JSON.stringify([input.threadId, input.turnId, input.itemId]))
  }
}
