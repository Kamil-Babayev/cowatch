package ws

import (
	"encoding/json"
	"sync"
)

type Hub struct {
	mu          sync.RWMutex
	rooms       map[string]map[*client]struct{}
	OnRoomEmpty func(roomID string) // called after the last connection in a room leaves
}

func (h *Hub) leave(c *client) {
	h.mu.Lock()
	delete(h.rooms[c.roomID], c)
	empty := len(h.rooms[c.roomID]) == 0
	if empty {
		delete(h.rooms, c.roomID)
	}
	h.mu.Unlock()

	if empty {
		if h.OnRoomEmpty != nil {
			h.OnRoomEmpty(c.roomID)
		}
		return
	}
	h.broadcastPresence(c.roomID)
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[string]map[*client]struct{})}
}

func (h *Hub) join(c *client) {
	h.mu.Lock()
	if h.rooms[c.roomID] == nil {
		h.rooms[c.roomID] = make(map[*client]struct{})
	}
	h.rooms[c.roomID][c] = struct{}{}
	h.mu.Unlock()

	h.broadcastPresence(c.roomID)
}

func (h *Hub) broadcast(roomID string, msg Message, exclude *client) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[roomID] {
		if c == exclude {
			continue
		}
		select {
		case c.send <- msg:
		default:
			// send buffer full — slow/dead client, drop rather than block
			// the whole room's broadcast on one stuck connection.
		}
	}
}

func (h *Hub) sendTo(c *client, msg Message) {
	select {
	case c.send <- msg:
	default:
	}
}

func (h *Hub) broadcastPresence(roomID string) {
	h.mu.RLock()
	entries := make([]PresenceEntry, 0, len(h.rooms[roomID]))
	for c := range h.rooms[roomID] {
		entries = append(entries, PresenceEntry{ConnID: c.id, IsHost: c.isHost})
	}
	h.mu.RUnlock()

	payload, _ := json.Marshal(PresencePayload{Connections: entries})
	h.broadcast(roomID, Message{Type: MsgPresence, Payload: payload}, nil)
}
