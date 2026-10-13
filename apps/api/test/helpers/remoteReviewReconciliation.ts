export function remoteReviewReconciliation(reconcile: () => Promise<void>): () => Promise<void> {
  return reconcile
}
