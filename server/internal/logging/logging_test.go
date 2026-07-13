package logging

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func discardLogs(t *testing.T) {
	t.Helper()
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
}

func TestAccessPreservesResponse(t *testing.T) {
	discardLogs(t)
	handler := Access(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("created"))
	}))
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", nil)
	request.Header.Set("X-Request-ID", "request-1")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated || response.Body.String() != "created" {
		t.Fatalf("response = (%d, %q), want (201, %q)", response.Code, response.Body.String(), "created")
	}
}

func TestRecoverReturnsStructuredInternalError(t *testing.T) {
	discardLogs(t)
	handler := Access(Recover(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})))
	request := httptest.NewRequest(http.MethodGet, "/api/v1/articles", nil)
	request.Header.Set("X-Request-ID", "request-2")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
	body := response.Body.String()
	for _, expected := range []string{"internal", "request-2"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("response body %q does not contain %q", body, expected)
		}
	}
}

func TestRemoteIP(t *testing.T) {
	if got := remoteIP("192.0.2.1:8080"); got != "192.0.2.1" {
		t.Fatalf("remoteIP() = %q, want 192.0.2.1", got)
	}
}
