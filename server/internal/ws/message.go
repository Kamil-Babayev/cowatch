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
	MsgPlayerCommand   = "playerCommand"
	MsgPlayerHeartbeat = "playerHeartbeat"
	MsgPlayerState     = "playerState"
	MsgLeaveRoom       = "leaveRoom"
	MsgSession         = "session"       // server → client, identifies this connection
	MsgPresence        = "presence"      // server → clients
	MsgPlay            = "play"          // client → server → clients
	MsgPause           = "pause"         // client → server → clients
	MsgSeeked          = "seeked"        // client → server → clients
	MsgTimeSync        = "timeSync"      // client → server → clients
	MsgStateRequest    = "stateRequest"  // client → server
	MsgStateResponse   = "stateResponse" // server → client (direct, not broadcast)
	MsgControlDenied   = "controlDenied" // server → client, unicast
	MsgRoomClosed      = "roomClosed"    // server → clients before the socket closes
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
	CurrentTime float64             `json:"currentTime"`
	IsPlaying   bool                `json:"isPlaying"`
	Revision    uint64              `json:"revision,omitempty"`
	Source      *MediaSourcePayload `json:"source,omitempty"`
	Position    float64             `json:"position,omitempty"`
	Status      string              `json:"status,omitempty"`
}

type MediaSourcePayload struct {
	PageURL  string `json:"pageUrl"`
	Provider string `json:"provider"`
	MediaKey string `json:"mediaKey"`
}

type PlayerCommandPayload struct {
	CommandID    string             `json:"commandId"`
	BaseRevision uint64             `json:"baseRevision"`
	Action       string             `json:"action"`
	Source       MediaSourcePayload `json:"source"`
	Position     float64            `json:"position"`
}

type PlayerHeartbeatPayload struct {
	BaseRevision uint64             `json:"baseRevision"`
	Source       MediaSourcePayload `json:"source"`
	Position     float64            `json:"position"`
	Status       string             `json:"status"`
}

type PlayerStatePayload struct {
	Revision  uint64             `json:"revision"`
	Source    MediaSourcePayload `json:"source"`
	Position  float64            `json:"position"`
	Status    string             `json:"status"`
	CommandID string             `json:"commandId,omitempty"`
}

// RoomClosedPayload explains why a room is no longer active.
type RoomClosedPayload struct {
	Reason string `json:"reason"`
}
