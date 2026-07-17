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
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	rooms := store.NewRoomStore()
	tokens := store.NewTokenStore(cfg.TokenReapPeriod)

	mux := http.NewServeMux()
	api.Register(mux, api.Deps{Rooms: rooms, Tokens: tokens, BaseURL: cfg.JoinBaseURL})

	srv := &http.Server{Addr: cfg.Addr, Handler: mux}

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

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}
