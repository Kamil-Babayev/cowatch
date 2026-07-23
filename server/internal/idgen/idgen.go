package idgen

import (
	"crypto/rand"
	"encoding/base64"
	"io"
)

// New returns a URL-safe random identifier with byteLen bytes of entropy.
func New(byteLen int) (string, error) {
	return newWithReader(byteLen, rand.Reader)
}

func newWithReader(byteLen int, reader io.Reader) (string, error) {
	b := make([]byte, byteLen)
	if _, err := io.ReadFull(reader, b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// RoomID returns a new room identifier.
func RoomID() (string, error) {
	return New(16)
}

// JoinToken returns a new short-lived invitation credential.
func JoinToken() (string, error) {
	return New(24)
}

// HostToken returns a new host bearer credential.
func HostToken() (string, error) {
	return New(32)
}
