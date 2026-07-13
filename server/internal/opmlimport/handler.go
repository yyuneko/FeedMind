package opmlimport

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"feedmind/server/internal/auth"
	"feedmind/server/internal/fetchsafe"
	"feedmind/server/internal/logging"
	"feedmind/server/internal/opml"

	"github.com/jackc/pgx/v5/pgxpool"
)

const maxOPMLFeeds = 500

type Handler struct {
	DB             *pgxpool.Pool
	Auth           *auth.Service
	Fetch          *fetchsafe.Client
	AllowedOrigins string
}

type apiError struct {
	Error struct {
		Code      string `json:"code,omitempty"`
		Message   string `json:"message,omitempty"`
		RequestID string `json:"requestID,omitempty"`
	} `json:"error"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.ensureRequestID(w, r)
	h.setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Request-ID")
		w.Header().Set("Access-Control-Allow-Methods", "POST,OPTIONS")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		h.fail(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
		return
	}

	if h.Fetch == nil || h.DB == nil || h.Auth == nil {
		h.fail(w, r, http.StatusInternalServerError, "internal", "OPML import is unavailable")
		return
	}

	user, _, err := h.Auth.ParseAccess(bearer(r))
	if err != nil {
		h.fail(w, r, http.StatusUnauthorized, "unauthorized", "Authentication required", err)
		return
	}

	var input struct {
		URL      string `json:"url"`
		Category string `json:"category"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		h.fail(w, r, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}
	if strings.TrimSpace(input.URL) == "" {
		h.fail(w, r, http.StatusUnprocessableEntity, "validation_failed", "OPML URL is required")
		return
	}
	fetchURL := canonicalOPMLURL(input.URL)
	response, body, err := h.Fetch.Get(r.Context(), fetchURL, map[string]string{
		"Accept": "text/x-opml, application/xml, text/xml;q=0.9, */*;q=0.1",
	})
	if err != nil {
		h.fail(w, r, http.StatusBadGateway, "opml_fetch_failed", "Could not fetch OPML document", err)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		h.fail(w, r, http.StatusBadGateway, "opml_fetch_failed", fmt.Sprintf("OPML URL returned HTTP %d", response.StatusCode))
		return
	}

	feeds, err := opml.Parse(body, maxOPMLFeeds)
	if err != nil {
		h.fail(w, r, http.StatusUnprocessableEntity, "invalid_opml", err.Error(), err)
		return
	}

	imported, failed, err := h.importFeeds(r, user.ID, strings.TrimSpace(input.Category), feeds)
	if err != nil {
		h.fail(w, r, http.StatusInternalServerError, "internal", "Could not import OPML subscriptions", err)
		return
	}
	h.json(w, http.StatusAccepted, map[string]int{
		"total":    len(feeds),
		"imported": imported,
		"failed":   failed,
	})
}

// canonicalOPMLURL avoids the gist.github.com redirect for raw Gist files.
// Some networks resolve that redirecting host incorrectly while the dedicated
// raw-content host remains reachable. Only the exact GitHub host is rewritten.
func canonicalOPMLURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !strings.EqualFold(parsed.Hostname(), "gist.github.com") {
		return raw
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 3 || parts[2] != "raw" {
		return raw
	}
	parsed.Host = "gist.githubusercontent.com"
	return parsed.String()
}

func (h *Handler) importFeeds(r *http.Request, userID, categoryOverride string, feeds []opml.Feed) (int, int, error) {
	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(r.Context())

	imported := 0
	failed := 0
	seen := make(map[string]struct{}, len(feeds))
	for _, item := range feeds {
		normalized, err := normalizeURL(item.URL)
		if err != nil {
			failed++
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}

		title := strings.TrimSpace(item.Title)
		category := categoryOverride
		if category == "" {
			category = strings.TrimSpace(item.Category)
		}

		var feedID string
		err = tx.QueryRow(r.Context(), `INSERT INTO feeds(url,normalized_url,title) VALUES($1,$2,$3)
			ON CONFLICT(normalized_url) DO UPDATE SET title=CASE WHEN feeds.title='' THEN EXCLUDED.title ELSE feeds.title END
			RETURNING id`, strings.TrimSpace(item.URL), normalized, title).Scan(&feedID)
		if err != nil {
			return 0, 0, err
		}

		_, err = tx.Exec(r.Context(), `INSERT INTO user_feed_subscriptions(user_id,feed_id,custom_name,category)
			VALUES($1,$2,NULLIF($3,''),$4)
			ON CONFLICT(user_id,feed_id) DO UPDATE SET
				enabled=true,
				custom_name=COALESCE(user_feed_subscriptions.custom_name,EXCLUDED.custom_name),
				category=CASE WHEN user_feed_subscriptions.category='' THEN EXCLUDED.category ELSE user_feed_subscriptions.category END,
				updated_at=now()`, userID, feedID, title, category)
		if err != nil {
			return 0, 0, err
		}

		_, err = tx.Exec(r.Context(), `INSERT INTO jobs(type,idempotency_key,payload)
			VALUES('fetch_feed',$1,jsonb_build_object('feedId',$1::text)) ON CONFLICT DO NOTHING`, feedID)
		if err != nil {
			return 0, 0, err
		}
		imported++
	}

	if err := tx.Commit(r.Context()); err != nil {
		return 0, 0, err
	}
	return imported, failed, nil
}

func normalizeURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", errors.New("invalid feed URL")
	}
	parsed.Fragment = ""
	parsed.Host = strings.ToLower(parsed.Host)
	return parsed.String(), nil
}

func bearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if token := strings.TrimPrefix(header, "Bearer "); token != header {
		return token
	}
	if cookie, err := r.Cookie("feedmind_access"); err == nil {
		return cookie.Value
	}
	return ""
}

func (h *Handler) ensureRequestID(w http.ResponseWriter, r *http.Request) {
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = strconv.FormatInt(time.Now().UnixNano(), 36)
		r.Header.Set("X-Request-ID", requestID)
	}
	w.Header().Set("X-Request-ID", requestID)
}

func (h *Handler) setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" && strings.Contains(","+h.AllowedOrigins+",", ","+origin+",") {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Vary", "Origin")
	}
}

func (h *Handler) json(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (h *Handler) fail(w http.ResponseWriter, r *http.Request, status int, code, message string, causes ...error) {
	logging.APIError(r, status, code, causes...)
	requestID := r.Header.Get("X-Request-ID")
	response := apiError{}
	response.Error.Code = code
	response.Error.Message = message
	response.Error.RequestID = requestID
	h.json(w, status, response)
}
