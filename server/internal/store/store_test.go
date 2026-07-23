package store

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestRoomStoreLifecycleAndPlayback(t *testing.T) {
	s := NewRoomStore()
	room, err := s.Create("https://example.com/video", ControlModeOpen)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := s.Get(room.ID); !ok || got.VideoURL != room.VideoURL || got.HostToken == "" {
		t.Fatalf("room not stored: %+v %v", got, ok)
	}
	if _, ok := s.PlaybackState(room.ID); ok {
		t.Fatal("unexpected initial playback state")
	}
	state := PlaybackState{CurrentTime: 12.5, IsPlaying: true, UpdatedAt: 42}
	s.UpdatePlaybackState(room.ID, state)
	if got, ok := s.PlaybackState(room.ID); !ok || got != state {
		t.Fatalf("got %+v, %v", got, ok)
	}
	s.Delete(room.ID)
	if _, ok := s.Get(room.ID); ok {
		t.Fatal("room was not deleted")
	}
	s.UpdatePlaybackState("missing", state)
}

func TestRoomStoreConcurrentAccess(t *testing.T) {
	s := NewRoomStore()
	room, _ := s.Create("https://example.com", ControlModeHostOnly)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			s.UpdatePlaybackState(room.ID, PlaybackState{CurrentTime: float64(n)})
			s.Get(room.ID)
			s.PlaybackState(room.ID)
		}(i)
	}
	wg.Wait()
}

func TestTokenStoreResolveExpireCleanupAndStop(t *testing.T) {
	s := NewTokenStore(2 * time.Millisecond)
	token, err := s.Create("room", 5*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if roomID, err := s.Resolve(token); err != nil || roomID != "room" {
		t.Fatalf("resolve: %q %v", roomID, err)
	}
	if _, err := s.Resolve("missing"); !errors.Is(err, ErrTokenNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
	time.Sleep(10 * time.Millisecond)
	if _, err := s.Resolve(token); !errors.Is(err, ErrTokenExpired) && !errors.Is(err, ErrTokenNotFound) {
		t.Fatalf("expected expired or cleaned up, got %v", err)
	}
	s.Stop()
	s.Stop()
}
