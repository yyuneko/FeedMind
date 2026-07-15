package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"feedmind/server/internal/auth"
	"feedmind/server/internal/config"
	"feedmind/server/internal/fetchsafe"
	"feedmind/server/internal/logging"
	"feedmind/server/internal/mailer"
	"feedmind/server/internal/opmlimport"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Server struct {
	DB     *pgxpool.Pool
	Auth   *auth.Service
	Config config.Config
	Mailer *mailer.Sender
	Fetch  *fetchsafe.Client
}
type ctxKey int

const userKey ctxKey = 1
const highestJobPriority = 1<<31 - 1

type apiError struct {
	Error struct {
		Code      string            `json:"code,omitempty"`
		Message   string            `json:"message,omitempty"`
		RequestID string            `json:"requestId,omitempty"`
		Fields    map[string]string `json:"fields,omitempty"`
	} `json:"error"`
}

func jsonOut(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, r *http.Request, status int, code, msg string, causes ...error) {
	logging.APIError(r, status, code, causes...)
	x := apiError{}
	x.Error.Code = code
	x.Error.Message = msg
	x.Error.RequestID = r.Header.Get("X-Request-ID")
	jsonOut(w, status, x)
}
func decode(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	return d.Decode(v)
}
func userOf(r *http.Request) auth.User { return r.Context().Value(userKey).(auth.User) }
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(s.requestID, logging.Access, logging.Recover, s.cors)
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) { jsonOut(w, 200, map[string]any{"ok": true}) })
	r.Route("/api/v1", func(r chi.Router) {
		r.Post("/opml/import", (&opmlimport.Handler{DB: s.DB, Auth: s.Auth, Fetch: s.Fetch, AllowedOrigins: s.Config.AllowedOrigins}).ServeHTTP)
		r.Post("/auth/register", s.register)
		r.Post("/auth/login", s.login)
		r.Post("/auth/refresh", s.refresh)
		r.Post("/auth/verify-email", s.verifyEmail)
		r.Post("/auth/resend-verification", s.resendVerification)
		r.Post("/auth/forgot-password", s.forgotPassword)
		r.Post("/auth/reset-password", s.resetPassword)
		r.Group(func(r chi.Router) {
			r.Use(s.requireAuth)
			r.Get("/me", s.me)
			r.Post("/auth/logout", s.logout)
			r.Post("/auth/logout-all", s.logoutAll)
			r.Get("/preferences", s.getPreferences)
			r.Patch("/preferences", s.patchPreferences)
			r.Get("/subscriptions", s.listSubscriptions)
			r.Post("/subscriptions", s.addSubscription)
			r.Get("/subscriptions/{id}", s.getSubscription)
			r.Patch("/subscriptions/{id}", s.patchSubscription)
			r.Delete("/subscriptions/{id}", s.deleteSubscription)
			r.Post("/subscriptions/{id}/refresh", s.refreshSubscription)
			r.Post("/subscriptions/{id}/refresh-title", s.refreshSubscriptionTitle)
			r.Get("/articles", s.listArticles)
			r.Post("/articles", s.addArticle)
			r.Get("/articles/{id}", s.getArticle)
			r.Post("/articles/{id}/reparse", s.reparseArticle)
			r.Put("/articles/{id}/state", s.putArticleState)
			r.Get("/prompts", s.listPrompts)
			r.Post("/prompts", s.createPrompt)
			r.Patch("/prompts/{id}", s.patchPrompt)
			r.Delete("/prompts/{id}", s.deletePrompt)
			r.Put("/prompts/{id}/default", s.defaultPrompt)
			r.Post("/migrations", s.migrateData)
			r.Get("/migrations", s.listMigrations)
		})
	})
	if webDir := strings.TrimSpace(os.Getenv("FEEDMIND_WEB_DIR")); webDir != "" {
		r.NotFound(webApp(webDir))
	}
	return r
}

func webApp(root string) http.HandlerFunc {
	files := http.FileServer(http.Dir(root))
	return func(w http.ResponseWriter, r *http.Request) {
		if (r.Method != http.MethodGet && r.Method != http.MethodHead) || r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/healthz" {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		if filepath.Ext(path) != "" {
			http.NotFound(w, r)
			return
		}
		index := filepath.Join(root, "index.html")
		if _, err := os.Stat(index); err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, index)
	}
}
func (s *Server) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			id = strconv.FormatInt(time.Now().UnixNano(), 36)
		}
		w.Header().Set("X-Request-ID", id)
		r.Header.Set("X-Request-ID", id)
		next.ServeHTTP(w, r)
	})
}
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && strings.Contains(","+s.Config.AllowedOrigins+",", ","+origin+",") {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-CSRF-Token,X-Request-ID,If-Match")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func bearer(r *http.Request) string {
	if x := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "); x != r.Header.Get("Authorization") {
		return x
	}
	if c, e := r.Cookie("feedmind_access"); e == nil {
		return c.Value
	}
	return ""
}
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, _, e := s.Auth.ParseAccess(bearer(r))
		if e != nil {
			fail(w, r, 401, "unauthorized", "Authentication required")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, u)))
	})
}
func (s *Server) setCookies(w http.ResponseWriter, t auth.Tokens) {
	http.SetCookie(w, &http.Cookie{Name: "feedmind_access", Value: t.AccessToken, Path: "/", HttpOnly: true, Secure: s.Config.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: int(t.ExpiresIn)})
	http.SetCookie(w, &http.Cookie{Name: "feedmind_refresh", Value: t.RefreshToken, Path: "/api/v1/auth", HttpOnly: true, Secure: s.Config.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: int(s.Config.RefreshTTL.Seconds())})
}
func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var in struct{ Email, Password, DeviceName string }
	if e := decode(r, &in); e != nil {
		fail(w, r, 400, "invalid_request", "Invalid JSON", e)
		return
	}
	email := auth.NormalizeEmail(in.Email)
	hash, e := auth.HashPassword(in.Password)
	if e != nil || !strings.Contains(email, "@") {
		fail(w, r, 422, "validation_failed", "Invalid email or password")
		return
	}
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	defer tx.Rollback(r.Context())
	var u auth.User
	created := true
	e = tx.QueryRow(r.Context(), "INSERT INTO users(email,password_hash) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id,email,false", email, hash).Scan(&u.ID, &u.Email, &u.Verified)
	if e != nil {
		if !errors.Is(e, pgx.ErrNoRows) {
			fail(w, r, 500, "internal", "Request failed", e)
			return
		}
		created = false
		e = tx.QueryRow(r.Context(), `SELECT id,email,false FROM users WHERE lower(email)=lower($1) AND email_verified_at IS NULL AND status='active' FOR UPDATE`, email).Scan(&u.ID, &u.Email, &u.Verified)
		if e != nil {
			if !errors.Is(e, pgx.ErrNoRows) {
				fail(w, r, 500, "internal", "Request failed", e)
				return
			}
			fail(w, r, 409, "email_exists", "Email is already registered")
			return
		}
		if _, e = tx.Exec(r.Context(), "UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2", hash, u.ID); e != nil {
			fail(w, r, 500, "internal", "Request failed", e)
			return
		}
	}
	if created {
		if _, e = tx.Exec(r.Context(), "INSERT INTO user_preferences(user_id) VALUES($1)", u.ID); e != nil {
			fail(w, r, 500, "internal", "Request failed", e)
			return
		}
		if _, e = tx.Exec(r.Context(), "INSERT INTO prompts(user_id,name,content,content_hash,is_default) VALUES($1,'Default Translation','Translate the following article accurately and naturally.','default',true)", u.ID); e != nil {
			fail(w, r, 500, "internal", "Request failed", e)
			return
		}
	}
	token, e := mailer.NewToken()
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if _, e = tx.Exec(r.Context(), `UPDATE email_tokens SET consumed_at=COALESCE(consumed_at,now()) WHERE user_id=$1 AND purpose='verify' AND consumed_at IS NULL`, u.ID); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if _, e = tx.Exec(r.Context(), `INSERT INTO email_tokens(user_id,purpose,token_hash,expires_at) VALUES($1,'verify',$2,$3)`, u.ID, tokenHash(token), time.Now().Add(24*time.Hour)); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if e = s.Mailer.Send(r.Context(), u.Email, "验证您的 FeedMind 邮箱", mailer.VerificationBody(token)); e != nil {
		fail(w, r, http.StatusServiceUnavailable, "email_delivery_failed", "Unable to send verification email; please try again", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	slog.InfoContext(r.Context(), "user registration accepted", "request_id", r.Header.Get("X-Request-ID"), "user_id", u.ID, "retried", !created)
	jsonOut(w, 201, map[string]any{"user": u, "verificationRequired": true})
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct{ Email, Password, DeviceName string }
	if e := decode(r, &in); e != nil {
		fail(w, r, 400, "invalid_request", "Invalid JSON", e)
		return
	}
	var u auth.User
	var hash string
	e := s.DB.QueryRow(r.Context(), "SELECT id,email,email_verified_at IS NOT NULL,password_hash FROM users WHERE lower(email)=lower($1) AND status='active'", auth.NormalizeEmail(in.Email)).Scan(&u.ID, &u.Email, &u.Verified, &hash)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if e != nil || !auth.VerifyPassword(hash, in.Password) {
		fail(w, r, 401, "invalid_credentials", "Invalid email or password")
		return
	}
	if !u.Verified {
		fail(w, r, 403, "email_not_verified", "Email verification required")
		return
	}
	t, e := s.Auth.NewSession(r.Context(), u, in.DeviceName)
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	s.setCookies(w, t)
	slog.InfoContext(r.Context(), "user login succeeded", "request_id", r.Header.Get("X-Request-ID"), "user_id", u.ID)
	jsonOut(w, 200, map[string]any{"user": u, "tokens": t})
}
func refreshRaw(r *http.Request) string {
	var in struct {
		RefreshToken string `json:"refreshToken"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	if in.RefreshToken != "" {
		return in.RefreshToken
	}
	if c, e := r.Cookie("feedmind_refresh"); e == nil {
		return c.Value
	}
	return ""
}
func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	t, e := s.Auth.Rotate(r.Context(), refreshRaw(r))
	if e != nil {
		fail(w, r, 401, "invalid_refresh_token", "Session expired")
		return
	}
	s.setCookies(w, t)
	jsonOut(w, 200, map[string]any{"tokens": t})
}
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, 200, map[string]any{"user": userOf(r)})
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	_, sid, _ := s.Auth.ParseAccess(bearer(r))
	_ = s.Auth.Revoke(r.Context(), sid, false, u.ID)
	s.clearCookies(w)
	w.WriteHeader(204)
}
func (s *Server) logoutAll(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	_ = s.Auth.Revoke(r.Context(), "", true, u.ID)
	s.clearCookies(w)
	w.WriteHeader(204)
}
func (s *Server) clearCookies(w http.ResponseWriter) {
	for _, n := range []string{"feedmind_access", "feedmind_refresh"} {
		http.SetCookie(w, &http.Cookie{Name: n, Value: "", Path: "/", HttpOnly: true, Secure: s.Config.CookieSecure, MaxAge: -1})
	}
}
func tokenHash(raw string) []byte { x := sha256.Sum256([]byte(raw)); return x[:] }
func (s *Server) issueEmailToken(ctx context.Context, userID, purpose string, ttl time.Duration) (string, error) {
	raw, e := mailer.NewToken()
	if e != nil {
		return "", e
	}
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `UPDATE email_tokens SET consumed_at=COALESCE(consumed_at,now()) WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL`, userID, purpose); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO email_tokens(user_id,purpose,token_hash,expires_at) VALUES($1,$2,$3,$4)`, userID, purpose, tokenHash(raw), time.Now().Add(ttl)); e != nil {
		return "", e
	}
	if e = tx.Commit(ctx); e != nil {
		return "", e
	}
	return raw, nil
}
func (s *Server) resendVerification(w http.ResponseWriter, r *http.Request) {
	var in struct{ Email string }
	if decode(r, &in) != nil {
		fail(w, r, 400, "invalid_request", "Invalid JSON")
		return
	}
	email := auth.NormalizeEmail(in.Email)
	var uid string
	e := s.DB.QueryRow(r.Context(), `SELECT id FROM users WHERE lower(email)=lower($1) AND email_verified_at IS NULL AND status='active'`, email).Scan(&uid)
	if e == nil {
		if token, tokenErr := s.issueEmailToken(r.Context(), uid, "verify", 24*time.Hour); tokenErr != nil {
			slog.ErrorContext(r.Context(), "issue email token", "purpose", "verify", "error", tokenErr)
		} else if sendErr := s.Mailer.Send(r.Context(), email, "验证您的 FeedMind 邮箱", mailer.VerificationBody(token)); sendErr != nil {
			slog.ErrorContext(r.Context(), "send email token", "purpose", "verify", "error", sendErr)
		}
	}
	w.WriteHeader(204)
}
func (s *Server) verifyEmail(w http.ResponseWriter, r *http.Request) {
	var in struct{ Token string }
	if decode(r, &in) != nil {
		fail(w, r, 400, "invalid_request", "Invalid JSON")
		return
	}
	tag, e := s.DB.Exec(r.Context(), `WITH t AS (UPDATE email_tokens SET consumed_at=now() WHERE token_hash=$1 AND purpose='verify' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id) UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=(SELECT user_id FROM t)`, tokenHash(in.Token))
	if e != nil || tag.RowsAffected() == 0 {
		fail(w, r, 400, "invalid_token", "Invalid or expired token")
		return
	}
	w.WriteHeader(204)
}
func (s *Server) forgotPassword(w http.ResponseWriter, r *http.Request) {
	var in struct{ Email string }
	_ = decode(r, &in)
	email := auth.NormalizeEmail(in.Email)
	var uid string
	if e := s.DB.QueryRow(r.Context(), `SELECT id FROM users WHERE lower(email)=lower($1) AND status='active'`, email).Scan(&uid); e == nil {
		if token, tokenErr := s.issueEmailToken(r.Context(), uid, "reset", time.Hour); tokenErr != nil {
			slog.ErrorContext(r.Context(), "issue email token", "purpose", "reset", "error", tokenErr)
		} else if sendErr := s.Mailer.Send(r.Context(), email, "重置您的 FeedMind 密码", mailer.ResetBody(token)); sendErr != nil {
			slog.ErrorContext(r.Context(), "send email token", "purpose", "reset", "error", sendErr)
		}
	}
	w.WriteHeader(204)
}
func (s *Server) resetPassword(w http.ResponseWriter, r *http.Request) {
	var in struct{ Token, Password string }
	if decode(r, &in) != nil {
		fail(w, r, 400, "invalid_request", "Invalid JSON")
		return
	}
	hash, e := auth.HashPassword(in.Password)
	if e != nil {
		fail(w, r, 422, "validation_failed", e.Error())
		return
	}
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	defer tx.Rollback(r.Context())
	var uid string
	e = tx.QueryRow(r.Context(), `UPDATE email_tokens SET consumed_at=now() WHERE token_hash=$1 AND purpose='reset' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id`, tokenHash(in.Token)).Scan(&uid)
	if e != nil {
		fail(w, r, 400, "invalid_token", "Invalid or expired token")
		return
	}
	if _, e = tx.Exec(r.Context(), "UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2", hash, uid); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if _, e = tx.Exec(r.Context(), "UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1", uid); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	w.WriteHeader(204)
}
func scanRows(rows pgx.Rows) ([]map[string]any, error) {
	fields := rows.FieldDescriptions()
	out := []map[string]any{}
	for rows.Next() {
		vals, e := rows.Values()
		if e != nil {
			return nil, e
		}
		m := map[string]any{}
		for i, v := range vals {
			name := string(fields[i].Name)
			if name == "thumbnailurl" {
				name = "thumbnailUrl"
			}
			m[name] = normalizeDatabaseValue(fields[i].DataTypeOID, v)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

const postgresUUIDOID uint32 = 2950

// pgx returns UUID columns from Rows.Values as 16-byte arrays. Normalize them
// before JSON encoding so API clients always receive string IDs.
func normalizeDatabaseValue(dataTypeOID uint32, value any) any {
	if dataTypeOID != postgresUUIDOID || value == nil {
		return value
	}

	var bytes [16]byte
	switch value := value.(type) {
	case [16]byte:
		bytes = value
	case []byte:
		if len(value) != len(bytes) {
			return value
		}
		copy(bytes[:], value)
	case string:
		return value
	default:
		return value
	}

	return fmt.Sprintf(`%08x-%04x-%04x-%04x-%012x`,
		bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}
func (s *Server) queryList(w http.ResponseWriter, r *http.Request, q string, args ...any) {
	rows, e := s.DB.Query(r.Context(), q, args...)
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	defer rows.Close()
	items, e := scanRows(rows)
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	jsonOut(w, 200, map[string]any{"items": items})
}
func pagination(r *http.Request) (int, int) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}
func (s *Server) queryPage(w http.ResponseWriter, r *http.Request, q string, page, pageSize int, args ...any) {
	q = strings.Replace(q, `SELECT `, `SELECT count(*) OVER() AS "__total",`, 1)
	rows, e := s.DB.Query(r.Context(), q, args...)
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	defer rows.Close()
	items, e := scanRows(rows)
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	total, hasMore := pageMetadata(items, pageSize)
	if hasMore {
		items = items[:pageSize]
	}
	jsonOut(w, 200, map[string]any{"items": items, "page": page, "pageSize": pageSize, "hasMore": hasMore, "total": total})
}

func pageMetadata(items []map[string]any, pageSize int) (int64, bool) {
	total := int64(0)
	if len(items) > 0 {
		if value, ok := items[0]["__total"].(int64); ok {
			total = value
		}
	}
	for _, item := range items {
		delete(item, "__total")
	}
	return total, len(items) > pageSize
}
func (s *Server) getPreferences(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	s.queryList(w, r, "SELECT language_mode AS \"languageMode\",theme_mode AS \"themeMode\",font_size AS \"fontSize\",line_height AS \"lineHeightRatio\",version,updated_at AS \"updatedAt\" FROM user_preferences WHERE user_id=$1", u.ID)
}
func (s *Server) patchPreferences(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var in struct {
		LanguageMode, ThemeMode string
		FontSize                int
		LineHeightRatio         float64
		Version                 int64
	}
	if decode(r, &in) != nil {
		fail(w, r, 400, "invalid_request", "Invalid JSON")
		return
	}
	tag, e := s.DB.Exec(r.Context(), `UPDATE user_preferences SET language_mode=$1,theme_mode=$2,font_size=$3,line_height=$4,version=version+1,updated_at=now() WHERE user_id=$5 AND version=$6`, in.LanguageMode, in.ThemeMode, in.FontSize, in.LineHeightRatio, u.ID, in.Version)
	if e != nil {
		fail(w, r, 422, "validation_failed", "Invalid preferences")
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, r, 409, "version_conflict", "Preferences changed on another device")
		return
	}
	s.getPreferences(w, r)
}
func normalizeURL(raw string) (string, error) {
	u, e := url.Parse(strings.TrimSpace(raw))
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("invalid URL")
	}
	u.Fragment = ""
	u.Host = strings.ToLower(u.Host)
	return u.String(), nil
}
func (s *Server) listSubscriptions(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	page, pageSize := pagination(r)
	query := strings.TrimSpace(r.URL.Query().Get("query"))
	s.queryPage(w, r, `SELECT us.id,f.id AS "feedId",COALESCE(us.custom_name,f.title) title,f.url,f.site_url AS "siteUrl",us.category,us.sort_order AS "sortOrder",us.enabled,f.fetch_status AS "fetchStatus",(SELECT count(*) FROM articles a WHERE a.feed_id=f.id) AS "articleCount",us.created_at AS "createdAt",us.updated_at AS "updatedAt" FROM user_feed_subscriptions us JOIN feeds f ON f.id=us.feed_id WHERE us.user_id=$1 AND (NULLIF($2,'') IS NULL OR COALESCE(us.custom_name,f.title) ILIKE '%'||$2||'%' OR f.url ILIKE '%'||$2||'%' OR us.category ILIKE '%'||$2||'%') ORDER BY us.sort_order,lower(COALESCE(us.custom_name,f.title)),us.id LIMIT $3 OFFSET $4`, page, pageSize, u.ID, query, pageSize+1, (page-1)*pageSize)
}
func (s *Server) getSubscription(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	s.queryList(w, r, `SELECT us.id,f.id AS "feedId",COALESCE(us.custom_name,f.title) title,f.url,f.site_url AS "siteUrl",us.category,us.sort_order AS "sortOrder",us.enabled,f.fetch_status AS "fetchStatus",(SELECT count(*) FROM articles a WHERE a.feed_id=f.id) AS "articleCount",us.created_at AS "createdAt",us.updated_at AS "updatedAt" FROM user_feed_subscriptions us JOIN feeds f ON f.id=us.feed_id WHERE us.id=$1 AND us.user_id=$2`, chi.URLParam(r, "id"), u.ID)
}
func (s *Server) addSubscription(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var in struct{ URL, Title, Category string }
	if e := decode(r, &in); e != nil {
		fail(w, r, 400, "invalid_request", "Invalid JSON", e)
		return
	}
	normalized, e := normalizeURL(in.URL)
	if e != nil {
		fail(w, r, 422, "validation_failed", "Invalid feed URL")
		return
	}
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	defer tx.Rollback(r.Context())
	var feedID string
	e = tx.QueryRow(r.Context(), `INSERT INTO feeds(url,normalized_url,title) VALUES($1,$2,$3) ON CONFLICT(normalized_url) DO UPDATE SET updated_at=feeds.updated_at RETURNING id`, in.URL, normalized, in.Title).Scan(&feedID)
	if e == nil {
		_, e = tx.Exec(r.Context(), `INSERT INTO user_feed_subscriptions(user_id,feed_id,custom_name,category) VALUES($1,$2,NULLIF($3,''),$4) ON CONFLICT(user_id,feed_id) DO UPDATE SET custom_name=COALESCE(EXCLUDED.custom_name,user_feed_subscriptions.custom_name),category=EXCLUDED.category,enabled=true,updated_at=now()`, u.ID, feedID, in.Title, in.Category)
	}
	if e == nil {
		_, e = tx.Exec(r.Context(), `INSERT INTO jobs(type,idempotency_key,payload) VALUES('fetch_feed',$1,jsonb_build_object('feedId',$1::text,'requestId',$2::text)) ON CONFLICT DO NOTHING`, feedID, r.Header.Get("X-Request-ID"))
	}
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	jsonOut(w, 202, map[string]any{"feedId": feedID, "status": "queued"})
}
func (s *Server) patchSubscription(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var in struct {
		Title, Category string
		SortOrder       int
		Enabled         bool
	}
	if decode(r, &in) != nil {
		fail(w, r, 400, "invalid_request", "Invalid JSON")
		return
	}
	tag, e := s.DB.Exec(r.Context(), `UPDATE user_feed_subscriptions SET custom_name=NULLIF($1,''),category=$2,sort_order=$3,enabled=$4,updated_at=now() WHERE id=$5 AND user_id=$6`, in.Title, in.Category, in.SortOrder, in.Enabled, chi.URLParam(r, "id"), u.ID)
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, r, 404, "not_found", "Subscription not found")
		return
	}
	w.WriteHeader(204)
}
func (s *Server) deleteSubscription(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	if _, e := s.DB.Exec(r.Context(), "DELETE FROM user_feed_subscriptions WHERE id=$1 AND user_id=$2", chi.URLParam(r, "id"), u.ID); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	w.WriteHeader(204)
}
func (s *Server) refreshSubscription(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	defer tx.Rollback(r.Context())
	var feedID string
	e = tx.QueryRow(r.Context(), `SELECT feed_id FROM user_feed_subscriptions WHERE id=$1 AND user_id=$2 FOR UPDATE`, chi.URLParam(r, "id"), u.ID).Scan(&feedID)
	if e != nil {
		if !errors.Is(e, pgx.ErrNoRows) {
			fail(w, r, 500, "internal", "Request failed", e)
			return
		}
		fail(w, r, 404, "not_found", "Subscription not found")
		return
	}
	_, e = tx.Exec(r.Context(), `UPDATE feeds SET fetch_status='pending',last_error=NULL,next_fetch_at=now(),updated_at=now() WHERE id=$1`, feedID)
	if e == nil {
		_, e = tx.Exec(r.Context(), `INSERT INTO jobs(type,idempotency_key,payload) VALUES('fetch_feed',$1,jsonb_build_object('feedId',$1::text,'requestId',$2::text)) ON CONFLICT DO NOTHING`, feedID, r.Header.Get("X-Request-ID"))
	}
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	jsonOut(w, 202, map[string]any{"status": "queued"})
}
func (s *Server) refreshSubscriptionTitle(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	defer tx.Rollback(r.Context())
	var feedID string
	e = tx.QueryRow(r.Context(), `SELECT feed_id FROM user_feed_subscriptions WHERE id=$1 AND user_id=$2 FOR UPDATE`, chi.URLParam(r, "id"), u.ID).Scan(&feedID)
	if e != nil {
		if !errors.Is(e, pgx.ErrNoRows) {
			fail(w, r, 500, "internal", "Request failed", e)
			return
		}
		fail(w, r, 404, "not_found", "Subscription not found")
		return
	}
	_, e = tx.Exec(r.Context(), `UPDATE user_feed_subscriptions SET custom_name=NULL,updated_at=now() WHERE id=$1 AND user_id=$2`, chi.URLParam(r, "id"), u.ID)
	if e == nil {
		_, e = tx.Exec(r.Context(), `UPDATE feeds SET etag=NULL,last_modified=NULL,fetch_status='pending',updated_at=now() WHERE id=$1`, feedID)
	}
	if e == nil {
		_, e = tx.Exec(r.Context(), `INSERT INTO jobs(type,idempotency_key,payload) VALUES('fetch_feed',$1,jsonb_build_object('feedId',$1::text,'requestId',$2::text)) ON CONFLICT DO NOTHING`, feedID, r.Header.Get("X-Request-ID"))
	}
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	jsonOut(w, 202, map[string]any{"status": "queued"})
}
func (s *Server) listArticles(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	starred := r.URL.Query().Get("starred") == "true"
	unread := r.URL.Query().Get("unread") == "true"
	feedID := r.URL.Query().Get("feedId")
	query := strings.TrimSpace(r.URL.Query().Get("query"))
	category := strings.TrimSpace(r.URL.Query().Get("category"))
	page, pageSize := pagination(r)
	s.queryPage(w, r, `SELECT a.id,a.feed_id AS "feedId",COALESCE(us.custom_name,f.title) AS "feedTitle",a.title,a.source_url AS url,a.author,a.published_at AS "publishedAt",a.thumbnail_url AS thumbnailurl,a.content_hash AS "contentHash",a.parser_version AS "parserVersion",COALESCE(st.is_read,false) AS "isRead",COALESCE(st.is_starred,false) AS "isStarred",a.created_at AS "createdAt",a.updated_at AS "updatedAt" FROM articles a JOIN feeds f ON f.id=a.feed_id JOIN user_feed_subscriptions us ON us.feed_id=f.id AND us.user_id=$1 LEFT JOIN user_article_states st ON st.article_id=a.id AND st.user_id=$1 WHERE us.enabled AND (NOT $2 OR COALESCE(st.is_starred,false)) AND (NOT $3 OR NOT COALESCE(st.is_read,false)) AND (NULLIF($4,'') IS NULL OR a.feed_id=NULLIF($4,'')::uuid) AND (NULLIF($5,'') IS NULL OR a.title ILIKE '%'||$5||'%') AND (NULLIF($6,'') IS NULL OR us.category ILIKE '%'||$6||'%') ORDER BY a.published_at DESC NULLS LAST,a.id DESC LIMIT $7 OFFSET $8`, page, pageSize, u.ID, starred, unread, feedID, query, category, pageSize+1, (page-1)*pageSize)
}
func privateFeedURL(userID string) string {
	return "feedmind://selected/" + userID
}

func articleIdentity(normalizedURL string) string {
	sum := sha256.Sum256([]byte(normalizedURL))
	return hex.EncodeToString(sum[:])
}

func (s *Server) addArticle(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var in struct{ URL, Title string }
	if e := decode(r, &in); e != nil {
		fail(w, r, 400, "invalid_request", "Invalid JSON", e)
		return
	}
	normalized, e := normalizeURL(in.URL)
	if e != nil {
		fail(w, r, 422, "validation_failed", "Invalid article URL")
		return
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = normalized
	}
	feedURL := privateFeedURL(u.ID)
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	defer tx.Rollback(r.Context())
	var feedID, articleID string
	e = tx.QueryRow(r.Context(), `INSERT INTO feeds(url,normalized_url,title,fetch_status,next_fetch_at) VALUES($1,$1,'自选','ok','infinity') ON CONFLICT(normalized_url) DO UPDATE SET fetch_status='ok',next_fetch_at='infinity',updated_at=now() RETURNING id`, feedURL).Scan(&feedID)
	if e == nil {
		_, e = tx.Exec(r.Context(), `INSERT INTO user_feed_subscriptions(user_id,feed_id,custom_name,category) VALUES($1,$2,'自选','') ON CONFLICT(user_id,feed_id) DO UPDATE SET custom_name='自选',enabled=true,updated_at=now()`, u.ID, feedID)
	}
	if e == nil {
		e = tx.QueryRow(r.Context(), `INSERT INTO articles(feed_id,source_url,canonical_url,identity_hash,title,published_at,parse_status) VALUES($1,$2,$2,$3,$4,now(),'pending') ON CONFLICT(feed_id,identity_hash) DO UPDATE SET parse_status='pending',parse_error=NULL,updated_at=now() RETURNING id`, feedID, normalized, articleIdentity(normalized), title).Scan(&articleID)
	}
	if e == nil {
		_, e = tx.Exec(r.Context(), `INSERT INTO jobs(type,idempotency_key,payload,priority) VALUES('parse_article',$1,jsonb_build_object('articleId',$1::text,'requestId',$2::text),$3) ON CONFLICT(type,idempotency_key) WHERE status IN ('queued','running') DO UPDATE SET priority=GREATEST(jobs.priority,EXCLUDED.priority),payload=EXCLUDED.payload,run_at=CASE WHEN jobs.status='queued' THEN now() ELSE jobs.run_at END,updated_at=now()`, articleID, r.Header.Get("X-Request-ID"), highestJobPriority)
	}
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	jsonOut(w, 202, map[string]any{"articleId": articleID, "feedId": feedID, "status": "queued"})
}
func (s *Server) getArticle(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	s.queryList(w, r, `SELECT a.id,a.feed_id AS "feedId",us.id AS "feedRecordId",COALESCE(us.custom_name,f.title) AS "feedTitle",us.category AS "feedCategory",f.site_url AS "feedSiteUrl",f.url AS "feedUrl",a.title,a.source_url AS url,a.author,a.published_at AS "publishedAt",a.thumbnail_url AS thumbnailurl,a.content_html AS "contentHtml",a.content_text AS "contentText",a.content_hash AS "contentHash",a.parser_version AS "parserVersion",a.parse_status AS "parseStatus",a.parse_error AS "parseError",COALESCE(st.is_read,false) AS "isRead",COALESCE(st.is_starred,false) AS "isStarred",COALESCE(st.progress,0) progress,COALESCE(st.version,0) version,a.created_at AS "createdAt",a.updated_at AS "updatedAt" FROM articles a JOIN feeds f ON f.id=a.feed_id JOIN user_feed_subscriptions us ON us.feed_id=f.id AND us.user_id=$1 LEFT JOIN user_article_states st ON st.article_id=a.id AND st.user_id=$1 WHERE a.id=$2`, u.ID, chi.URLParam(r, "id"))
}
func (s *Server) reparseArticle(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	articleID := chi.URLParam(r, "id")
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	defer tx.Rollback(r.Context())
	tag, e := tx.Exec(r.Context(), `UPDATE articles SET parse_status='pending',parse_error=NULL,updated_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM user_feed_subscriptions WHERE user_id=$2 AND feed_id=articles.feed_id)`, articleID, u.ID)
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, r, 404, "not_found", "Article not found")
		return
	}
	_, e = tx.Exec(r.Context(), `INSERT INTO jobs(type,idempotency_key,payload,priority) VALUES('parse_article',$1,jsonb_build_object('articleId',$1::text,'requestId',$2::text),$3) ON CONFLICT(type,idempotency_key) WHERE status IN ('queued','running') DO UPDATE SET priority=GREATEST(jobs.priority,EXCLUDED.priority),payload=EXCLUDED.payload,run_at=CASE WHEN jobs.status='queued' THEN now() ELSE jobs.run_at END,updated_at=now()`, articleID, r.Header.Get("X-Request-ID"), highestJobPriority)
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	jsonOut(w, 202, map[string]any{"status": "queued", "priority": "highest"})
}
func (s *Server) putArticleState(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var in struct {
		IsRead, IsStarred bool
		Progress          float64
		OperationID       string
	}
	if decode(r, &in) != nil || in.Progress < 0 || in.Progress > 1 {
		fail(w, r, 422, "validation_failed", "Invalid state")
		return
	}
	tag, e := s.DB.Exec(r.Context(), `INSERT INTO user_article_states(user_id,article_id,is_read,is_starred,progress,last_read_at) SELECT $1,id,$3,$4,$5,CASE WHEN $3 THEN now() END FROM articles WHERE id=$2 AND EXISTS(SELECT 1 FROM user_feed_subscriptions WHERE user_id=$1 AND feed_id=articles.feed_id) ON CONFLICT(user_id,article_id) DO UPDATE SET is_read=$3,is_starred=$4,progress=$5,last_read_at=CASE WHEN $3 THEN now() ELSE user_article_states.last_read_at END,version=user_article_states.version+1,updated_at=now()`, u.ID, chi.URLParam(r, "id"), in.IsRead, in.IsStarred, in.Progress)
	if e != nil || tag.RowsAffected() == 0 {
		fail(w, r, 404, "not_found", "Article not found")
		return
	}
	w.WriteHeader(204)
}
func (s *Server) listPrompts(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	s.queryList(w, r, `SELECT id,name,content,content_version AS "contentVersion",content_hash AS "contentHash",is_default AS "isDefault",created_at AS "createdAt",updated_at AS "updatedAt" FROM prompts WHERE user_id=$1 ORDER BY is_default DESC,updated_at DESC`, u.ID)
}
func contentHash(s string) string { x := sha256.Sum256([]byte(s)); return hex.EncodeToString(x[:]) }
func (s *Server) createPrompt(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var in struct {
		Name, Content, LegacyClientID string
		IsDefault                     bool
	}
	if decode(r, &in) != nil || strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.Content) == "" {
		fail(w, r, 422, "validation_failed", "Name and content are required")
		return
	}
	tx, e := s.DB.Begin(r.Context())
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	defer tx.Rollback(r.Context())
	if in.IsDefault {
		_, e = tx.Exec(r.Context(), "UPDATE prompts SET is_default=false WHERE user_id=$1", u.ID)
	}
	var id string
	if e == nil {
		e = tx.QueryRow(r.Context(), `INSERT INTO prompts(user_id,legacy_client_id,name,content,content_hash,is_default) VALUES($1,NULLIF($2,''),$3,$4,$5,$6) ON CONFLICT(user_id,legacy_client_id) DO UPDATE SET name=EXCLUDED.name,content=EXCLUDED.content,content_hash=EXCLUDED.content_hash,content_version=prompts.content_version+1,is_default=EXCLUDED.is_default,updated_at=now() RETURNING id`, u.ID, in.LegacyClientID, in.Name, in.Content, contentHash(in.Content), in.IsDefault).Scan(&id)
	}
	if e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		fail(w, r, 500, "internal", "Request failed", e)
		return
	}
	jsonOut(w, 201, map[string]any{"id": id})
}
func (s *Server) patchPrompt(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var in struct{ Name, Content string }
	if decode(r, &in) != nil {
		fail(w, r, 400, "invalid_request", "Invalid JSON")
		return
	}
	tag, e := s.DB.Exec(r.Context(), `UPDATE prompts SET name=$1,content=$2,content_hash=$3,content_version=content_version+1,updated_at=now() WHERE id=$4 AND user_id=$5`, in.Name, in.Content, contentHash(in.Content), chi.URLParam(r, "id"), u.ID)
	if e != nil || tag.RowsAffected() == 0 {
		fail(w, r, 404, "not_found", "Prompt not found")
		return
	}
	w.WriteHeader(204)
}
func (s *Server) deletePrompt(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	tx, _ := s.DB.Begin(r.Context())
	defer tx.Rollback(r.Context())
	var was bool
	if e := tx.QueryRow(r.Context(), "DELETE FROM prompts WHERE id=$1 AND user_id=$2 RETURNING is_default", chi.URLParam(r, "id"), u.ID).Scan(&was); e != nil {
		fail(w, r, 404, "not_found", "Prompt not found")
		return
	}
	if was {
		_, _ = tx.Exec(r.Context(), "UPDATE prompts SET is_default=true WHERE id=(SELECT id FROM prompts WHERE user_id=$1 ORDER BY created_at LIMIT 1)", u.ID)
	}
	_ = tx.Commit(r.Context())
	w.WriteHeader(204)
}
func (s *Server) defaultPrompt(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	tx, _ := s.DB.Begin(r.Context())
	defer tx.Rollback(r.Context())
	_, _ = tx.Exec(r.Context(), "UPDATE prompts SET is_default=false WHERE user_id=$1", u.ID)
	tag, e := tx.Exec(r.Context(), "UPDATE prompts SET is_default=true,updated_at=now() WHERE id=$1 AND user_id=$2", chi.URLParam(r, "id"), u.ID)
	if e != nil || tag.RowsAffected() == 0 {
		fail(w, r, 404, "not_found", "Prompt not found")
		return
	}
	_ = tx.Commit(r.Context())
	w.WriteHeader(204)
}
func (s *Server) migrateData(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var in struct {
		DeviceID, BatchKey string
		Version            int
		Feeds              []struct{ URL, Title, Category string }
		Prompts            []struct {
			ID, Name, Content string
			IsDefault         bool
		}
		Preferences *struct {
			LanguageMode, ThemeMode string
			FontSize                int
			LineHeightRatio         float64
		}
	}
	if decode(r, &in) != nil || in.DeviceID == "" || in.BatchKey == "" {
		fail(w, r, 422, "validation_failed", "Invalid migration batch")
		return
	}
	var exists bool
	_ = s.DB.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM data_migrations WHERE user_id=$1 AND device_id=$2 AND version=$3 AND batch_key=$4 AND status='complete')", u.ID, in.DeviceID, in.Version, in.BatchKey).Scan(&exists)
	if exists {
		jsonOut(w, 200, map[string]any{"status": "complete", "duplicate": true})
		return
	}
	for _, f := range in.Feeds {
		body, _ := json.Marshal(map[string]any{"URL": f.URL, "Title": f.Title, "Category": f.Category})
		rr, _ := http.NewRequestWithContext(r.Context(), "POST", "/", strings.NewReader(string(body)))
		rr.Header.Set("X-Request-ID", r.Header.Get("X-Request-ID"))
		rr = rr.WithContext(context.WithValue(rr.Context(), userKey, u))
		s.addSubscription(&discardWriter{}, rr)
	}
	for _, p := range in.Prompts {
		if _, promptErr := s.DB.Exec(r.Context(), `INSERT INTO prompts(user_id,legacy_client_id,name,content,content_hash,is_default) VALUES($1,$2,$3,$4,$5,false) ON CONFLICT(user_id,legacy_client_id) DO NOTHING`, u.ID, p.ID, p.Name, p.Content, contentHash(p.Content)); promptErr != nil {
			slog.ErrorContext(r.Context(), "migration prompt failed", "request_id", r.Header.Get("X-Request-ID"), "user_id", u.ID, "error", promptErr)
		}
	}
	if in.Preferences != nil {
		if _, preferencesErr := s.DB.Exec(r.Context(), `UPDATE user_preferences SET language_mode=$1,theme_mode=$2,font_size=$3,line_height=$4,updated_at=now() WHERE user_id=$5 AND version=1`, in.Preferences.LanguageMode, in.Preferences.ThemeMode, in.Preferences.FontSize, in.Preferences.LineHeightRatio, u.ID); preferencesErr != nil {
			slog.ErrorContext(r.Context(), "migration preferences failed", "request_id", r.Header.Get("X-Request-ID"), "user_id", u.ID, "error", preferencesErr)
		}
	}
	stats := fmt.Sprintf(`{"feeds":%d,"prompts":%d}`, len(in.Feeds), len(in.Prompts))
	_, e := s.DB.Exec(r.Context(), `INSERT INTO data_migrations(user_id,device_id,version,batch_key,status,stats) VALUES($1,$2,$3,$4,'complete',$5) ON CONFLICT(user_id,device_id,version,batch_key) DO UPDATE SET status='complete',stats=$5,updated_at=now()`, u.ID, in.DeviceID, in.Version, in.BatchKey, stats)
	if e != nil {
		fail(w, r, 500, "internal", "Migration failed", e)
		return
	}
	jsonOut(w, 202, map[string]any{"status": "complete"})
}

type discardWriter struct{ h http.Header }

func (d *discardWriter) Header() http.Header {
	if d.h == nil {
		d.h = http.Header{}
	}
	return d.h
}
func (d *discardWriter) Write(b []byte) (int, error) { return len(b), nil }
func (d *discardWriter) WriteHeader(int)             {}
func (s *Server) listMigrations(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	s.queryList(w, r, `SELECT device_id AS "deviceId",version,batch_key AS "batchKey",status,stats,updated_at AS "updatedAt" FROM data_migrations WHERE user_id=$1 ORDER BY updated_at DESC`, u.ID)
}
