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

func TestExtractReadableArticleNormalizesProseWrappedInPre(t *testing.T) {
	pageURL, err := url.Parse("https://antirez.com/news/150")
	if err != nil {
		t.Fatal(err)
	}
	source := `<html><head><title>Example</title></head><body><article><pre>`
	source += strings.Repeat("Long article paragraph used to make readability retain the article body. ", 20)
	source += `

Original post: <a href="https://news.ycombinator.com/item?id=33755016">https://news.ycombinator.com/item?id=33755016</a>

<img src="http://antirez.com/misc/hnstyle_1.jpg"></pre></article></body></html>`

	article, err := extractReadableArticle([]byte(source), pageURL)
	if err != nil {
		t.Fatal(err)
	}
	got := sanitize(normalizeArticleTextMarkers(article.Content))
	for _, expected := range []string{
		`<a href="https://news.ycombinator.com/item?id=33755016"`,
		`<img src="http://antirez.com/misc/hnstyle_1.jpg"/>`,
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("expected %q after extraction and normalization: %s", expected, got)
		}
	}
	if strings.Contains(got, "<pre>") {
		t.Fatalf("expected prose wrapper to be expanded: %s", got)
	}
}
