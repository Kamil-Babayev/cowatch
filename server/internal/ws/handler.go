package ws

import (
	"net/http"

	"github.com/gorilla/websocket"

	"cowatch/internal/api"
	"cowatch/internal/idgen"
	"cowatch/internal/store"
)

func HandleConnect(hub *Hub, rooms *store.RoomStore, checkOrigin func(*http.Request) bool) http.HandlerFunc {
	upgrader := websocket.Upgrader{CheckOrigin: checkOrigin}
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
			rooms:  rooms,
		}

		hub.join(c)
		go c.writeLoop()
		c.readLoop(hub)
	}
}
