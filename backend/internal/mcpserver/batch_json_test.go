package mcpserver_test

import (
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/mcpserver"
)

// This is the explicit SDK fixture mode. Frozen SSE and JSON requests have
// identical Accept headers; a header-based mode switch would change the oracle.
func TestMCPFrozenBatchJSONOracle(t *testing.T) {
	for _, row := range batchOracleRows(t, "explicit-json-fixture") {
		t.Run(row.ID, func(t *testing.T) {
			runBatchOracleRow(t, row, mcpserver.Options{JSONResponse: true})
		})
	}
}

func TestMCPBatchJSONCompletionOrder(t *testing.T) {
	runBatchCompletionOrder(t, mcpserver.Options{JSONResponse: true}, true)
}

func TestMCPBatchJSONUnknownMethodKeepsOtherResponses(t *testing.T) {
	runBatchUnknownMethod(t, mcpserver.Options{JSONResponse: true})
}
