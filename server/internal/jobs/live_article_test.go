package jobs

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/PuerkitoBio/goquery"
)

const fourierTransformArticleURL = "https://eli.thegreenplace.net/2026/notes-on-the-fourier-transform/"

// TestLiveFourierTransformArticleFormulaExtraction exercises the real page and
// is opt-in so ordinary unit tests remain deterministic when the site or
// network is unavailable. Run with FEEDMIND_LIVE_ARTICLE_TEST=1.
func TestLiveFourierTransformArticleFormulaExtraction(t *testing.T) {
	if os.Getenv("FEEDMIND_LIVE_ARTICLE_TEST") != "1" {
		t.Skip("set FEEDMIND_LIVE_ARTICLE_TEST=1 to fetch the live article")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fourierTransformArticleURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("User-Agent", "FeedMind formula integration test")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("fetch live article: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		t.Fatalf("fetch live article: HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		t.Fatal(err)
	}
	pageURL, err := url.Parse(fourierTransformArticleURL)
	if err != nil {
		t.Fatal(err)
	}
	article, err := extractReadableArticle(body, pageURL)
	if err != nil {
		t.Fatalf("extract live article: %v", err)
	}
	clean := sanitize(article.Content, pageURL.String())
	document, err := goquery.NewDocumentFromReader(strings.NewReader(clean))
	if err != nil {
		t.Fatal(err)
	}
	normalizedCount := document.Find("feedmind-math").Length()
	if normalizedCount < 100 {
		t.Fatalf("expected at least 100 normalized formulas after extraction, got %d", normalizedCount)
	}
	document.Find("feedmind-math").Each(func(index int, formula *goquery.Selection) {
		if strings.TrimSpace(formula.Text()) == "" {
			t.Errorf("formula %d has empty source", index)
		}
	})
	t.Logf("parsed live article formulas: normalized=%d", normalizedCount)
}
