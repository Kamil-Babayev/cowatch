package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

// Config contains validated process and public-link settings.
type Config struct {
	Addr            string
	JoinBaseURL     string
	TokenReapPeriod time.Duration
}

// Load reads configuration from the environment and applies safe defaults.
func Load() (Config, error) {
	cfg := Config{
		Addr:            getEnv("ADDR", ":8080"),
		JoinBaseURL:     getEnv("JOIN_BASE_URL", "http://localhost:8080"),
		TokenReapPeriod: time.Minute,
	}

	parsed, err := url.Parse(cfg.JoinBaseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return Config{}, fmt.Errorf("JOIN_BASE_URL must be an absolute http(s) URL")
	}
	if parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return Config{}, fmt.Errorf("JOIN_BASE_URL must be an origin without credentials, path, query, or fragment")
	}
	parsed.Path = ""
	cfg.JoinBaseURL = strings.TrimRight(parsed.String(), "/")

	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
