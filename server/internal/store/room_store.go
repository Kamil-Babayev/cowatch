package store

import (
	"sync"
	"time"

	"cowatch/internal/idgen"
)

const (
	ControlModeOpen     = "open"
	ControlModeHostOnly = "host-only"
)

type MediaSource struct {
	PageURL  string
	Provider string
	MediaKey string
}

type PlayerState struct {
	Revision  uint64
	Source    MediaSource
	Position  float64
	Status    string
	UpdatedAt int64
}

// Room contains the ephemeral configuration and state for a watch party.
type Room struct {
	ID          string
	VideoURL    string
	ControlMode string
	CreatedAt   time.Time
	HostToken   string
	PlayerState *PlayerState
}

// RoomStore safely stores active rooms in memory.
type RoomStore struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

// NewRoomStore creates an empty room store.
func NewRoomStore() *RoomStore {
	return &RoomStore{rooms: make(map[string]*Room)}
}

// Create adds a room with fresh room and host credentials.
func (s *RoomStore) Create(videoURL, controlMode string) (*Room, error) {
	id, err := idgen.RoomID()
	if err != nil {
		return nil, err
	}
	hostToken, err := idgen.HostToken()
	if err != nil {
		return nil, err
	}
	room := &Room{
		ID:          id,
		VideoURL:    videoURL,
		ControlMode: controlMode,
		CreatedAt:   time.Now(),
		HostToken:   hostToken,
	}
	s.mu.Lock()
	s.rooms[room.ID] = room
	s.mu.Unlock()
	return room, nil
}

// Get returns a room by ID.
func (s *RoomStore) Get(id string) (*Room, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	room, ok := s.rooms[id]
	return room, ok
}

// Delete removes a room by ID.
func (s *RoomStore) Delete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rooms, id)
}

// CommitPlayerCommand records an explicit user action. Commands are
// last-writer-wins: they always apply and always advance the revision, so a
// user's play/pause/seek is never reverted just because a heartbeat landed
// a moment earlier.
func (s *RoomStore) CommitPlayerCommand(roomID string, next PlayerState) (PlayerState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room, ok := s.rooms[roomID]
	if !ok {
		return PlayerState{}, false
	}
	if room.PlayerState != nil {
		next.Revision = room.PlayerState.Revision + 1
	} else {
		next.Revision = 1
	}
	room.PlayerState = &next
	return next, true
}

// ApplyHeartbeat refreshes the host's periodic position report. A heartbeat
// only applies on top of the revision the host last saw, so it can never
// overwrite a newer command; when it applies it keeps the current revision
// (the first heartbeat in an empty room establishes revision 1).
func (s *RoomStore) ApplyHeartbeat(roomID string, baseRevision uint64, next PlayerState) (PlayerState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room, ok := s.rooms[roomID]
	if !ok {
		return PlayerState{}, false
	}
	if room.PlayerState == nil {
		next.Revision = 1
	} else {
		if baseRevision != room.PlayerState.Revision {
			return PlayerState{}, false
		}
		next.Revision = room.PlayerState.Revision
	}
	room.PlayerState = &next
	return next, true
}

func (s *RoomStore) CurrentPlayerState(roomID string) (PlayerState, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	room, ok := s.rooms[roomID]
	if !ok || room.PlayerState == nil {
		return PlayerState{}, false
	}
	return *room.PlayerState, true
}
