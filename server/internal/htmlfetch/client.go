package htmlfetch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type DirectClient interface {
	Get(context.Context, string, map[string]string) (*http.Response, []byte, error)
}

type Result struct {
	StatusCode   int
	FinalURL     *url.URL
	ContentType  string
	ETag         string
	LastModified string
	Body         []byte
}

type Client struct {
	direct    DirectClient
	workerURL string
	token     string
	http      *http.Client
	maxBytes  int64
}

type requestIDContextKey struct{}

func WithRequestID(ctx context.Context, requestID string) context.Context {
	requestID = strings.TrimSpace(requestID)
	if !validRequestID(requestID) {
		return ctx
	}
	return context.WithValue(ctx, requestIDContextKey{}, requestID)
}

func requestIDFromContext(ctx context.Context) string {
	requestID, _ := ctx.Value(requestIDContextKey{}).(string)
	return requestID
}

func validRequestID(requestID string) bool {
	if requestID == "" || len(requestID) > 128 {
		return false
	}
	for _, character := range requestID {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			strings.ContainsRune("._:-", character) {
			continue
		}
		return false
	}
	return true
}

type WorkerError struct {
	HTTPStatus     int
	Code           string
	Message        string
	UpstreamStatus int
}

type WorkerFallbackError struct {
	Direct error
	Worker error
}

func (e *WorkerFallbackError) Error() string {
	return errors.Join(e.Direct, e.Worker).Error()
}

func (e *WorkerFallbackError) Unwrap() []error {
	return []error{e.Direct, e.Worker}
}

func IsWorkerFallbackFailure(err error) bool {
	var fallbackErr *WorkerFallbackError
	return errors.As(err, &fallbackErr)
}

func (e *WorkerError) Error() string {
	if e.UpstreamStatus != 0 {
		return fmt.Sprintf("HTML worker %s: %s (upstream HTTP %d)", e.Code, e.Message, e.UpstreamStatus)
	}
	return fmt.Sprintf("HTML worker %s: %s", e.Code, e.Message)
}

func New(direct DirectClient, workerURL, token string, timeout time.Duration, maxBytes int64) *Client {
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return &Client{direct: direct, workerURL: strings.TrimSpace(workerURL), token: token, http: client, maxBytes: maxBytes}
}

func (c *Client) Get(ctx context.Context, rawURL string) (*Result, error) {
	return c.get(ctx, rawURL, "html", map[string]string{
		"Accept": "text/html,application/xhtml+xml;q=0.9",
	})
}

func (c *Client) GetFeed(ctx context.Context, rawURL string, headers map[string]string) (*Result, error) {
	requestHeaders := make(map[string]string, len(headers)+1)
	for key, value := range headers {
		requestHeaders[key] = value
	}
	requestHeaders["Accept"] = "application/rss+xml, application/atom+xml, application/rdf+xml, application/feed+json, application/xml, text/xml;q=0.9, */*;q=0.1"
	return c.get(ctx, rawURL, "feed", requestHeaders)
}

func (c *Client) get(ctx context.Context, rawURL, kind string, headers map[string]string) (*Result, error) {
	response, body, directErr := c.direct.Get(ctx, rawURL, headers)
	var directResult *Result
	if response != nil {
		finalURL, err := url.Parse(rawURL)
		if response.Request != nil && response.Request.URL != nil {
			finalURL = response.Request.URL
		}
		if err == nil {
			directResult = &Result{
				StatusCode:   response.StatusCode,
				FinalURL:     finalURL,
				ContentType:  response.Header.Get("Content-Type"),
				ETag:         response.Header.Get("ETag"),
				LastModified: response.Header.Get("Last-Modified"),
				Body:         body,
			}
		}
	}

	if c.workerURL == "" || !shouldFallback(response, directErr) {
		if directErr != nil {
			return nil, directErr
		}
		if directResult == nil {
			return nil, fmt.Errorf("direct %s fetch returned no response", kind)
		}
		return directResult, nil
	}

	targetHost := ""
	if parsed, parseErr := url.Parse(rawURL); parseErr == nil {
		targetHost = strings.ToLower(parsed.Hostname())
	}
	directStatus := 0
	if response != nil {
		directStatus = response.StatusCode
	}
	slog.InfoContext(ctx, "routing content fetch through HTML worker",
		"request_id", requestIDFromContext(ctx),
		"kind", kind,
		"target_host", targetHost,
		"direct_status", directStatus,
		"direct_network_error", directErr != nil,
	)
	workerResult, workerErr := c.getFromWorker(ctx, rawURL, kind)
	if workerErr == nil {
		slog.InfoContext(ctx, "HTML worker fetch completed",
			"request_id", requestIDFromContext(ctx),
			"kind", kind,
			"target_host", targetHost,
			"upstream_status", workerResult.StatusCode,
		)
		return workerResult, nil
	}
	workerCode := ""
	var typedWorkerError *WorkerError
	if errors.As(workerErr, &typedWorkerError) {
		workerCode = typedWorkerError.Code
	}
	slog.WarnContext(ctx, "HTML worker fetch failed",
		"request_id", requestIDFromContext(ctx),
		"kind", kind,
		"target_host", targetHost,
		"worker_error_code", workerCode,
	)
	if directErr != nil {
		return nil, &WorkerFallbackError{
			Direct: fmt.Errorf("direct %s fetch failed: %w", kind, directErr),
			Worker: workerErr,
		}
	}
	return nil, &WorkerFallbackError{
		Direct: fmt.Errorf("direct %s fetch returned HTTP %d", kind, response.StatusCode),
		Worker: workerErr,
	}
}

func shouldFallback(response *http.Response, err error) bool {
	if err != nil || response == nil {
		return true
	}
	return response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError
}

func (c *Client) getFromWorker(ctx context.Context, rawURL, kind string) (*Result, error) {
	payload, err := json.Marshal(map[string]string{"url": rawURL, "kind": kind})
	if err != nil {
		return nil, fmt.Errorf("encode HTML worker request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.workerURL, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("create HTML worker request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/html,application/xhtml+xml,application/json")
	if requestID := requestIDFromContext(ctx); requestID != "" {
		request.Header.Set("X-FeedMind-Request-ID", requestID)
	}

	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call HTML worker: %w", err)
	}
	defer response.Body.Close()

	mediaType, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaErr == nil && acceptedMediaType(kind, mediaType) {
		body, readErr := readLimited(response.Body, c.maxBytes)
		if readErr != nil {
			return nil, fmt.Errorf("read HTML worker response: %w", readErr)
		}
		finalURL, parseErr := url.Parse(response.Header.Get("X-FeedMind-Final-URL"))
		if parseErr != nil || finalURL.Scheme == "" || finalURL.Hostname() == "" {
			return nil, errors.New("HTML worker returned an invalid final URL")
		}
		upstreamStatus, statusErr := strconv.Atoi(response.Header.Get("X-FeedMind-Upstream-Status"))
		if statusErr != nil || upstreamStatus != response.StatusCode {
			return nil, errors.New("HTML worker returned inconsistent upstream status metadata")
		}
		return &Result{
			StatusCode:   upstreamStatus,
			FinalURL:     finalURL,
			ContentType:  response.Header.Get("Content-Type"),
			ETag:         response.Header.Get("X-FeedMind-Upstream-ETag"),
			LastModified: response.Header.Get("X-FeedMind-Upstream-Last-Modified"),
			Body:         body,
		}, nil
	}

	if mediaErr == nil && mediaType == "application/json" {
		body, readErr := readLimited(response.Body, 64<<10)
		if readErr != nil {
			return nil, fmt.Errorf("read HTML worker error: %w", readErr)
		}
		var envelope struct {
			Error struct {
				Code           string `json:"code"`
				Message        string `json:"message"`
				UpstreamStatus int    `json:"upstreamStatus"`
			} `json:"error"`
		}
		if err = json.Unmarshal(body, &envelope); err != nil || envelope.Error.Code == "" || envelope.Error.Message == "" {
			return nil, fmt.Errorf("HTML worker returned malformed error (HTTP %d)", response.StatusCode)
		}
		return nil, &WorkerError{HTTPStatus: response.StatusCode, Code: envelope.Error.Code, Message: envelope.Error.Message, UpstreamStatus: envelope.Error.UpstreamStatus}
	}

	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	return nil, fmt.Errorf("HTML worker returned unexpected Content-Type %q (HTTP %d)", response.Header.Get("Content-Type"), response.StatusCode)
}

func acceptedMediaType(kind, mediaType string) bool {
	if kind == "html" {
		return mediaType == "text/html" || mediaType == "application/xhtml+xml"
	}
	switch mediaType {
	case "application/rss+xml", "application/atom+xml", "application/rdf+xml", "application/feed+json", "application/xml", "text/xml":
		return true
	default:
		return false
	}
}

func readLimited(reader io.Reader, maximum int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maximum {
		return nil, errors.New("response exceeds configured size limit")
	}
	return body, nil
}
