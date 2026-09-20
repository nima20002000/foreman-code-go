import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Message, OperatorActivity } from '@graphql/contracts'
import { Button, Icon } from '../../shared/ui/nocturne'
import { useInfiniteQuery } from '@tanstack/react-query'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { getOperatorActivity, mergeOperatorActivity } from '../../shared/api/operatorActivity'
import { OperatorMessages } from './OperatorMessages'
import { OperatorHistory } from './OperatorHistory'

/** Follow new output only while the reader is at the end of the transcript. */
export function OperatorTranscript({ messages, partialText, thinkingText = '', hasEarlierMessages = false, working = false,
  conversationId, activities = [], activityNextCursor, activeRequestId, parts, approval }: {
  messages: Message[]; partialText: string; thinkingText?: string; hasEarlierMessages?: boolean; working?: boolean;
  conversationId?: string; activities?: OperatorActivity[]; activityNextCursor?: string | null;
  activeRequestId?: string | null; parts?: Record<string, string>;
  approval?: ReactNode;
}) {
  const earlierActivity = useInfiniteQuery({
    queryKey: ['operator-chat', 'activity', conversationId ?? '', identityEpoch()],
    queryFn: ({ pageParam, signal }) => getOperatorActivity(conversationId ?? '', pageParam ? { before: pageParam } : {}, { signal }),
    initialPageParam: activityNextCursor ?? undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: false, retry: false,
  })
  const entries = mergeOperatorActivity(...(earlierActivity.data?.pages.map((page) => page.activities) ?? []), activities)
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
  }, [messages, partialText, thinkingText, approval])
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
        {(activityNextCursor && !earlierActivity.data) || earlierActivity.hasNextPage ? <Button size="sm" variant="ghost" disabled={earlierActivity.isFetching}
          onClick={() => { followLatest.current = false; void earlierActivity.fetchNextPage() }}>Load earlier activity</Button> : null}
        {earlierActivity.isError ? <p role="alert">Earlier activity could not be loaded. <Button size="sm" onClick={() => void earlierActivity.fetchNextPage()}>Retry activity</Button></p> : null}
        {hasEarlierMessages ? <OperatorHistory recentMessages={messages} onBrowse={() => { followLatest.current = false }}
          renderMessages={(older) => <OperatorMessages messages={older} activities={entries} onBrowse={() => { followLatest.current = false }} />} /> : null}
        <OperatorMessages messages={messages} activities={entries} activeRequestId={activeRequestId} parts={parts}
          working={working} partialText={partialText} thinkingText={thinkingText} onBrowse={() => { followLatest.current = false }} />
        {approval}
      </div>
    </div>
    {hasNewContent ? <Button size="sm" variant="secondary" className="operator-chat-jump" leading={<Icon name="down" size={14} />} onClick={jumpToLatest}>New output — Jump to latest</Button> : null}
  </div>
}
