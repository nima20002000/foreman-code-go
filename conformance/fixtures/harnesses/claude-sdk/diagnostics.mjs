const markerPattern = /^Remember this exact diagnostic marker: (CLAUDE_PROFILE_[a-f0-9-]{36})\. Reply with only the marker\. Do not use tools\.$/

function rememberedMarker(session) {
  for (const frame of session.messages) {
    if (frame.type !== 'user' || typeof frame.message?.content !== 'string') continue
    const marker = markerPattern.exec(frame.message.content)?.[1]
    if (marker) return marker
  }
  throw new Error('Fake Claude has no remembered diagnostic marker in this native session.')
}

/** Scripted provider behavior only. The application still performs every native
 * scenario and produces its own qualification from the actual frames and files. */
export function nativeDiagnosticScript(text, session) {
  const marker = markerPattern.exec(text)?.[1]
  if (marker) return { answer: marker }
  if (['Reply with only the diagnostic marker from my previous message. Do not use tools.',
    'Reply with only the diagnostic marker from our first message. Do not use tools.'].includes(text)) {
    return { answer: rememberedMarker(session) }
  }
  const reply = /^Reply exactly ([A-Z_]{1,100})\. Do not use tools\.$/.exec(text)
  if (reply) return { answer: reply[1] }
  const write = /^Use Write to put exactly (OWNED_WRITE_[a-f0-9-]{36}) in (\/[^\r\n]+)\. This is an owned disposable diagnostic file\. Then reply DONE\.$/.exec(text)
  if (write) return { answer: 'DONE', tools: [{ name: 'Write', input: { file_path: write[2], content: write[1] } }] }
  const denied = /^Use Write to put exactly BLOCKED in (\/[^\r\n]+)\. If the diagnostic policy denies it, do not retry or use another tool\. Reply DONE\.$/.exec(text)
  if (denied) return { answer: 'DONE', tools: [{ name: 'Write', input: { file_path: denied[1], content: 'BLOCKED' },
    continueAfterDenial: true }] }
  return undefined
}
