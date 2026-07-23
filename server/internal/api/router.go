package api

import (
	"io/fs"
	"log"
	"net/http"
	"time"

	"cowatch/internal/store"
	"cowatch/static"
)

// Deps contains the stores and public URL required by HTTP handlers.
type Deps struct {
	Rooms   *store.RoomStore
	Tokens  *store.TokenStore
	BaseURL string
}

// Register installs all HTTP and static routes on mux.
func Register(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc("GET /healthz", handleHealth)
	createLimiter := newRateLimiter(5, time.Minute) // 5 rooms/IP/minute
	mux.HandleFunc("POST /rooms", rateLimitMiddleware(createLimiter, handleCreateRoom(deps)))
	mux.HandleFunc("GET /join/{token}", handleResolveJoin(deps))
	mux.HandleFunc("POST /rooms/{roomId}/tokens", handleMintToken(deps))

	joinFS, err := fs.Sub(static.FS, "join")
	if err != nil {
		log.Fatalf("failed to load embedded landing page: %v", err)
	}
	mux.Handle("GET /join-page/", http.StripPrefix("/join-page/", http.FileServerFS(joinFS)))
}
