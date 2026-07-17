// internal/ws/message.go
package ws

import "encoding/json"

type Message struct {
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Timestamp int64           `json:"timestamp"` // unix millis, server-stamped on relay
}

const (
	MsgPresence      = "presence"      // server → clients
	MsgPlay          = "play"          // client → server → clients
	MsgPause         = "pause"         // client → server → clients
	MsgSeeked        = "seeked"        // client → server → clients
	MsgTimeSync      = "timeSync"      // client → server → clients
	MsgStateRequest  = "stateRequest"  // client → server
	MsgStateResponse = "stateResponse" // server → client (direct, not broadcast)
)

type PlaybackPayload struct {
	CurrentTime float64 `json:"currentTime"`
}

type PresenceEntry struct {
	ConnID string `json:"connId"`
	IsHost bool   `json:"isHost"`
}

type PresencePayload struct {
	Connections []PresenceEntry `json:"connections"`
}

type StateResponsePayload struct {
	CurrentTime float64 `json:"currentTime"`
	IsPlaying   bool    `json:"isPlaying"`
}
