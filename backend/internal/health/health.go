// Package health exposes the existing operational health contract.
package health

import (
	"net/http"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
)

// Register adds the same liveness and readiness routes as apps/api's public server.
func Register(application *app.App) {
	database := newProbe(application.Readiness.Database, application.ReadinessTimeout)
	checkpoints := newProbe(application.Readiness.Checkpoints, application.ReadinessTimeout)
	application.Handle("GET /health/live", func(w http.ResponseWriter, _ *http.Request) error {
		return httpserver.WriteJSON(w, http.StatusOK, map[string]any{
			"status": "ok", "service": "graphql-api",
		})
	})
	application.Handle("GET /health/ready", func(w http.ResponseWriter, request *http.Request) error {
		// Both probes start before waiting, and concurrent requests share their pending work.
		databaseAttempt := database.start()
		checkpointsAttempt := checkpoints.start()
		databaseStatus := databaseAttempt.result(request.Context())
		checkpointsStatus := checkpointsAttempt.result(request.Context())
		status, statusCode := "ok", http.StatusOK
		if databaseStatus != "ok" || checkpointsStatus != "ok" {
			status, statusCode = "unavailable", http.StatusServiceUnavailable
		}
		return httpserver.WriteJSON(w, statusCode, map[string]any{
			"status": status, "service": "graphql-api",
			"checks": map[string]string{"database": databaseStatus, "checkpoints": checkpointsStatus},
		})
	})
}
