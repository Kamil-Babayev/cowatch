package api

import (
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
		if err := decodeJSON(w, r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid JSON body"})
			return
		}
		if !isValidVideoURL(req.VideoURL) {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "videoUrl must be a valid http(s) URL"})
			return
		}
		if req.ControlMode != store.ControlModeOpen && req.ControlMode != store.ControlModeHostOnly {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "controlMode must be 'open' or 'host-only'"})
			return
		}

		room, err := deps.Rooms.Create(req.VideoURL, req.ControlMode)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "failed to create room"})
			return
		}

		token, err := deps.Tokens.Create(room.ID, joinTokenTTL)
		if err != nil {
			deps.Rooms.Delete(room.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "failed to create join token"})
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
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "failed to create join token"})
			return
		}

		writeJSON(w, http.StatusCreated, mintTokenResponse{
			JoinToken: token,
			JoinURL:   deps.BaseURL + "/join-page/?token=" + token,
		})
	}
}
