package ws

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

type client struct {
	id     string
	conn   *websocket.Conn
	roomID string
	isHost bool
	send   chan Message
}

func (c *client) readLoop(hub *Hub) {
	defer func() {
		hub.leave(c)
		close(c.send)
		c.conn.Close()
	}()

	for {
		var msg Message
		if err := c.conn.ReadJSON(&msg); err != nil {
			// Covers both a clean close and a dead connection — either
			// way, this connection is done and cleanup runs via defer.
			return
		}

		switch msg.Type {
		case MsgStateRequest:
			// US-1.8 not built yet — there's no lastKnownState to answer
			// with, so this is intentionally a no-op for now rather than
			// fabricating a response.
			continue

		case MsgPlay, MsgPause, MsgSeeked, MsgTimeSync:
			// This relay is what US-1.7 actually asks for. It falls out
			// naturally from having a working read loop at all, so it's
			// built here rather than artificially held back — but worth
			// being explicit that US-1.7 is what this satisfies, not 1.6.
			relay := Message{
				Type:      msg.Type,
				Payload:   msg.Payload,
				Timestamp: time.Now().UnixMilli(), // server-stamped, not client-supplied
			}
			hub.broadcast(c.roomID, relay, c)

		default:
			log.Printf("ws: unknown message type %q from %s", msg.Type, c.id)
		}
	}
}

func (c *client) writeLoop() {
	for msg := range c.send {
		if err := c.conn.WriteJSON(msg); err != nil {
			return
		}
	}
	// c.send closing (from readLoop's cleanup) is what ends this loop.
}

var _ = json.RawMessage{} // payload type used via Message, keeping import honest
