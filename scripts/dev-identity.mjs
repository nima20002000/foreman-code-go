export function apiIdentityMatches(expected) {
  return (response, body) => {
    try {
      const actual = JSON.parse(body)
      return response.ok && ['installationId', 'checkoutId', 'databaseId'].every((key) => actual[key] === expected[key])
    } catch { return false }
  }
}
export function webIdentityMatches(checkoutId, apiUrl) {
  return (response, body) => {
    try {
      const actual = JSON.parse(body)
      return response.ok && actual.checkoutId === checkoutId && actual.apiUrl === apiUrl
    } catch { return false }
  }
}
