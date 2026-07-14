package htmlfetch

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type directFunc func(context.Context, string, map[string]string) (*http.Response, []byte, error)

func (f directFunc) Get(ctx context.Context, rawURL string, headers map[string]string) (*http.Response, []byte, error) {
	return f(ctx, rawURL, headers)
}

func directResponse(status int, body string) directFunc {
	return func(_ context.Context, rawURL string, _ map[string]string) (*http.Response, []byte, error) {
		parsed, _ := url.Parse(rawURL)
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": []string{"text/html"}},
			Request:    &http.Request{URL: parsed},
		}, []byte(body), nil
	}
}

func TestDirectSuccessAnd404DoNotUseWorker(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusNotFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			called := false
			server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
			defer server.Close()
			client := New(directResponse(status, "direct"), server.URL, "secret", time.Second, 1024)
			result, err := client.Get(context.Background(), "https://source.example/article")
			if err != nil {
				t.Fatal(err)
			}
			if result.StatusCode != status || string(result.Body) != "direct" || called {
				t.Fatalf("unexpected result: %#v, worker called: %v", result, called)
			}
		})
	}
}

func TestFallbackStatusesUseWorkerAndSendBearerToken(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer secret-token" {
					t.Fatalf("unexpected Worker request method or authorization")
				}
				w.Header().Set("Content-Type", "text/html")
				w.Header().Set("X-FeedMind-Final-URL", "https://final.example/article")
				w.Header().Set("X-FeedMind-Upstream-Status", "200")
				_, _ = io.WriteString(w, "worker")
			}))
			defer server.Close()
			client := New(directResponse(status, "direct"), server.URL, "secret-token", time.Second, 1024)
			result, err := client.Get(context.Background(), "https://source.example/article")
			if err != nil {
				t.Fatal(err)
			}
			if result.StatusCode != http.StatusOK || result.FinalURL.String() != "https://final.example/article" || string(result.Body) != "worker" {
				t.Fatalf("unexpected Worker result: %#v", result)
			}
		})
	}
}

func TestWorkerReceivesFeedMindRequestID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-FeedMind-Request-ID"); got != "djygna6hr8ch" {
			t.Fatalf("unexpected request ID %q", got)
		}
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("X-FeedMind-Final-URL", "https://final.example/article")
		w.Header().Set("X-FeedMind-Upstream-Status", "200")
		_, _ = io.WriteString(w, "worker")
	}))
	defer server.Close()
	client := New(directResponse(http.StatusForbidden, "blocked"), server.URL, "secret", time.Second, 1024)
	ctx := WithRequestID(context.Background(), "djygna6hr8ch")
	if _, err := client.Get(ctx, "https://source.example/article"); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidRequestIDIsNotForwarded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-FeedMind-Request-ID"); got != "" {
			t.Fatalf("invalid request ID was forwarded: %q", got)
		}
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("X-FeedMind-Final-URL", "https://final.example/article")
		w.Header().Set("X-FeedMind-Upstream-Status", "200")
		_, _ = io.WriteString(w, "worker")
	}))
	defer server.Close()
	client := New(directResponse(http.StatusForbidden, "blocked"), server.URL, "secret", time.Second, 1024)
	ctx := WithRequestID(context.Background(), "invalid request id")
	if _, err := client.Get(ctx, "https://source.example/article"); err != nil {
		t.Fatal(err)
	}
}

func TestNetworkFailureUsesWorker(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/xhtml+xml")
		w.Header().Set("X-FeedMind-Final-URL", "https://final.example/article")
		w.Header().Set("X-FeedMind-Upstream-Status", "200")
		_, _ = io.WriteString(w, "<html/>")
	}))
	defer server.Close()
	direct := directFunc(func(context.Context, string, map[string]string) (*http.Response, []byte, error) {
		return nil, nil, errors.New("network unavailable")
	})
	result, err := New(direct, server.URL, "secret", time.Second, 1024).Get(context.Background(), "https://source.example/article")
	if err != nil || string(result.Body) != "<html/>" {
		t.Fatalf("unexpected result %#v, error %v", result, err)
	}
}

func TestFeedFallbackUsesWorkerAndPreservesValidators(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			URL  string `json:"url"`
			Kind string `json:"kind"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		if input.Kind != "feed" || input.URL != "https://source.example/feed.xml" {
			t.Fatalf("unexpected Worker input: %#v", input)
		}
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Header().Set("X-FeedMind-Final-URL", "https://final.example/feed.xml")
		w.Header().Set("X-FeedMind-Upstream-Status", "200")
		w.Header().Set("X-FeedMind-Upstream-ETag", `"feed-v2"`)
		w.Header().Set("X-FeedMind-Upstream-Last-Modified", "Wed, 15 Jul 2026 00:00:00 GMT")
		_, _ = io.WriteString(w, `<rss version="2.0"></rss>`)
	}))
	defer server.Close()
	direct := directFunc(func(_ context.Context, _ string, headers map[string]string) (*http.Response, []byte, error) {
		if headers["If-None-Match"] != `"feed-v1"` || headers["If-Modified-Since"] == "" {
			t.Fatalf("conditional feed headers were not sent directly: %#v", headers)
		}
		return nil, nil, errors.New("network unavailable")
	})
	client := New(direct, server.URL, "secret", time.Second, 1024)
	result, err := client.GetFeed(context.Background(), "https://source.example/feed.xml", map[string]string{
		"If-None-Match":     `"feed-v1"`,
		"If-Modified-Since": "Tue, 14 Jul 2026 00:00:00 GMT",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ContentType != "application/rss+xml" || result.ETag != `"feed-v2"` ||
		result.LastModified != "Wed, 15 Jul 2026 00:00:00 GMT" ||
		string(result.Body) != `<rss version="2.0"></rss>` {
		t.Fatalf("unexpected feed Worker result: %#v", result)
	}
}

func TestWorkerErrorIsTypedAndDoesNotExposeToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"code":"authentication_failed","message":"Bearer token is invalid or missing"}}`)
	}))
	defer server.Close()
	client := New(directResponse(http.StatusForbidden, "blocked"), server.URL, "very-secret-token", time.Second, 1024)
	_, err := client.Get(context.Background(), "https://source.example/article")
	var workerErr *WorkerError
	if !errors.As(err, &workerErr) || workerErr.Code != "authentication_failed" {
		t.Fatalf("expected typed Worker error, got %v", err)
	}
	if !IsWorkerFallbackFailure(err) {
		t.Fatalf("expected Worker fallback failure, got %v", err)
	}
	if strings.Contains(err.Error(), "very-secret-token") {
		t.Fatal("error exposed Worker token")
	}
}

func TestWorkerResponseSizeLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("X-FeedMind-Final-URL", "https://final.example/article")
		w.Header().Set("X-FeedMind-Upstream-Status", "200")
		_, _ = io.WriteString(w, strings.Repeat("x", 1025))
	}))
	defer server.Close()
	client := New(directResponse(http.StatusForbidden, "blocked"), server.URL, "secret", time.Second, 1024)
	_, err := client.Get(context.Background(), "https://source.example/article")
	if err == nil || !strings.Contains(err.Error(), "size limit") {
		t.Fatalf("expected response size error, got %v", err)
	}
}

func TestWorkerRequestTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("X-FeedMind-Final-URL", "https://final.example/article")
		w.Header().Set("X-FeedMind-Upstream-Status", "200")
	}))
	defer server.Close()
	client := New(directResponse(http.StatusForbidden, "blocked"), server.URL, "secret", 10*time.Millisecond, 1024)
	_, err := client.Get(context.Background(), "https://source.example/article")
	if err == nil || !strings.Contains(err.Error(), "Client.Timeout") {
		t.Fatalf("expected timeout, got %v", err)
	}
}
