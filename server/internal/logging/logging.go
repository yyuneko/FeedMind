package logging

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"time"
)

func Configure(rawLevel string) error {
	levelName := strings.TrimSpace(strings.ToLower(rawLevel))
	if levelName == "" {
		levelName = "info"
	}
	var level slog.Level
	err := level.UnmarshalText([]byte(levelName))
	if err != nil {
		level = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})))
	if err != nil {
		return fmt.Errorf("invalid FEEDMIND_LOG_LEVEL %q: %w", rawLevel, err)
	}
	return nil
}

type responseWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *responseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(body)
	w.bytes += n
	return n, err
}

func Access(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &responseWriter{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		if recorder.status == 0 {
			recorder.status = http.StatusOK
		}
		level := slog.LevelInfo
		if r.URL.Path == "/healthz" && recorder.status < http.StatusBadRequest {
			level = slog.LevelDebug
		}
		slog.LogAttrs(r.Context(), level, "http request",
			slog.String("request_id", r.Header.Get("X-Request-ID")),
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", recorder.status),
			slog.Int64("duration_ms", time.Since(started).Milliseconds()),
			slog.Int("response_bytes", recorder.bytes),
			slog.String("remote_ip", remoteIP(r.RemoteAddr)),
		)
	})
}

func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.ErrorContext(r.Context(), "http panic",
					"request_id", r.Header.Get("X-Request-ID"),
					"method", r.Method,
					"path", r.URL.Path,
					"panic", fmt.Sprint(recovered),
					"stack", string(debug.Stack()),
				)
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{
					"code":      "internal",
					"message":   "Request failed",
					"requestId": r.Header.Get("X-Request-ID"),
				}})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func APIError(r *http.Request, status int, code string, causes ...error) {
	attrs := []slog.Attr{
		slog.String("request_id", r.Header.Get("X-Request-ID")),
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
		slog.Int("status", status),
		slog.String("error_code", code),
		slog.String("remote_ip", remoteIP(r.RemoteAddr)),
	}
	cause := errors.Join(causes...)
	if cause != nil {
		attrs = append(attrs, slog.String("error", cause.Error()))
	}
	level := slog.LevelWarn
	if status >= http.StatusInternalServerError {
		level = slog.LevelError
	}
	slog.LogAttrs(r.Context(), level, "api request failed", attrs...)
}

func remoteIP(address string) string {
	host, _, err := net.SplitHostPort(address)
	if err == nil {
		return host
	}
	return address
}
