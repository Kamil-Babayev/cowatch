package ws

import (
	"cowatch/internal/store"
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
	rooms  *store.RoomStore
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
			state, ok := c.rooms.PlaybackState(c.roomID)
			if !ok {
				// First person in the room — nothing cached yet. Their
				// client just starts from wherever the page naturally is.
				continue
			}
			payload, _ := json.Marshal(StateResponsePayload{
				CurrentTime: state.CurrentTime,
				IsPlaying:   state.IsPlaying,
			})
			hub.sendTo(c, Message{
				Type:    MsgStateResponse,
				Payload: payload,
				// The moment this state was true, not "now" — US-2.8
				// computes elapsed time since this timestamp.
				Timestamp: state.UpdatedAt,
			})

		case MsgPlay, MsgPause, MsgSeeked, MsgTimeSync:
			room, ok := c.rooms.Get(c.roomID)
			if !ok {
				continue
			}
			if room.ControlMode == store.ControlModeHostOnly && !c.isHost {
				payload, _ := json.Marshal(ControlDeniedPayload{Reason: "host-only room"})
				hub.sendTo(c, Message{
					Type:      MsgControlDenied,
					Payload:   payload,
					Timestamp: time.Now().UnixMilli(),
				})
				continue // still no cache update, still not relayed
			}

			var payload PlaybackPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				log.Printf("ws: bad payload for %q from %s: %v", msg.Type, c.id, err)
				continue
			}

			now := time.Now().UnixMilli()
			c.rooms.UpdatePlaybackState(c.roomID, store.PlaybackState{
				CurrentTime: payload.CurrentTime,
				IsPlaying:   payload.IsPlaying,
				UpdatedAt:   now,
			})

			hub.broadcast(c.roomID, Message{
				Type:      msg.Type,
				Payload:   msg.Payload,
				Timestamp: now,
			}, c)

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
