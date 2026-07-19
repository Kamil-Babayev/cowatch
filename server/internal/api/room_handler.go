package api

import (
	"encoding/json"
	"net/http"
	"time"

	"cowatch/internal/store"
)

const joinTokenTTL = 10 * time.Minute

type createRoomRequest struct {
	VideoURL    string `json:"videoUrl"`
	ControlMode string `json:"controlMode"`
}

type createRoomResponse struct {
	RoomID    string `json:"roomId"`
	JoinToken string `json:"joinToken"`
	JoinURL   string `json:"joinUrl"`
	HostToken string `json:"hostToken"`
}

func handleCreateRoom(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createRoomRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if !isValidVideoURL(req.VideoURL) {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "videoUrl must be a valid http(s) URL"})
			return
		}
		if req.VideoURL == "" {
			http.Error(w, "videoUrl is required", http.StatusBadRequest)
			return
		}
		if req.ControlMode != store.ControlModeOpen && req.ControlMode != store.ControlModeHostOnly {
			http.Error(w, "controlMode must be 'open' or 'host-only'", http.StatusBadRequest)
			return
		}

		room, err := deps.Rooms.Create(req.VideoURL, req.ControlMode)
		if err != nil {
			http.Error(w, "failed to create room", http.StatusInternalServerError)
			return
		}

		token, err := deps.Tokens.Create(room.ID, joinTokenTTL)
		if err != nil {
			http.Error(w, "failed to create join token", http.StatusInternalServerError)
			return
		}

		resp := createRoomResponse{
			RoomID:    room.ID,
			JoinToken: token,
			JoinURL:   deps.BaseURL + "/join-page/?token=" + token, // was "/join/" + token — pointed at the JSON API, not the page
			HostToken: room.HostToken,
		}
		writeJSON(w, http.StatusCreated, resp)
	}
}

type mintTokenResponse struct {
	JoinToken string `json:"joinToken"`
	JoinURL   string `json:"joinUrl"`
}

func handleMintToken(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomId")

		room, ok := deps.Rooms.Get(roomID)
		if !ok {
			writeJSON(w, http.StatusNotFound, errorResponse{Error: "room not found"})
			return
		}

		if !validHostToken(r, room.HostToken) {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "invalid host token"})
			return
		}

		token, err := deps.Tokens.Create(room.ID, joinTokenTTL)
		if err != nil {
			http.Error(w, "failed to create join token", http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusCreated, mintTokenResponse{
			JoinToken: token,
			JoinURL:   deps.BaseURL + "/join-page/?token=" + token,
		})
	}
}
