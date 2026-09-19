/** No HTTP here. The API boundary emits only after checking its session generation. */
export const authenticationRequiredEvent = 'graphql:authentication-required'
export function notifyAuthenticationRequired(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(authenticationRequiredEvent))
}
