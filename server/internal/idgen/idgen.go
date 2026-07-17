package idgen

import (
	"crypto/rand"
	"encoding/base64"
)

func New(byteLen int) (string, error) {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func RoomID() (string, error) {
	return New(16)
}

func JoinToken() (string, error) {
	return New(24)
}

func HostToken() (string, error) {
	return New(32)
}
