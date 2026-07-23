// internal/ws/message.go
package ws

import "encoding/json"

// Message is the common WebSocket wire envelope.
type Message struct {
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Timestamp int64           `json:"timestamp"` // unix millis, server-stamped on relay
}

const (
	MsgSession       = "session"       // server → client, identifies this connection
	MsgPresence      = "presence"      // server → clients
	MsgPlay          = "play"          // client → server → clients
	MsgPause         = "pause"         // client → server → clients
	MsgSeeked        = "seeked"        // client → server → clients
	MsgTimeSync      = "timeSync"      // client → server → clients
	MsgStateRequest  = "stateRequest"  // client → server
	MsgStateResponse = "stateResponse" // server → client (direct, not broadcast)
	MsgControlDenied = "controlDenied" // server → client, unicast
	MsgRoomClosed    = "roomClosed"    // server → clients before the socket closes
)

// SessionPayload declares authority for the receiving connection.
type SessionPayload struct {
	ConnectionID string `json:"connectionId"`
	IsHost       bool   `json:"isHost"`
	ControlMode  string `json:"controlMode"`
}

// ControlDeniedPayload explains a rejected playback action.
type ControlDeniedPayload struct {
	Reason string `json:"reason"`
}

// PlaybackPayload is a complete playback position and play/pause snapshot.
type PlaybackPayload struct {
	CurrentTime float64 `json:"currentTime"`
	IsPlaying   bool    `json:"isPlaying"`
}

// PresenceEntry identifies one connected room participant.
type PresenceEntry struct {
	ConnID string `json:"connId"`
	IsHost bool   `json:"isHost"`
}

// PresencePayload lists all active room participants.
type PresencePayload struct {
	Connections []PresenceEntry `json:"connections"`
}

// StateResponsePayload contains the cached authoritative playback state.
type StateResponsePayload struct {
	CurrentTime float64 `json:"currentTime"`
	IsPlaying   bool    `json:"isPlaying"`
}

// RoomClosedPayload explains why a room is no longer active.
type RoomClosedPayload struct {
	Reason string `json:"reason"`
}
