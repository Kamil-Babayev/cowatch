package config

import "testing"

func TestLoadDefaults(t *testing.T) {
	t.Setenv("ADDR", "")
	t.Setenv("JOIN_BASE_URL", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":8080" || cfg.JoinBaseURL != "http://localhost:8080" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestLoadOverridesAndNormalizes(t *testing.T) {
	t.Setenv("ADDR", ":9090")
	t.Setenv("JOIN_BASE_URL", "https://cowatch.example/")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":9090" || cfg.JoinBaseURL != "https://cowatch.example" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadRejectsInvalidBaseURL(t *testing.T) {
	for _, value := range []string{
		"ftp://example.com",
		"relative",
		"https://example.com?x=1",
		"https://example.com/base",
		"https://user@example.com",
	} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("JOIN_BASE_URL", value)
			if _, err := Load(); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}
