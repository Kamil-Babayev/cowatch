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

func TestConnectSessionPresenceRelayAndState(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeOpen)
	host := dialRoom(t, server, room.ID, room.HostToken)
	session := readType(t, host, MsgSession)
	var sessionPayload SessionPayload
	_ = json.Unmarshal(session.Payload, &sessionPayload)
	if !sessionPayload.IsHost || sessionPayload.ControlMode != store.ControlModeOpen {
		t.Fatalf("session %+v", sessionPayload)
	}
	guest := dialRoom(t, server, room.ID, "")
	readType(t, guest, MsgSession)
	var presencePayload PresencePayload
	for len(presencePayload.Connections) != 2 {
		presence := readType(t, host, MsgPresence)
		_ = json.Unmarshal(presence.Payload, &presencePayload)
	}

	payload, _ := json.Marshal(PlaybackPayload{CurrentTime: 12, IsPlaying: true})
	if err := host.WriteJSON(Message{Type: MsgPlay, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	relayed := readType(t, guest, MsgPlay)
	if relayed.Timestamp == 0 {
		t.Fatal("relay was not server stamped")
	}
	if err := guest.WriteJSON(Message{Type: MsgStateRequest}); err != nil {
		t.Fatal(err)
	}
	state := readType(t, guest, MsgStateResponse)
	var statePayload StateResponsePayload
	_ = json.Unmarshal(state.Payload, &statePayload)
	if statePayload.CurrentTime != 12 || !statePayload.IsPlaying {
		t.Fatalf("state %+v", statePayload)
	}
}

func TestHostOnlyDenialAndHostDeparture(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeHostOnly)
	host := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, host, MsgSession)
	guest := dialRoom(t, server, room.ID, "")
	readType(t, guest, MsgSession)

	payload, _ := json.Marshal(PlaybackPayload{CurrentTime: 10, IsPlaying: false})
	if err := guest.WriteJSON(Message{Type: MsgPause, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	denied := readType(t, guest, MsgControlDenied)
	var deniedPayload ControlDeniedPayload
	_ = json.Unmarshal(denied.Payload, &deniedPayload)
	if deniedPayload.Reason == "" {
		t.Fatal("missing denial reason")
	}

	if err := host.WriteJSON(Message{Type: MsgLeaveRoom}); err != nil {
		t.Fatal(err)
	}
	closed := readType(t, guest, MsgRoomClosed)
	var closePayload RoomClosedPayload
	_ = json.Unmarshal(closed.Payload, &closePayload)
	if closePayload.Reason != "host-left" {
		t.Fatalf("close %+v", closePayload)
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
	closed := readType(t, guest, MsgRoomClosed)
	var payload RoomClosedPayload
	_ = json.Unmarshal(closed.Payload, &payload)
	if payload.Reason != "host-left" {
		t.Fatalf("close payload %+v", payload)
	}
}

func TestRevisionedPlayerStateAndStaleCommand(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeOpen)
	host := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, host, MsgSession)
	guest := dialRoom(t, server, room.ID, "")
	readType(t, guest, MsgSession)

	source := MediaSourcePayload{
		PageURL:  "https://video.example/watch",
		Provider: "obrut",
		MediaKey: "https://abc.obrut.show/embed/1",
	}
	command, _ := json.Marshal(PlayerCommandPayload{
		CommandID: "command-1", BaseRevision: 0, Action: "play", Source: source, Position: 12,
	})
	if err := host.WriteJSON(Message{Type: MsgPlayerCommand, Payload: command}); err != nil {
		t.Fatal(err)
	}
	accepted := readType(t, guest, MsgPlayerState)
	var state PlayerStatePayload
	_ = json.Unmarshal(accepted.Payload, &state)
	if state.Revision != 1 || state.Status != "playing" || state.Position != 12 || state.CommandID != "command-1" {
		t.Fatalf("state %+v", state)
	}

	stale, _ := json.Marshal(PlayerCommandPayload{
		CommandID: "stale", BaseRevision: 0, Action: "pause", Source: source, Position: 13,
	})
	if err := guest.WriteJSON(Message{Type: MsgPlayerCommand, Payload: stale}); err != nil {
		t.Fatal(err)
	}
	response := readType(t, guest, MsgStateResponse)
	var snapshot StateResponsePayload
	_ = json.Unmarshal(response.Payload, &snapshot)
	if snapshot.Revision != 1 || snapshot.Status != "playing" || snapshot.Source == nil {
		t.Fatalf("snapshot %+v", snapshot)
	}

	late := dialRoom(t, server, room.ID, "")
	readType(t, late, MsgSession)
	if err := late.WriteJSON(Message{Type: MsgStateRequest}); err != nil {
		t.Fatal(err)
	}
	lateState := readType(t, late, MsgStateResponse)
	_ = json.Unmarshal(lateState.Payload, &snapshot)
	if snapshot.Revision != 1 || snapshot.Source.MediaKey != source.MediaKey {
		t.Fatalf("late snapshot %+v", snapshot)
	}
}

func TestSourceReplacementIsAlwaysHostOnly(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeOpen)
	host := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, host, MsgSession)
	guest := dialRoom(t, server, room.ID, "")
	readType(t, guest, MsgSession)
	source := MediaSourcePayload{PageURL: "https://video.example/2", Provider: "native", MediaKey: "https://cdn.example/2.mp4"}
	payload, _ := json.Marshal(PlayerCommandPayload{CommandID: "replace-1", Action: "replace", Source: source})
	if err := guest.WriteJSON(Message{Type: MsgPlayerCommand, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	readType(t, guest, MsgControlDenied)
	if err := host.WriteJSON(Message{Type: MsgPlayerCommand, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	state := readType(t, guest, MsgPlayerState)
	var accepted PlayerStatePayload
	_ = json.Unmarshal(state.Payload, &accepted)
	if accepted.Source.PageURL != source.PageURL || accepted.Status != "paused" {
		t.Fatalf("accepted %+v", accepted)
	}
}

func TestInvalidPayloadAndUnknownRoom(t *testing.T) {
	server, room, _ := websocketServer(t, store.ControlModeOpen)
	conn := dialRoom(t, server, room.ID, room.HostToken)
	readType(t, conn, MsgSession)
	bad, _ := json.Marshal(PlaybackPayload{CurrentTime: -1, IsPlaying: true})
	if err := conn.WriteJSON(Message{Type: MsgPlay, Payload: bad}); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(Message{Type: "unknown"}); err != nil {
		t.Fatal(err)
	}

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
	msg := readType(t, conn, MsgRoomClosed)
	var payload RoomClosedPayload
	_ = json.Unmarshal(msg.Payload, &payload)
	if payload.Reason != "server-shutdown" {
		t.Fatalf("payload %+v", payload)
	}
}
