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
	MsgSession         = "session"         // server → client, identifies this connection
	MsgPresence        = "presence"        // server → clients
	MsgPlayerCommand   = "playerCommand"   // client → server, an explicit user action
	MsgPlayerHeartbeat = "playerHeartbeat" // host → server, periodic position report
	MsgPlayerState     = "playerState"     // server → clients, the authoritative state
	MsgStateRequest    = "stateRequest"    // client → server
	MsgStateResponse   = "stateResponse"   // server → client (direct, not broadcast)
	MsgClockPing       = "clockPing"       // client → server
	MsgClockPong       = "clockPong"       // server → client (direct)
	MsgControlDenied   = "controlDenied"   // server → client, unicast
	MsgLeaveRoom       = "leaveRoom"       // client → server, explicit departure
	MsgRoomClosed      = "roomClosed"      // server → clients before the socket closes
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

// PresenceEntry identifies one connected room participant.
type PresenceEntry struct {
	ConnID string `json:"connId"`
	IsHost bool   `json:"isHost"`
}

// PresencePayload lists all active room participants.
type PresencePayload struct {
	Connections []PresenceEntry `json:"connections"`
}

// StateResponsePayload is the cached authoritative player state, sent to a
// client that asked for it. Its envelope timestamp is when the state was true.
type StateResponsePayload struct {
	Revision uint64             `json:"revision"`
	Source   MediaSourcePayload `json:"source"`
	Position float64            `json:"position"`
	Status   string             `json:"status"`
}

type MediaSourcePayload struct {
	PageURL  string `json:"pageUrl"`
	Provider string `json:"provider"`
	MediaKey string `json:"mediaKey"`
}

type PlayerCommandPayload struct {
	CommandID string             `json:"commandId"`
	Action    string             `json:"action"`
	Source    MediaSourcePayload `json:"source"`
	Position  float64            `json:"position"`
}

type PlayerHeartbeatPayload struct {
	BaseRevision uint64             `json:"baseRevision"`
	Source       MediaSourcePayload `json:"source"`
	Position     float64            `json:"position"`
	Status       string             `json:"status"`
}

type PlayerStatePayload struct {
	Revision           uint64             `json:"revision"`
	Source             MediaSourcePayload `json:"source"`
	Position           float64            `json:"position"`
	Status             string             `json:"status"`
	CommandID          string             `json:"commandId,omitempty"`
	OriginConnectionID string             `json:"originConnectionId"`
}

// ClockPingPayload carries the client's send time so it can measure its
// offset from the server clock.
type ClockPingPayload struct {
	T0 float64 `json:"t0"`
}

// ClockPongPayload echoes T0 with the server's current time in unix millis.
type ClockPongPayload struct {
	T0         float64 `json:"t0"`
	ServerTime int64   `json:"serverTime"`
}

// RoomClosedPayload explains why a room is no longer active.
type RoomClosedPayload struct {
	Reason string `json:"reason"`
}
