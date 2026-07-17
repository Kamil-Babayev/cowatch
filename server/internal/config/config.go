package config

import (
	"fmt"
	"os"
	"time"
)

type Config struct {
	Addr            string
	JoinBaseURL     string
	TokenReapPeriod time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		Addr:            getEnv("ADDR", ":8080"),
		JoinBaseURL:     getEnv("JOIN_BASE_URL", "http://localhost:8080"),
		TokenReapPeriod: time.Minute,
	}

	if cfg.JoinBaseURL == "" {
		return Config{}, fmt.Errorf("JOIN_BASE_URL must not be empty")
	}

	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
