package api

import (
	"cowatch/internal/config"
	"net/http"
	"net/url"
)

func MakeCheckOrigin(cfg config.Config) func(*http.Request) bool {
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			// No Origin header — non-browser client (curl, a WS test
			// tool). Browsers always send one, so this only affects
			// tooling, not real extension traffic.
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		if u.Scheme == "moz-extension" {
			return true
		}
		return origin == cfg.JoinBaseURL
	}
}
