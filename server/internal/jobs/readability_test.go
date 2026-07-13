package jobs

import (
	"net/url"
	"strings"
	"testing"
)

func TestExtractReadableArticlePreservesCodeLanguageClass(t *testing.T) {
	pageURL, err := url.Parse("https://example.com/article")
	if err != nil {
		t.Fatal(err)
	}
	source := `<html><head><title>Example</title></head><body><article><p>`
	source += strings.Repeat("Readable article content. ", 40)
	source += `</p><pre><code class="language-rust">fn main() {}</code></pre></article></body></html>`

	article, err := extractReadableArticle([]byte(source), pageURL)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(article.Content, `class="language-rust"`) {
		t.Fatalf("expected language class to survive readability: %s", article.Content)
	}
}
