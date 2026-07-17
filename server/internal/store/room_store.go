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

type PlaybackState struct{}

type Room struct {
	ID             string
	VideoURL       string
	ControlMode    string
	CreatedAt      time.Time
	HostToken      string
	LastKnownState *PlaybackState
}

type RoomStore struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

func NewRoomStore() *RoomStore {
	return &RoomStore{rooms: make(map[string]*Room)}
}

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

func (s *RoomStore) Get(id string) (*Room, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	room, ok := s.rooms[id]
	return room, ok
}

func (s *RoomStore) Delete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rooms, id)
}
