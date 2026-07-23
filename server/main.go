package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"cowatch/internal/api"
	"cowatch/internal/config"
	"cowatch/internal/store"
	"cowatch/internal/ws"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	rooms := store.NewRoomStore()
	tokens := store.NewTokenStore(cfg.TokenReapPeriod)
	hub := ws.NewHub()
	hub.OnRoomEmpty = rooms.Delete // rooms die on last-disconnect, not on a timer

	mux := http.NewServeMux()
	api.Register(mux, api.Deps{Rooms: rooms, Tokens: tokens, BaseURL: cfg.JoinBaseURL})
	mux.Handle("GET /rooms/{roomId}/connect", ws.HandleConnect(hub, rooms, api.MakeCheckOrigin(cfg)))

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.RecoverMiddleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Printf("listening on %s", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	tokens.Stop()
	hub.CloseAll("server-shutdown")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
