// Package handoffs provides pure ID decisions and process-local activation
// dispatch for the durable work engine.
//
// It does not parse domain payloads, authorize callers, accept results, reserve
// work, persist receipts, or publish graph state. Generated-contract adapters
// must supply validated IDs and scoped source reads before using these helpers.
// Activation callbacks retain their existing admission, dispatch claims, Run
// serialization and ownership boundaries; a local task is never their proof.
package handoffs
