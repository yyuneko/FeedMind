package api

import (
	"feedmind/server/internal/auth"
	"feedmind/server/internal/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBearerOnlyAcceptsAuthorizationHeader(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: "feedmind_access", Value: "legacy-cookie-token"})
	if got := bearer(r); got != "" {
		t.Fatalf("bearer() accepted access cookie %q", got)
	}
	r.Header.Set("Authorization", "Bearer memory-token")
	if got := bearer(r); got != "memory-token" {
		t.Fatalf("bearer() = %q, want memory-token", got)
	}
}

func TestClientTokensHideRefreshTokenForCookieTransport(t *testing.T) {
	tokens := auth.Tokens{AccessToken: "access", RefreshToken: "refresh", ExpiresIn: 900}
	web := clientTokens(tokens, true)
	if _, exists := web["refreshToken"]; exists {
		t.Fatal("cookie transport exposed refresh token in response")
	}
	if native := clientTokens(tokens, false); native["refreshToken"] != "refresh" {
		t.Fatal("body transport did not preserve refresh token")
	}
}

func TestBrowserLoginIsDetectedWithoutChangingJSONBody(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"email":"user@example.com","password":"password-1","deviceName":"FeedMind"}`))
	r.Header.Set("Origin", "https://app.feedmind.cc")
	var in struct{ Email, Password, DeviceName string }
	if err := decode(r, &in); err != nil {
		t.Fatalf("decode() rejected backwards-compatible login body: %v", err)
	}
	if !usesCookieTransport(r) {
		t.Fatal("browser login was not assigned cookie transport")
	}
	nativeRequest := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	if usesCookieTransport(nativeRequest) {
		t.Fatal("native login was incorrectly assigned cookie transport")
	}
}

func TestRefreshInputPrefersBodyAndDetectsCookieTransport(t *testing.T) {
	bodyRequest := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"refreshToken":"body-token"}`))
	bodyRequest.AddCookie(&http.Cookie{Name: "feedmind_refresh", Value: "cookie-token"})
	if raw, cookie := refreshInput(bodyRequest); raw != "body-token" || cookie {
		t.Fatalf("refreshInput(body) = %q, %v", raw, cookie)
	}
	cookieRequest := httptest.NewRequest(http.MethodPost, "/", nil)
	cookieRequest.AddCookie(&http.Cookie{Name: "feedmind_refresh", Value: "cookie-token"})
	if raw, cookie := refreshInput(cookieRequest); raw != "cookie-token" || !cookie {
		t.Fatalf("refreshInput(cookie) = %q, %v", raw, cookie)
	}
}

func TestRefreshCookieUsesAuthPathAndIsHttpOnly(t *testing.T) {
	s := &Server{Config: configForCookieTest()}
	w := httptest.NewRecorder()
	s.setRefreshCookie(w, auth.Tokens{RefreshToken: "refresh"})
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "feedmind_refresh" || cookies[0].Path != "/api/v1/auth" || !cookies[0].HttpOnly {
		t.Fatalf("unexpected refresh cookie: %#v", cookies)
	}
}

func TestClearCookiesDeletesRefreshCookieAtOriginalPath(t *testing.T) {
	s := &Server{Config: configForCookieTest()}
	w := httptest.NewRecorder()
	s.clearCookies(w)
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == "feedmind_refresh" {
			if cookie.Path != "/api/v1/auth" || cookie.MaxAge >= 0 || !cookie.HttpOnly {
				t.Fatalf("unexpected deleted refresh cookie: %#v", cookie)
			}
			return
		}
	}
	t.Fatal("clearCookies() did not delete refresh cookie")
}

func configForCookieTest() config.Config {
	return config.Config{RefreshTTL: 30 * 24 * time.Hour}
}

func TestPrivateFeedURLIsScopedToUser(t *testing.T) {
	first := privateFeedURL("user-one")
	second := privateFeedURL("user-two")
	if first == second || first != "feedmind://selected/user-one" {
		t.Fatalf("privateFeedURL() returned %q and %q", first, second)
	}
}

func TestArticleIdentityIsStable(t *testing.T) {
	first := articleIdentity("https://example.com/article")
	second := articleIdentity("https://example.com/article")
	other := articleIdentity("https://example.com/other")
	if first != second || first == other || len(first) != 64 {
		t.Fatalf("articleIdentity() returned %q, %q and %q", first, second, other)
	}
}

func TestNormalizeDatabaseValueFormatsUUID(t *testing.T) {
	uuid := [16]byte{0xc4, 0x92, 0x90, 0xfe, 0x18, 0x3c, 0x79, 0x73, 0xac, 0x3f, 0x4b, 0x39, 0x8e, 0xa7, 0xca, 0x45}
	got := normalizeDatabaseValue(postgresUUIDOID, uuid)
	want := `c49290fe-183c-7973-ac3f-4b398ea7ca45`
	if got != want {
		t.Fatalf(`normalizeDatabaseValue() = %v, want %q`, got, want)
	}
}

func TestNormalizeDatabaseValueLeavesNonUUIDUnchanged(t *testing.T) {
	value := `unchanged`
	if got := normalizeDatabaseValue(25, value); got != value {
		t.Fatalf(`normalizeDatabaseValue() = %v, want %q`, got, value)
	}
}

func TestPageMetadataReturnsTotalAndRemovesInternalColumn(t *testing.T) {
	items := []map[string]any{
		{"id": "one", "__total": int64(3)},
		{"id": "two", "__total": int64(3)},
	}

	total, hasMore := pageMetadata(items, 1)
	if total != 3 {
		t.Fatalf("pageMetadata() total = %d, want 3", total)
	}
	if !hasMore {
		t.Fatal("pageMetadata() hasMore = false, want true")
	}
	for _, item := range items {
		if _, ok := item["__total"]; ok {
			t.Fatal("pageMetadata() left internal total column in an item")
		}
	}
}
