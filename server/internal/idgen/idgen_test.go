package idgen

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func TestNewWithReader(t *testing.T) {
	got, err := newWithReader(4, strings.NewReader("abcd"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "YWJjZA" {
		t.Fatalf("got %q", got)
	}
}

func TestNewWithReaderFailure(t *testing.T) {
	_, err := newWithReader(4, io.MultiReader(strings.NewReader("a"), failingReader{}))
	if err == nil {
		t.Fatal("expected entropy error")
	}
}

func TestRoleLengthsAndUniqueness(t *testing.T) {
	roomA, _ := RoomID()
	roomB, _ := RoomID()
	join, _ := JoinToken()
	host, _ := HostToken()
	if roomA == roomB || len(roomA) != 22 || len(join) != 32 || len(host) != 43 {
		t.Fatalf("unexpected generated values: %q %q %q %q", roomA, roomB, join, host)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("boom") }
