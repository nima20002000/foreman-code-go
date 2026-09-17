import { useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '@graphql/contracts'
import { ConversationHistory } from '../conversations'

/** Follow new output only while the reader is at the end of the transcript. */
export function OperatorTranscript({ messages, partialText }: { messages: Message[]; partialText: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const [hasNewContent, setHasNewContent] = useState(false)
  const jumpToLatest = () => {
    const scroll = scrollRef.current
    if (scroll) scroll.scrollTop = scroll.scrollHeight
    followLatest.current = true
    setHasNewContent(false)
  }
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    if (followLatest.current) { scroll.scrollTop = scroll.scrollHeight; setHasNewContent(false) }
    else setHasNewContent(true)
  }, [messages, partialText])
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !contentRef.current) return
    const observer = new ResizeObserver(() => {
      const scroll = scrollRef.current
      if (scroll && followLatest.current) scroll.scrollTop = scroll.scrollHeight
    })
    observer.observe(contentRef.current)
    if (scrollRef.current) observer.observe(scrollRef.current)
    return () => observer.disconnect()
  }, [])
  return <div className="operator-chat-transcript">
    <div ref={scrollRef} className="operator-chat-transcript-scroll" role="region" aria-label="Operator transcript" tabIndex={0}
      onScroll={(event) => {
        const scroll = event.currentTarget
        followLatest.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48
        if (followLatest.current) setHasNewContent(false)
      }}>
      <div ref={contentRef}>
        <ConversationHistory messages={messages} />
        {partialText ? <div className="operator-chat-partial" role="status" aria-label="Assistant response in progress">{partialText}</div> : null}
      </div>
    </div>
    {hasNewContent ? <button type="button" className="operator-chat-jump" onClick={jumpToLatest}>New output — Jump to latest</button> : null}
  </div>
}
