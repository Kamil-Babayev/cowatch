package ws

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"cowatch/internal/store"
	"github.com/gorilla/websocket"
)

func websocketServer(t *testing.T, mode string) (*httptest.Server, *store.Room, *Hub) {
	return websocketServerWithGrace(t, mode, 30*time.Second)
}

func websocketServerWithGrace(t *testing.T, mode string, grace time.Duration) (*httptest.Server, *store.Room, *Hub) {
	t.Helper()
	rooms := store.NewRoomStore()
	room, err := rooms.Create("https://example.com/video", mode)
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHubWithHostGrace(grace)
	hub.OnRoomEmpty = rooms.Delete
	mux := http.NewServeMux()
	mux.Handle("GET /rooms/{roomId}/connect", HandleConnect(hub, rooms, func(*http.Request) bool { return true }))
	server := httptest.NewServer(mux)
	t.Cleanup(func() {
		hub.CloseAll("server-shutdown")
		server.Close()
	})
	return server, room, hub
}

func dialRoom(t *testing.T, server *httptest.Server, roomID, hostToken string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/rooms/" + roomID + "/connect"
	if hostToken != "" {
		url += "?hostToken=" + hostToken
	}
	conn, response, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		if response != nil {
			t.Fatalf("dial: %v (%d)", err, response.StatusCode)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func readType(t *testing.T, conn *websocket.Conn, wanted string) Message {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		var msg Message
		if err := conn.ReadJSON(&msg); err != nil {
			t.Fatalf("reading %s: %v", wanted, err)
		}
		if msg.Type == wanted {
			return msg
		}
	}
}

func decode[T any](t *testing.T, msg Message) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(msg.Payload, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

var nativeSource = MediaSourcePayload{
	PageURL:  "https://video.example/watch",
	Provider: "native",
	MediaKey: "https://video.example/watch#1420",
}

func sendCommand(t *testing.T, conn *websocket.Conn, id, action string, source MediaSourcePayload, position float64) {
	t.Helper()
	payload, _ := json.Marshal(PlayerCommandPayload{CommandID: id, Action: action, Source: source, Position: position})
	if err := conn.WriteJSON(Message{Type: MsgPlayerCommand, Payload: payload}); err != nil {
		t.Fatal(err)
	}
}

func sendHeartbeat(t *testing.T, conn *websocket.Conn, base uint64, position float64, status string) {
	t.Helper()
	payload, _ := json.Marshal(PlayerHeartbeatPayload{BaseRevision: base, Source: nativeSource, Position: position, Status: status})
	if err := conn.WriteJSON(Message{Type: MsgPlayerHeartbeat, Payload: payload}); err != nil {
		t.Fatal(err)
	}
}

func requestState(t *testing.T, conn *websocket.Conn) StateResponsePayload {
	t.Helper()
	if err := conn.WriteJSON(Message{Type: MsgStateRequest}); err != nil {
		t.Fatal(err)
	}
	return decode[StateResponsePayload](t, readType(t, conn, MsgStateResponse))
}

func TestConnectSessionPresenceAndState(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeOpen)
	host := dialRoom(t, server, room.ID, room.HostToken)
	session := decode[SessionPayload](t, readType(t, host, MsgSession))
	if !session.IsHost || session.ControlMode != store.ControlModeOpen || session.ConnectionID == "" {
		t.Fatalf("session %+v", session)
	}
	guest := dialRoom(t, server, room.ID, "")
	readType(t, guest, MsgSession)
	var presence PresencePayload
	for len(presence.Connections) != 2 {
		presence = decode[PresencePayload](t, readType(t, host, MsgPresence))
	}

	sendCommand(t, host, "c1", "play", nativeSource, 12)
	if relayed := readType(t, guest, MsgPlayerState); relayed.Timestamp == 0 {
		t.Fatal("state was not server stamped")
	}
	state := requestState(t, guest)
	if state.Position != 12 || state.Status != "playing" || state.Revision != 1 || state.Source != nativeSource {
		t.Fatalf("state %+v", state)
	}
}

func TestClockPingIsAnsweredWithServerTime(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeOpen)
	conn := dialRoom(t, server, room.ID, "")
	readType(t, conn, MsgSession)
	if err := conn.WriteJSON(Message{Type: MsgClockPing, Payload: json.RawMessage(`{"t0":"bad"}`)}); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(ClockPingPayload{T0: 1234.5})
	if err := conn.WriteJSON(Message{Type: MsgClockPing, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	pong := decode[ClockPongPayload](t, readType(t, conn, MsgClockPong))
	if pong.T0 != 1234.5 || pong.ServerTime == 0 {
		t.Fatalf("pong %+v", pong)
	}
}

func TestHostOnlyDenialAndHostDeparture(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeHostOnly)
	host := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, host, MsgSession)
	guest := dialRoom(t, server, room.ID, "")
	readType(t, guest, MsgSession)

	sendCommand(t, guest, "denied", "pause", nativeSource, 10)
	if denied := decode[ControlDeniedPayload](t, readType(t, guest, MsgControlDenied)); denied.Reason == "" {
		t.Fatal("missing denial reason")
	}

	if err := host.WriteJSON(Message{Type: MsgLeaveRoom}); err != nil {
		t.Fatal(err)
	}
	if closed := decode[RoomClosedPayload](t, readType(t, guest, MsgRoomClosed)); closed.Reason != "host-left" {
		t.Fatalf("close %+v", closed)
	}
}

func TestHostReconnectGraceAndExpiry(t *testing.T) {
	server, room, _ := websocketServerWithGrace(t, store.ControlModeOpen, 80*time.Millisecond)
	host := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, host, MsgSession)
	guest := dialRoom(t, server, room.ID, "")
	readType(t, guest, MsgSession)
	_ = host.Close()
	time.Sleep(20 * time.Millisecond)
	reconnected := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, reconnected, MsgSession)
	time.Sleep(100 * time.Millisecond)
	if err := reconnected.WriteJSON(Message{Type: MsgStateRequest}); err != nil {
		t.Fatalf("reconnected host was closed during grace: %v", err)
	}
	_ = reconnected.Close()
	if closed := decode[RoomClosedPayload](t, readType(t, guest, MsgRoomClosed)); closed.Reason != "host-left" {
		t.Fatalf("close payload %+v", closed)
	}
}

func TestCommandsAreLastWriterWinsAndCarryOrigin(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeOpen)
	host := dialRoom(t, server, room.ID, room.HostToken)
	hostSession := decode[SessionPayload](t, readType(t, host, MsgSession))
	guest := dialRoom(t, server, room.ID, "")
	guestSession := decode[SessionPayload](t, readType(t, guest, MsgSession))

	obrut := MediaSourcePayload{PageURL: "https://video.example/watch", Provider: "obrut", MediaKey: "https://abc.obrut.show/embed/1"}
	sendCommand(t, host, "command-1", "play", obrut, 12)
	accepted := decode[PlayerStatePayload](t, readType(t, guest, MsgPlayerState))
	if accepted.Revision != 1 || accepted.Status != "playing" || accepted.Position != 12 ||
		accepted.CommandID != "command-1" || accepted.OriginConnectionID != hostSession.ConnectionID {
		t.Fatalf("state %+v", accepted)
	}
	if echo := decode[PlayerStatePayload](t, readType(t, host, MsgPlayerState)); echo.OriginConnectionID != hostSession.ConnectionID {
		t.Fatalf("originator echo %+v", echo)
	}

	// A guest that has not seen revision 1 yet still wins: commands never revert.
	sendCommand(t, guest, "command-2", "pause", obrut, 13)
	paused := decode[PlayerStatePayload](t, readType(t, host, MsgPlayerState))
	if paused.Revision != 2 || paused.Status != "paused" || paused.OriginConnectionID != guestSession.ConnectionID {
		t.Fatalf("paused %+v", paused)
	}

	late := dialRoom(t, server, room.ID, "")
	readType(t, late, MsgSession)
	if snapshot := requestState(t, late); snapshot.Revision != 2 || snapshot.Source.MediaKey != obrut.MediaKey {
		t.Fatalf("late snapshot %+v", snapshot)
	}
}

func TestHeartbeatsKeepRevisionSkipSenderAndDropStale(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeOpen)
	host := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, host, MsgSession)
	guest := dialRoom(t, server, room.ID, "")
	readType(t, guest, MsgSession)

	sendHeartbeat(t, guest, 0, 99, "playing") // ignored: guests have no heartbeat authority
	sendHeartbeat(t, host, 0, 24, "buffering")
	first := decode[PlayerStatePayload](t, readType(t, guest, MsgPlayerState))
	if first.Revision != 1 || first.Status != "buffering" || first.Position != 24 || first.Source != nativeSource {
		t.Fatalf("heartbeat state %+v", first)
	}
	sendHeartbeat(t, host, 1, 30, "playing")
	if second := decode[PlayerStatePayload](t, readType(t, guest, MsgPlayerState)); second.Revision != 1 || second.Position != 30 {
		t.Fatalf("refresh %+v", second)
	}

	sendCommand(t, guest, "pause", "pause", nativeSource, 31)
	// The host's next message is the guest's command: its own heartbeats
	// were never echoed back to it.
	if next := decode[PlayerStatePayload](t, readType(t, host, MsgPlayerState)); next.CommandID != "pause" {
		t.Fatalf("host received %+v", next)
	}
	sendHeartbeat(t, host, 1, 32, "playing") // stale: must not undo the guest's pause

	if snapshot := requestState(t, host); snapshot.Revision != 2 || snapshot.Status != "paused" || snapshot.Position != 31 {
		t.Fatalf("stale heartbeat applied: %+v", snapshot)
	}
}

func TestMediaSourceValidation(t *testing.T) {
	cases := map[string]struct {
		source MediaSourcePayload
		want   bool
	}{
		"native opaque key":   {MediaSourcePayload{PageURL: "https://a.example/v", Provider: "native", MediaKey: "https://a.example/v#90"}, true},
		"native non-url key":  {MediaSourcePayload{PageURL: "https://a.example/v", Provider: "native", MediaKey: "page-key"}, true},
		"empty key":           {MediaSourcePayload{PageURL: "https://a.example/v", Provider: "native"}, false},
		"oversized key":       {MediaSourcePayload{PageURL: "https://a.example/v", Provider: "native", MediaKey: strings.Repeat("k", maxMediaKeyLength+1)}, false},
		"non-http page":       {MediaSourcePayload{PageURL: "file:///v", Provider: "native", MediaKey: "k"}, false},
		"obrut host":          {MediaSourcePayload{PageURL: "https://a.example/v", Provider: "obrut", MediaKey: "https://x.obrut.show/e/1"}, true},
		"obrut wrong host":    {MediaSourcePayload{PageURL: "https://a.example/v", Provider: "obrut", MediaKey: "https://evil.example/e/1"}, false},
		"obrut non-http":      {MediaSourcePayload{PageURL: "https://a.example/v", Provider: "obrut", MediaKey: "blob:x"}, false},
		"unknown provider":    {MediaSourcePayload{PageURL: "https://a.example/v", Provider: "other", MediaKey: "k"}, false},
		"unparseable page":    {MediaSourcePayload{PageURL: "://bad", Provider: "native", MediaKey: "k"}, false},
		"obrut unparseable":   {MediaSourcePayload{PageURL: "https://a.example/v", Provider: "obrut", MediaKey: "://bad"}, false},
		"native http mp4 key": {MediaSourcePayload{PageURL: "https://a.example/v", Provider: "native", MediaKey: "https://cdn.example/v.mp4"}, true},
	}
	for name, tc := range cases {
		if got := validMediaSource(tc.source); got != tc.want {
			t.Errorf("%s: got %v want %v", name, got, tc.want)
		}
	}
}

func TestSourceReplacementIsAlwaysHostOnly(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeOpen)
	host := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, host, MsgSession)
	guest := dialRoom(t, server, room.ID, "")
	readType(t, guest, MsgSession)
	source := MediaSourcePayload{PageURL: "https://video.example/2", Provider: "native", MediaKey: "https://video.example/2#60"}
	sendCommand(t, guest, "replace-1", "replace", source, 0)
	readType(t, guest, MsgControlDenied)
	sendCommand(t, host, "replace-1", "replace", source, 0)
	accepted := decode[PlayerStatePayload](t, readType(t, guest, MsgPlayerState))
	if accepted.Source.PageURL != source.PageURL || accepted.Status != "paused" {
		t.Fatalf("accepted %+v", accepted)
	}
}

func TestInvalidPayloadAndUnknownRoom(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeOpen)
	conn := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, conn, MsgSession)
	sendCommand(t, conn, "bad", "play", nativeSource, -1)
	sendCommand(t, conn, "odd", "rewind", nativeSource, 1)
	if err := conn.WriteJSON(Message{Type: "unknown"}); err != nil {
		t.Fatal(err)
	}
	sendCommand(t, conn, "good", "seek", nativeSource, 5)
	if snapshot := requestState(t, conn); snapshot.Revision != 1 || snapshot.Position != 5 {
		t.Fatalf("an invalid command was stored: %+v", snapshot)
	}
}

func TestUnknownRoomIsNotFound(t *testing.T) {
	server, _, _ := websocketServer(t, store.ControlModeOpen)
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/rooms/missing/connect"
	_, response, err := websocket.DefaultDialer.Dial(url, nil)
	if err == nil || response == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown room response=%v err=%v", response, err)
	}
}

func TestCloseAll(t *testing.T) {
	server, room, hub := websocketServer(t, store.ControlModeOpen)
	conn := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, conn, MsgSession)
	hub.CloseAll("server-shutdown")
	if payload := decode[RoomClosedPayload](t, readType(t, conn, MsgRoomClosed)); payload.Reason != "server-shutdown" {
		t.Fatalf("payload %+v", payload)
	}
}
