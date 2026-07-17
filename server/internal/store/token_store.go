package store

import (
	"errors"
	"sync"
	"time"

	"cowatch/internal/idgen"
)

var (
	ErrTokenNotFound = errors.New("token not found")
	ErrTokenExpired  = errors.New("token expired")
)

type tokenRecord struct {
	RoomID    string
	ExpiresAt time.Time
}

type TokenStore struct {
	mu     sync.Mutex
	tokens map[string]tokenRecord
	done   chan struct{}
}

func NewTokenStore(cleanupInterval time.Duration) *TokenStore {
	s := &TokenStore{tokens: make(map[string]tokenRecord), done: make(chan struct{})}
	go s.cleanup(cleanupInterval)
	return s
}

func (s *TokenStore) Create(roomID string, ttl time.Duration) (string, error) {
	token, err := idgen.JoinToken()
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.tokens[token] = tokenRecord{RoomID: roomID, ExpiresAt: time.Now().Add(ttl)}
	s.mu.Unlock()
	return token, nil
}

func (s *TokenStore) Resolve(token string) (roomID string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rec, ok := s.tokens[token]
	if !ok {
		return "", ErrTokenNotFound
	}
	if time.Now().After(rec.ExpiresAt) {
		return "", ErrTokenExpired
	}
	return rec.RoomID, nil
}

func (s *TokenStore) cleanup(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.mu.Lock()
			for key, rec := range s.tokens {
				if time.Now().After(rec.ExpiresAt) {
					delete(s.tokens, key)
				}
			}
			s.mu.Unlock()
		case <-s.done:
			return
		}
	}
}

func (s *TokenStore) Stop() {
	close(s.done)
}
