package ws

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"cowatch/internal/api"
	"cowatch/internal/idgen"
	"cowatch/internal/store"
)

// HandleConnect upgrades validated room requests and serves a client session.
func HandleConnect(hub *Hub, rooms *store.RoomStore, checkOrigin func(*http.Request) bool) http.HandlerFunc {
	upgrader := websocket.Upgrader{CheckOrigin: checkOrigin}
	return func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomId")

		room, ok := rooms.Get(roomID)
		if !ok {
			writeConnectError(w, http.StatusNotFound, "room not found")
			return
		}
		if !checkOrigin(r) {
			writeConnectError(w, http.StatusForbidden, "origin not allowed")
			return
		}

		isHost := api.ValidHostTokenQuery(r, room.HostToken)

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return // Upgrade already wrote the error response itself
		}

		id, err := idgen.New(8)
		if err != nil {
			conn.Close()
			return
		}

		c := &client{
			id:          id,
			conn:        conn,
			roomID:      roomID,
			isHost:      isHost,
			controlMode: room.ControlMode,
			send:        make(chan Message, 16),
			done:        make(chan struct{}),
			rooms:       rooms,
		}

		go c.writeLoop()
		sessionPayload, _ := json.Marshal(SessionPayload{
			ConnectionID: c.id,
			IsHost:       c.isHost,
			ControlMode:  c.controlMode,
		})
		hub.sendTo(c, Message{
			Type:      MsgSession,
			Payload:   sessionPayload,
			Timestamp: time.Now().UnixMilli(),
		})
		hub.join(c)
		c.readLoop(hub)
	}
}

func writeConnectError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
