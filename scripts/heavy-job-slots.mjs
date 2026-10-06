/** Unresolved acquired tickets still own capacity when their slot record is missing. */
export function retainedHeavyJobTokens(tickets, slots, held) {
  const registered = new Set(slots.flatMap(slot => slot?.token ? [slot.token] : []))
  if (held?.token) registered.add(held.token)
  return new Set(tickets.flatMap(ticket => {
    if (!ticket?.token || registered.has(ticket.token)) return []
    const acquired = ticket.phase === 'running' || ticket.phase === 'acquiring'
      || ticket.phase === undefined && Number.isSafeInteger(ticket.pgid) && ticket.pgid > 0
    return acquired ? [ticket.token] : []
  }))
}
