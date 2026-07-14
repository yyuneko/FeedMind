package config

import (
	"strings"
	"testing"
	"time"
)

func setRequiredEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://localhost/feedmind")
	t.Setenv("FEEDMIND_JWT_SECRET", strings.Repeat("x", 32))
	t.Setenv("FEEDMIND_HTML_WORKER_URL", "")
	t.Setenv("FEEDMIND_HTML_WORKER_TOKEN", "")
	t.Setenv("FEEDMIND_HTML_WORKER_TIMEOUT", "")
	t.Setenv("FEEDMIND_HTML_WORKER_MAX_BYTES", "")
}

func TestHTMLWorkerDefaultsAreBackwardCompatible(t *testing.T) {
	setRequiredEnvironment(t)
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.HTMLWorkerURL != "" || config.HTMLWorkerToken != "" || config.HTMLWorkerTimeout != 20*time.Second || config.HTMLWorkerMaxBytes != 8<<20 {
		t.Fatalf("unexpected HTML Worker defaults: %#v", config)
	}
}

func TestHTMLWorkerURLAndTokenMustBeConfiguredTogether(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("FEEDMIND_HTML_WORKER_URL", "https://fetch.example.workers.dev/html")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "configured together") {
		t.Fatalf("expected paired configuration error, got %v", err)
	}
}

func TestHTMLWorkerURLRequiresHTTPSExceptLoopback(t *testing.T) {
	for _, test := range []struct {
		name    string
		url     string
		wantErr bool
	}{
		{name: "https", url: "https://fetch.example.workers.dev/html"},
		{name: "localhost", url: "http://localhost:8787/html"},
		{name: "loopback IPv4", url: "http://127.0.0.1:8787/html"},
		{name: "Docker host", url: "http://host.docker.internal:8787/html"},
		{name: "Docker host trailing dot", url: "http://host.docker.internal.:8787/html"},
		{name: "public HTTP", url: "http://fetch.example.com/html", wantErr: true},
		{name: "missing path", url: "https://fetch.example.com", wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			setRequiredEnvironment(t)
			t.Setenv("FEEDMIND_HTML_WORKER_URL", test.url)
			t.Setenv("FEEDMIND_HTML_WORKER_TOKEN", "secret")
			_, err := Load()
			if (err != nil) != test.wantErr {
				t.Fatalf("Load() error = %v, want error %v", err, test.wantErr)
			}
		})
	}
}

func TestHTMLWorkerLimitsAreValidated(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("FEEDMIND_HTML_WORKER_TIMEOUT", "invalid")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid timeout to fail")
	}
	setRequiredEnvironment(t)
	t.Setenv("FEEDMIND_HTML_WORKER_MAX_BYTES", "100")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid maximum size to fail")
	}
}
