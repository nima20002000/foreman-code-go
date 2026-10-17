// Package handoffs provides pure ID decisions for the durable work engine.
//
// It does not parse domain payloads, authorize callers, accept results, reserve
// work, persist receipts, or publish graph state. Generated-contract adapters
// must supply validated IDs and scoped source reads before using these helpers.
// The durable caller retains the existing transaction and ownership boundary.
package handoffs
