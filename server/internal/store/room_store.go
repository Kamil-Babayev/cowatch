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

// PlaybackState is the latest server-authoritative playback snapshot.
type PlaybackState struct {
	CurrentTime float64
	IsPlaying   bool
	UpdatedAt   int64 // unix millis — when this state was true, not when it was read
}

// Room contains the ephemeral configuration and state for a watch party.
type Room struct {
	ID             string
	VideoURL       string
	ControlMode    string
	CreatedAt      time.Time
	HostToken      string
	LastKnownState *PlaybackState
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

// UpdatePlaybackState overwrites the room's cached state. Called from the
// WS read loop on every relayed play/pause/seeked/timeSync.
func (s *RoomStore) UpdatePlaybackState(roomID string, state PlaybackState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if room, ok := s.rooms[roomID]; ok {
		room.LastKnownState = &state
	}
}

// PlaybackState returns the room's cached state, if any exists yet.
func (s *RoomStore) PlaybackState(roomID string) (PlaybackState, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	room, ok := s.rooms[roomID]
	if !ok || room.LastKnownState == nil {
		return PlaybackState{}, false
	}
	return *room.LastKnownState, true
}
