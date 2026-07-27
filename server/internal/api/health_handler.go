package api

import "net/http"

func handleHealth(joinBaseURL string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-CoWatch-Join-Base-URL", joinBaseURL)
		w.WriteHeader(http.StatusOK)
	}
}
