package api

import (
	"errors"
	"net/http"

	"cowatch/internal/store"
)

type resolveJoinResponse struct {
	RoomID   string `json:"roomId"`
	VideoURL string `json:"videoUrl"`
}

type errorResponse struct {
	Error string `json:"error"`
}

func handleResolveJoin(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("token")

		roomID, err := deps.Tokens.Resolve(token)
		if err != nil {
			switch {
			case errors.Is(err, store.ErrTokenExpired):
				writeJSON(w, http.StatusGone, errorResponse{Error: "link expired"})
			case errors.Is(err, store.ErrTokenNotFound):
				writeJSON(w, http.StatusNotFound, errorResponse{Error: "link not found"})
			default:
				writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "internal error"})
			}
			return
		}

		room, ok := deps.Rooms.Get(roomID)
		if !ok {
			writeJSON(w, http.StatusGone, errorResponse{Error: "link expired"})
			return
		}

		writeJSON(w, http.StatusOK, resolveJoinResponse{
			RoomID:   room.ID,
			VideoURL: room.VideoURL,
		})
	}
}
