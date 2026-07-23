package api

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// validHostToken checks the Authorization: Bearer <token> header against
// the room's stored hostToken using a constant-time comparison — this is
// a bearer credential, so a timing-based comparison would leak information
// about how much of the token an attacker has guessed correctly.
func validHostToken(r *http.Request, expected string) bool {
	auth := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		return false
	}
	provided := strings.TrimPrefix(auth, prefix)
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

// ValidHostTokenQuery verifies the WebSocket hostToken query credential.
func ValidHostTokenQuery(r *http.Request, expected string) bool {
	provided := r.URL.Query().Get("hostToken")
	if provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}
