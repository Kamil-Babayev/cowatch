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
			if state, ok := c.rooms.CurrentPlayerState(c.roomID); ok {
				payload, _ := json.Marshal(stateResponseFromPlayerState(state))
				hub.sendTo(c, Message{Type: MsgStateResponse, Payload: payload, Timestamp: state.UpdatedAt})
				continue
			}
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

		case MsgPlayerCommand:
			c.handlePlayerCommand(hub, msg)

		case MsgPlayerHeartbeat:
			c.handlePlayerHeartbeat(hub, msg)

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
			if payload.CurrentTime < 0 || math.IsNaN(payload.CurrentTime) || math.IsInf(payload.CurrentTime, 0) {
				log.Printf("ws: invalid currentTime for %q from %s", msg.Type, c.id)
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

func validPlayerStatus(status string) bool {
	switch status {
	case "playing", "paused", "buffering", "ended":
		return true
	default:
		return false
	}
}

func validMediaSource(source MediaSourcePayload) bool {
	if source.Provider != "native" && source.Provider != "obrut" {
		return false
	}
	pageURL, err := url.Parse(source.PageURL)
	if err != nil || (pageURL.Scheme != "http" && pageURL.Scheme != "https") || pageURL.Host == "" || source.MediaKey == "" {
		return false
	}
	mediaURL, err := url.Parse(source.MediaKey)
	if err != nil || (mediaURL.Scheme != "http" && mediaURL.Scheme != "https") || mediaURL.Host == "" {
		return false
	}
	if source.Provider == "obrut" {
		host := strings.ToLower(mediaURL.Hostname())
		return host == "obrut.show" || strings.HasSuffix(host, ".obrut.show")
	}
	return true
}

func stateResponseFromPlayerState(state store.PlayerState) StateResponsePayload {
	source := MediaSourcePayload{
		PageURL: state.Source.PageURL, Provider: state.Source.Provider, MediaKey: state.Source.MediaKey,
	}
	return StateResponsePayload{
		CurrentTime: state.Position,
		IsPlaying:   state.Status == "playing",
		Revision:    state.Revision,
		Source:      &source,
		Position:    state.Position,
		Status:      state.Status,
	}
}

func playerStatePayload(state store.PlayerState, commandID string) PlayerStatePayload {
	return PlayerStatePayload{
		Revision: state.Revision,
		Source: MediaSourcePayload{
			PageURL: state.Source.PageURL, Provider: state.Source.Provider, MediaKey: state.Source.MediaKey,
		},
		Position:  state.Position,
		Status:    state.Status,
		CommandID: commandID,
	}
}

func (c *client) sendCurrentPlayerState(hub *Hub) {
	state, ok := c.rooms.CurrentPlayerState(c.roomID)
	if !ok {
		return
	}
	payload, _ := json.Marshal(stateResponseFromPlayerState(state))
	hub.sendTo(c, Message{Type: MsgStateResponse, Payload: payload, Timestamp: state.UpdatedAt})
}

func (c *client) handlePlayerCommand(hub *Hub, msg Message) {
	room, ok := c.rooms.Get(c.roomID)
	if !ok {
		return
	}
	var command PlayerCommandPayload
	if err := json.Unmarshal(msg.Payload, &command); err != nil || command.CommandID == "" ||
		math.IsNaN(command.Position) || math.IsInf(command.Position, 0) || command.Position < 0 ||
		!validMediaSource(command.Source) {
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
	now := time.Now().UnixMilli()
	state, _, applied := c.rooms.ApplyPlayerState(c.roomID, command.BaseRevision, store.PlayerState{
		Source:    store.MediaSource{PageURL: command.Source.PageURL, Provider: command.Source.Provider, MediaKey: command.Source.MediaKey},
		Position:  command.Position,
		Status:    status,
		UpdatedAt: now,
	})
	if !applied {
		c.sendCurrentPlayerState(hub)
		return
	}
	payload, _ := json.Marshal(playerStatePayload(state, command.CommandID))
	hub.broadcast(c.roomID, Message{Type: MsgPlayerState, Payload: payload, Timestamp: now}, nil)
}

func (c *client) handlePlayerHeartbeat(hub *Hub, msg Message) {
	if !c.isHost {
		return
	}
	var heartbeat PlayerHeartbeatPayload
	if err := json.Unmarshal(msg.Payload, &heartbeat); err != nil ||
		math.IsNaN(heartbeat.Position) || math.IsInf(heartbeat.Position, 0) || heartbeat.Position < 0 ||
		!validMediaSource(heartbeat.Source) || !validPlayerStatus(heartbeat.Status) {
		return
	}
	now := time.Now().UnixMilli()
	state, _, applied := c.rooms.ApplyPlayerState(c.roomID, heartbeat.BaseRevision, store.PlayerState{
		Source:    store.MediaSource{PageURL: heartbeat.Source.PageURL, Provider: heartbeat.Source.Provider, MediaKey: heartbeat.Source.MediaKey},
		Position:  heartbeat.Position,
		Status:    heartbeat.Status,
		UpdatedAt: now,
	})
	if !applied {
		c.sendCurrentPlayerState(hub)
		return
	}
	payload, _ := json.Marshal(playerStatePayload(state, ""))
	hub.broadcast(c.roomID, Message{Type: MsgPlayerState, Payload: payload, Timestamp: now}, nil)
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
