package httpserver

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
)

type requestIDKey struct{}

// RequestID returns the server-created identifier used in public error replies.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// WithRequestID assigns a fresh UUID to every request, as the TypeScript API does.
func WithRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var bytes [16]byte
		if _, err := rand.Read(bytes[:]); err != nil {
			http.Error(w, "The API could not create a request identifier.", http.StatusInternalServerError)
			return
		}
		bytes[6] = (bytes[6] & 0x0f) | 0x40
		bytes[8] = (bytes[8] & 0x3f) | 0x80
		id := fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
		ctx := context.WithValue(r.Context(), requestIDKey{}, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
