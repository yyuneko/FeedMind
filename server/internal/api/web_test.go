package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestWebAppServesAssetsAndFallsBackToIndex(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<main>FeedMind</main>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "asset.js"), []byte("console.log('ok')"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		path       string
		wantStatus int
		wantBody   string
	}{
		{path: "/asset.js", wantStatus: http.StatusOK, wantBody: "console.log('ok')"},
		{path: "/article/123", wantStatus: http.StatusOK, wantBody: "<main>FeedMind</main>"},
		{path: "/missing.js", wantStatus: http.StatusNotFound, wantBody: "404 page not found\n"},
		{path: "/api/v1/unknown", wantStatus: http.StatusNotFound, wantBody: "404 page not found\n"},
	} {
		t.Run(test.path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			webApp(root).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, test.path, nil))
			if recorder.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, test.wantStatus)
			}
			if recorder.Body.String() != test.wantBody {
				t.Fatalf("body = %q, want %q", recorder.Body.String(), test.wantBody)
			}
		})
	}
}
