package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"cowatch/internal/config"
	"cowatch/internal/store"
)

func newTestAPI(t *testing.T) (*http.ServeMux, *store.RoomStore, *store.TokenStore) {
	t.Helper()
	rooms := store.NewRoomStore()
	tokens := store.NewTokenStore(time.Hour)
	t.Cleanup(tokens.Stop)
	mux := http.NewServeMux()
	Register(mux, Deps{Rooms: rooms, Tokens: tokens, BaseURL: "http://example.test"})
	return mux, rooms, tokens
}

func request(t *testing.T, handler http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestHealthAndStaticPage(t *testing.T) {
	mux, _, _ := newTestAPI(t)
	if rec := request(t, mux, http.MethodGet, "/healthz", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("health status %d", rec.Code)
	}
	rec := request(t, mux, http.MethodGet, "/join-page/", "", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "COWATCH") {
		t.Fatalf("landing response %d %s", rec.Code, rec.Body.String())
	}
}

func TestCreateResolveAndMintRoom(t *testing.T) {
	mux, _, _ := newTestAPI(t)
	rec := request(t, mux, http.MethodPost, "/rooms", `{"videoUrl":"https://video.example/watch","controlMode":"open"}`, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create %d: %s", rec.Code, rec.Body.String())
	}
	var created createRoomResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(created.JoinURL, "/join-page/?token=") {
		t.Fatalf("bad join URL %q", created.JoinURL)
	}

	resolved := request(t, mux, http.MethodGet, "/join/"+created.JoinToken, "", nil)
	if resolved.Code != http.StatusOK || !strings.Contains(resolved.Body.String(), created.RoomID) {
		t.Fatalf("resolve %d %s", resolved.Code, resolved.Body.String())
	}
	unauthorized := request(t, mux, http.MethodPost, "/rooms/"+created.RoomID+"/tokens", "", nil)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized mint %d", unauthorized.Code)
	}
	minted := request(t, mux, http.MethodPost, "/rooms/"+created.RoomID+"/tokens", "", map[string]string{
		"Authorization": "Bearer " + created.HostToken,
	})
	if minted.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", minted.Code, minted.Body.String())
	}
}

func TestRoomValidationAndErrors(t *testing.T) {
	mux, rooms, tokens := newTestAPI(t)
	cases := []string{
		`not-json`,
		`{"videoUrl":"file:///tmp/a","controlMode":"open"}`,
		`{"videoUrl":"https://example.com","controlMode":"invalid"}`,
		`{"videoUrl":"https://example.com","controlMode":"open","extra":true}`,
		`{"videoUrl":"https://example.com","controlMode":"open"} {}`,
	}
	for _, body := range cases {
		if rec := request(t, mux, http.MethodPost, "/rooms", body, nil); rec.Code != http.StatusBadRequest {
			t.Fatalf("body %q returned %d", body, rec.Code)
		}
	}
	if rec := request(t, mux, http.MethodGet, "/join/missing", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("missing join %d", rec.Code)
	}
	if rec := request(t, mux, http.MethodPost, "/rooms/missing/tokens", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("missing room %d", rec.Code)
	}

	room, _ := rooms.Create("https://example.com", store.ControlModeOpen)
	token, _ := tokens.Create(room.ID, time.Hour)
	rooms.Delete(room.ID)
	if rec := request(t, mux, http.MethodGet, "/join/"+token, "", nil); rec.Code != http.StatusGone {
		t.Fatalf("deleted room join %d", rec.Code)
	}
}

func TestRateLimiterAndClientIP(t *testing.T) {
	limiter := newRateLimiter(1, time.Hour)
	nextCalls := 0
	handler := rateLimitMiddleware(limiter, func(w http.ResponseWriter, _ *http.Request) {
		nextCalls++
		w.WriteHeader(http.StatusNoContent)
	})
	first := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(nil))
	first.RemoteAddr = "192.0.2.1:1234"
	handler(httptest.NewRecorder(), first)
	second := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(nil))
	second.RemoteAddr = "192.0.2.1:5678"
	rec := httptest.NewRecorder()
	handler(rec, second)
	if rec.Code != http.StatusTooManyRequests || nextCalls != 1 {
		t.Fatalf("rate limit %d calls=%d", rec.Code, nextCalls)
	}
	if got := clientIP(&http.Request{RemoteAddr: "not-a-host-port"}); got != "not-a-host-port" {
		t.Fatalf("clientIP %q", got)
	}
}

func TestOriginAuthValidationAndRecovery(t *testing.T) {
	check := MakeCheckOrigin(config.Config{JoinBaseURL: "https://cowatch.example"})
	for origin, want := range map[string]bool{
		"":                          true,
		"moz-extension://random-id": true,
		"https://cowatch.example":   true,
		"https://attacker.example":  false,
		"://bad":                    false,
	} {
		req := httptest.NewRequest(http.MethodGet, "http://example.test", nil)
		req.Header.Set("Origin", origin)
		if got := check(req); got != want {
			t.Fatalf("origin %q: got %v want %v", origin, got, want)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "http://example.test?hostToken=secret", nil)
	req.Header.Set("Authorization", "Bearer secret")
	if !validHostToken(req, "secret") || !ValidHostTokenQuery(req, "secret") {
		t.Fatal("valid auth rejected")
	}
	if validHostToken(httptest.NewRequest(http.MethodGet, "/", nil), "secret") {
		t.Fatal("missing auth accepted")
	}
	panicHandler := RecoverMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec := request(t, panicHandler, http.MethodGet, "/", "", nil)
	if rec.Code != http.StatusInternalServerError || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("recovery %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
}
