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
	t.Helper()
	rooms := store.NewRoomStore()
	room, err := rooms.Create("https://example.com/video", mode)
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHub()
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

	_ = host.Close()
	closed := readType(t, guest, MsgRoomClosed)
	var closePayload RoomClosedPayload
	_ = json.Unmarshal(closed.Payload, &closePayload)
	if closePayload.Reason != "host-left" {
		t.Fatalf("close %+v", closePayload)
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
