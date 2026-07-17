package api

import (
	"io/fs"
	"log"
	"net/http"

	"cowatch/internal/store"
	"cowatch/static"
)

type Deps struct {
	Rooms   *store.RoomStore
	Tokens  *store.TokenStore
	BaseURL string
}

func Register(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("POST /rooms", handleCreateRoom(deps))
	mux.HandleFunc("GET /join/{token}", handleResolveJoin(deps))
	mux.HandleFunc("POST /rooms/{roomId}/tokens", handleMintToken(deps))

	joinFS, err := fs.Sub(static.FS, "join")
	if err != nil {
		log.Fatalf("failed to load embedded landing page: %v", err)
	}
	mux.Handle("GET /join-page/", http.StripPrefix("/join-page/", http.FileServerFS(joinFS)))
}
