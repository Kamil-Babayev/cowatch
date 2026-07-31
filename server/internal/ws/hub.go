package ws

import (
	"encoding/json"
	"sync"
	"time"
)

// Hub tracks active clients by room and routes server messages.
type Hub struct {
	mu              sync.RWMutex
	rooms           map[string]map[*client]struct{}
	hostGrace       map[string]*hostGrace
	hostGracePeriod time.Duration
	OnRoomEmpty     func(roomID string) // called after the last connection in a room leaves
}

type hostGrace struct {
	timer *time.Timer
}

func (h *Hub) leave(c *client, explicit bool) {
	h.mu.Lock()
	members, exists := h.rooms[c.roomID]
	if !exists {
		h.mu.Unlock()
		return
	}
	delete(members, c)
	empty := len(members) == 0
	hostStillPresent := false
	for member := range members {
		if member.isHost {
			hostStillPresent = true
			break
		}
	}
	if c.isHost && explicit {
		remaining := clientsFromMembers(members)
		delete(h.rooms, c.roomID)
		if grace := h.hostGrace[c.roomID]; grace != nil {
			grace.timer.Stop()
			delete(h.hostGrace, c.roomID)
		}
		h.mu.Unlock()
		if h.OnRoomEmpty != nil {
			h.OnRoomEmpty(c.roomID)
		}
		h.closeClients(remaining, "host-left")
		return
	}
	if c.isHost && !hostStillPresent {
		if old := h.hostGrace[c.roomID]; old != nil {
			old.timer.Stop()
		}
		grace := &hostGrace{}
		grace.timer = time.AfterFunc(h.hostGracePeriod, func() {
			h.expireHostGrace(c.roomID, grace)
		})
		h.hostGrace[c.roomID] = grace
		h.mu.Unlock()
		h.broadcastPresence(c.roomID)
		return
	}
	if empty && h.hostGrace[c.roomID] == nil {
		delete(h.rooms, c.roomID)
		h.mu.Unlock()
		if h.OnRoomEmpty != nil {
			h.OnRoomEmpty(c.roomID)
		}
		return
	}
	h.mu.Unlock()
	h.broadcastPresence(c.roomID)
}

// NewHub creates an empty WebSocket hub.
func NewHub() *Hub {
	return NewHubWithHostGrace(30 * time.Second)
}

func NewHubWithHostGrace(period time.Duration) *Hub {
	return &Hub{
		rooms:           make(map[string]map[*client]struct{}),
		hostGrace:       make(map[string]*hostGrace),
		hostGracePeriod: period,
	}
}

func (h *Hub) join(c *client) {
	h.mu.Lock()
	if c.isHost {
		if grace := h.hostGrace[c.roomID]; grace != nil {
			grace.timer.Stop()
			delete(h.hostGrace, c.roomID)
		}
	}
	if h.rooms[c.roomID] == nil {
		h.rooms[c.roomID] = make(map[*client]struct{})
	}
	h.rooms[c.roomID][c] = struct{}{}
	h.mu.Unlock()

	h.broadcastPresence(c.roomID)
}

func clientsFromMembers(members map[*client]struct{}) []*client {
	clients := make([]*client, 0, len(members))
	for member := range members {
		clients = append(clients, member)
	}
	return clients
}

func (h *Hub) expireHostGrace(roomID string, expected *hostGrace) {
	h.mu.Lock()
	if h.hostGrace[roomID] != expected {
		h.mu.Unlock()
		return
	}
	delete(h.hostGrace, roomID)
	members := h.rooms[roomID]
	for member := range members {
		if member.isHost {
			h.mu.Unlock()
			return
		}
	}
	clients := clientsFromMembers(members)
	delete(h.rooms, roomID)
	h.mu.Unlock()
	if h.OnRoomEmpty != nil {
		h.OnRoomEmpty(roomID)
	}
	h.closeClients(clients, "host-left")
}

func (h *Hub) broadcast(roomID string, msg Message, exclude *client) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[roomID] {
		if c == exclude {
			continue
		}
		select {
		case <-c.done:
			continue
		case c.send <- msg:
		default:
			// send buffer full — slow/dead client, drop rather than block
			// the whole room's broadcast on one stuck connection.
		}
	}
}

func (h *Hub) sendTo(c *client, msg Message) {
	select {
	case <-c.done:
		return
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
	h.broadcast(roomID, Message{Type: MsgPresence, Payload: payload, Timestamp: time.Now().UnixMilli()}, nil)
}

func (h *Hub) closeClients(clients []*client, reason string) {
	payload, _ := json.Marshal(RoomClosedPayload{Reason: reason})
	msg := Message{Type: MsgRoomClosed, Payload: payload, Timestamp: time.Now().UnixMilli()}
	for _, c := range clients {
		select {
		case <-c.done:
		case c.send <- msg:
		default:
			// A saturated writer cannot deliver the final notice reliably;
			// close it now rather than leaving a hijacked socket alive.
			c.finish()
		}
	}
}

// CloseAll notifies every connected client and removes all active rooms.
func (h *Hub) CloseAll(reason string) {
	h.mu.Lock()
	rooms := h.rooms
	h.rooms = make(map[string]map[*client]struct{})
	for roomID, grace := range h.hostGrace {
		grace.timer.Stop()
		delete(h.hostGrace, roomID)
	}
	h.mu.Unlock()

	allClients := make([]*client, 0)
	for roomID, members := range rooms {
		clients := make([]*client, 0, len(members))
		for c := range members {
			clients = append(clients, c)
		}
		allClients = append(allClients, clients...)
		if h.OnRoomEmpty != nil {
			h.OnRoomEmpty(roomID)
		}
		h.closeClients(clients, reason)
	}

	// WebSockets are hijacked connections, so http.Server.Shutdown does not
	// wait for them. Give writer loops time to send roomClosed and finish
	// before the process exits.
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	for _, c := range allClients {
		select {
		case <-c.done:
		case <-deadline.C:
			for _, remaining := range allClients {
				remaining.finish()
			}
			return
		}
	}
}
