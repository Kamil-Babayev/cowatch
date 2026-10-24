package store

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestRoomStoreLifecycle(t *testing.T) {
	s := NewRoomStore()
	room, err := s.Create("https://example.com/video", ControlModeOpen)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := s.Get(room.ID); !ok || got.VideoURL != room.VideoURL || got.HostToken == "" {
		t.Fatalf("room not stored: %+v %v", got, ok)
	}
	if _, ok := s.CurrentPlayerState(room.ID); ok {
		t.Fatal("unexpected initial player state")
	}
	s.Delete(room.ID)
	if _, ok := s.Get(room.ID); ok {
		t.Fatal("room was not deleted")
	}
	if _, ok := s.CommitPlayerCommand("missing", PlayerState{}); ok {
		t.Fatal("command applied to a missing room")
	}
	if _, ok := s.ApplyHeartbeat("missing", 0, PlayerState{}); ok {
		t.Fatal("heartbeat applied to a missing room")
	}
}

func TestRoomStoreConcurrentAccess(t *testing.T) {
	s := NewRoomStore()
	room, _ := s.Create("https://example.com", ControlModeHostOnly)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			s.CommitPlayerCommand(room.ID, PlayerState{Position: float64(n)})
			s.ApplyHeartbeat(room.ID, uint64(n), PlayerState{Position: float64(n)})
			s.Get(room.ID)
			s.CurrentPlayerState(room.ID)
		}(i)
	}
	wg.Wait()
}

func TestCommandsAreLastWriterWinsAndBumpRevision(t *testing.T) {
	s := NewRoomStore()
	room, _ := s.Create("https://example.com", ControlModeOpen)
	first, ok := s.CommitPlayerCommand(room.ID, PlayerState{Position: 10, Status: "playing", UpdatedAt: 100})
	if !ok || first.Revision != 1 {
		t.Fatalf("first %+v ok=%v", first, ok)
	}
	second, ok := s.CommitPlayerCommand(room.ID, PlayerState{Position: 20, Status: "paused", UpdatedAt: 200})
	if !ok || second.Revision != 2 || second.Position != 20 {
		t.Fatalf("second %+v ok=%v", second, ok)
	}
}

func TestHeartbeatsKeepRevisionAndRejectStaleBase(t *testing.T) {
	s := NewRoomStore()
	room, _ := s.Create("https://example.com", ControlModeOpen)
	initial, ok := s.ApplyHeartbeat(room.ID, 0, PlayerState{Position: 5, Status: "playing"})
	if !ok || initial.Revision != 1 {
		t.Fatalf("initial heartbeat %+v ok=%v", initial, ok)
	}
	refreshed, ok := s.ApplyHeartbeat(room.ID, 1, PlayerState{Position: 10, Status: "playing"})
	if !ok || refreshed.Revision != 1 || refreshed.Position != 10 {
		t.Fatalf("refresh %+v ok=%v", refreshed, ok)
	}
	if _, ok := s.CommitPlayerCommand(room.ID, PlayerState{Position: 11, Status: "paused"}); !ok {
		t.Fatal("command rejected")
	}
	if _, ok := s.ApplyHeartbeat(room.ID, 1, PlayerState{Position: 12, Status: "playing"}); ok {
		t.Fatal("stale heartbeat overwrote a newer command")
	}
	if got, _ := s.CurrentPlayerState(room.ID); got.Revision != 2 || got.Status != "paused" {
		t.Fatalf("current %+v", got)
	}
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
