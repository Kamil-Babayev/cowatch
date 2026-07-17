package ws

import (
	"net/http"

	"github.com/gorilla/websocket"

	"cowatch/internal/api"
	"cowatch/internal/idgen"
	"cowatch/internal/store"
)

var upgrader = websocket.Upgrader{
	// TODO(US-1.10): restrict this once real origins are known — wide
	// open is fine for local dev, not for anything past that.
	CheckOrigin: func(r *http.Request) bool { return true },
}

func HandleConnect(hub *Hub, rooms *store.RoomStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomId")

		room, ok := rooms.Get(roomID)
		if !ok {
			http.Error(w, "room not found", http.StatusNotFound)
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
			id:     id,
			conn:   conn,
			roomID: roomID,
			isHost: isHost,
			send:   make(chan Message, 16),
		}

		hub.join(c)
		go c.writeLoop()
		c.readLoop(hub)
	}
}
