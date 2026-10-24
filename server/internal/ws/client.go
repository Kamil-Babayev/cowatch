package ws

import (
	"cowatch/internal/store"
	"encoding/json"
	"log"
	"math"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type client struct {
	id          string
	conn        *websocket.Conn
	roomID      string
	isHost      bool
	controlMode string
	send        chan Message
	done        chan struct{}
	doneOnce    sync.Once
	rooms       *store.RoomStore
}

func (c *client) readLoop(hub *Hub) {
	explicitLeave := false
	defer func() {
		hub.leave(c, explicitLeave)
		c.finish()
	}()

	c.conn.SetReadLimit(64 * 1024)
	_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	})

	for {
		var msg Message
		if err := c.conn.ReadJSON(&msg); err != nil {
			// Covers both a clean close and a dead connection — either
			// way, this connection is done and cleanup runs via defer.
			return
		}

		switch msg.Type {
		case MsgLeaveRoom:
			explicitLeave = true
			return

		case MsgStateRequest:
			c.sendCurrentPlayerState(hub)

		case MsgClockPing:
			var ping ClockPingPayload
			if err := json.Unmarshal(msg.Payload, &ping); err != nil || math.IsNaN(ping.T0) || math.IsInf(ping.T0, 0) {
				continue
			}
			now := time.Now().UnixMilli()
			payload, _ := json.Marshal(ClockPongPayload{T0: ping.T0, ServerTime: now})
			hub.sendTo(c, Message{Type: MsgClockPong, Payload: payload, Timestamp: now})

		case MsgPlayerCommand:
			c.handlePlayerCommand(hub, msg)

		case MsgPlayerHeartbeat:
			c.handlePlayerHeartbeat(hub, msg)

		default:
			log.Printf("ws: unknown message type %q from %s", msg.Type, c.id)
		}
	}
}

func validPlayerStatus(status string) bool {
	switch status {
	case "playing", "paused", "buffering", "ended":
		return true
	default:
		return false
	}
}

// maxMediaKeyLength bounds the opaque identifier a native player reports.
const maxMediaKeyLength = 2048

func validMediaSource(source MediaSourcePayload) bool {
	pageURL, err := url.Parse(source.PageURL)
	if err != nil || (pageURL.Scheme != "http" && pageURL.Scheme != "https") || pageURL.Host == "" {
		return false
	}
	if source.MediaKey == "" || len(source.MediaKey) > maxMediaKeyLength {
		return false
	}
	switch source.Provider {
	case "native":
		// Native players are identified by an opaque key the extension
		// derives from the page (streaming players expose only blob: URLs,
		// which are meaningless across browsers), so it is never parsed.
		return true
	case "obrut":
		mediaURL, err := url.Parse(source.MediaKey)
		if err != nil || (mediaURL.Scheme != "http" && mediaURL.Scheme != "https") {
			return false
		}
		host := strings.ToLower(mediaURL.Hostname())
		return host == "obrut.show" || strings.HasSuffix(host, ".obrut.show")
	default:
		return false
	}
}

func validPosition(position float64) bool {
	return !math.IsNaN(position) && !math.IsInf(position, 0) && position >= 0
}

func toStoreSource(source MediaSourcePayload) store.MediaSource {
	return store.MediaSource{PageURL: source.PageURL, Provider: source.Provider, MediaKey: source.MediaKey}
}

func fromStoreSource(source store.MediaSource) MediaSourcePayload {
	return MediaSourcePayload{PageURL: source.PageURL, Provider: source.Provider, MediaKey: source.MediaKey}
}

func (c *client) sendCurrentPlayerState(hub *Hub) {
	state, ok := c.rooms.CurrentPlayerState(c.roomID)
	if !ok {
		// Nothing cached yet — the client just starts from wherever the
		// page naturally is.
		return
	}
	payload, _ := json.Marshal(StateResponsePayload{
		Revision: state.Revision,
		Source:   fromStoreSource(state.Source),
		Position: state.Position,
		Status:   state.Status,
	})
	hub.sendTo(c, Message{Type: MsgStateResponse, Payload: payload, Timestamp: state.UpdatedAt})
}

func (c *client) broadcastPlayerState(hub *Hub, state store.PlayerState, commandID string, exclude *client) {
	payload, _ := json.Marshal(PlayerStatePayload{
		Revision:           state.Revision,
		Source:             fromStoreSource(state.Source),
		Position:           state.Position,
		Status:             state.Status,
		CommandID:          commandID,
		OriginConnectionID: c.id,
	})
	hub.broadcast(c.roomID, Message{Type: MsgPlayerState, Payload: payload, Timestamp: state.UpdatedAt}, exclude)
}

func (c *client) handlePlayerCommand(hub *Hub, msg Message) {
	room, ok := c.rooms.Get(c.roomID)
	if !ok {
		return
	}
	var command PlayerCommandPayload
	if err := json.Unmarshal(msg.Payload, &command); err != nil || command.CommandID == "" ||
		!validPosition(command.Position) || !validMediaSource(command.Source) {
		log.Printf("ws: invalid playerCommand from %s", c.id)
		return
	}
	if command.Action != "play" && command.Action != "pause" && command.Action != "seek" && command.Action != "replace" {
		return
	}
	if (command.Action == "replace" && !c.isHost) ||
		(room.ControlMode == store.ControlModeHostOnly && !c.isHost) {
		payload, _ := json.Marshal(ControlDeniedPayload{Reason: "host controls this action"})
		hub.sendTo(c, Message{Type: MsgControlDenied, Payload: payload, Timestamp: time.Now().UnixMilli()})
		return
	}
	status := "paused"
	if current, exists := c.rooms.CurrentPlayerState(c.roomID); exists {
		status = current.Status
	}
	switch command.Action {
	case "play":
		status = "playing"
	case "pause", "replace":
		status = "paused"
	}
	state, ok := c.rooms.CommitPlayerCommand(c.roomID, store.PlayerState{
		Source:    toStoreSource(command.Source),
		Position:  command.Position,
		Status:    status,
		UpdatedAt: time.Now().UnixMilli(),
	})
	if !ok {
		return
	}
	// Sent to the originator too: it carries the new revision, and the
	// originator recognises its own connection id and skips applying it.
	c.broadcastPlayerState(hub, state, command.CommandID, nil)
}

func (c *client) handlePlayerHeartbeat(hub *Hub, msg Message) {
	if !c.isHost {
		return
	}
	var heartbeat PlayerHeartbeatPayload
	if err := json.Unmarshal(msg.Payload, &heartbeat); err != nil ||
		!validPosition(heartbeat.Position) || !validMediaSource(heartbeat.Source) ||
		!validPlayerStatus(heartbeat.Status) {
		return
	}
	state, ok := c.rooms.ApplyHeartbeat(c.roomID, heartbeat.BaseRevision, store.PlayerState{
		Source:    toStoreSource(heartbeat.Source),
		Position:  heartbeat.Position,
		Status:    heartbeat.Status,
		UpdatedAt: time.Now().UnixMilli(),
	})
	if !ok {
		// Stale: a newer command already reached the room, and the host
		// will receive it as a playerState. Dropping silently avoids
		// fighting that command.
		return
	}
	c.broadcastPlayerState(hub, state, "", c)
}

func (c *client) writeLoop() {
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
				c.finish()
				return
			}
		case msg := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteJSON(msg); err != nil {
				c.finish()
				return
			}
			if msg.Type == MsgRoomClosed {
				_ = c.conn.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(4001, "room closed"),
					time.Now().Add(5*time.Second),
				)
				c.finish()
				return
			}
		}
	}
}

func (c *client) finish() {
	c.doneOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}
