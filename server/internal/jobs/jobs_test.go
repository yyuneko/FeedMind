package jobs

import (
	"strings"
	"testing"
)

func TestSanitizePreservesOnlyCodeLanguageClasses(t *testing.T) {
	got := sanitize(`<pre class="language-go"><code class="language-C++" onclick="bad()">int main() {}</code></pre><code class="other">inline</code>`)
	if !strings.Contains(got, `<code class="language-C++">int main() {}</code>`) {
		t.Fatalf("expected safe code language class to survive: %s", got)
	}
	for _, forbidden := range []string{`pre class=`, `class="other"`, `onclick=`} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("unexpected attribute %q in %s", forbidden, got)
		}
	}
}

func TestSanitizeMovesPreLanguageClassToCode(t *testing.T) {
	got := sanitize(`<pre class='language-go hljs'><code>package main</code></pre>`)
	if !strings.Contains(got, `language-go`) || strings.Contains(got, `pre class`) {
		t.Fatalf(`expected pre language class to move to code: %s`, got)
	}
}

func TestSanitizePreservesCodeWhitespace(t *testing.T) {
	code := "first line\n  two spaces\n\tone tab\n\nif (a < b && b > 0) {\n    return a & b;\n}\n"
	source := `<pre><code class="language-c">` + strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
	).Replace(code) + `</code></pre>`
	got := sanitize(source)
	want := `<pre><code class="language-c">` + strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
	).Replace(code) + `</code></pre>`
	if got != want {
		t.Fatalf("code whitespace changed during sanitization\nwant: %q\n got: %q", want, got)
	}
}

func TestSanitizeNormalizesCodeLanguageClassLists(t *testing.T) {
	got := sanitize(`<pre><code class='language-rust hljs' data-highlighted='yes'>fn main() {}</code></pre><code class='hljs lang-go extra'>package main</code>`)
	for _, expected := range []string{`language-rust`, `lang-go`} {
		if !strings.Contains(got, expected) {
			t.Fail()
		}
	}
	for _, forbidden := range []string{`hljs`, `extra`, `data-highlighted`} {
		if strings.Contains(got, forbidden) {
			t.Fail()
		}
	}
}

func TestSanitizePreservesSafeArticleVideos(t *testing.T) {
	got := sanitize(`<video poster="https://cdn.example.com/poster.jpg"><source src="https://cdn.example.com/movie.mp4" type="video/mp4"></video><iframe data-src="https://www.youtube-nocookie.com/embed/abc" allowfullscreen></iframe><iframe src="https://evil.example/embed"></iframe>`)
	for _, expected := range []string{
		`<video poster="https://cdn.example.com/poster.jpg">`,
		`<source src="https://cdn.example.com/movie.mp4" type="video/mp4"/>`,
		`src="https://www.youtube-nocookie.com/embed/abc"`,
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("expected safe media %q to survive: %s", expected, got)
		}
	}
	for _, forbidden := range []string{"evil.example", "data-src", "allowfullscreen"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("unexpected media content %q in %s", forbidden, got)
		}
	}
}

func TestVideoEmbedURLRejectsHostSuffixSpoofing(t *testing.T) {
	for _, value := range []string{
		"https://youtube.com/embed/abc",
		"https://www.youtube.com/embed/abc",
		"https://player.bilibili.com/player.html?bvid=abc",
	} {
		if !isVideoEmbedURL(value) {
			t.Fatalf("expected video URL to be allowed: %s", value)
		}
	}
	for _, value := range []string{"javascript:alert(1)", "https://youtube.com.evil.example/embed/abc"} {
		if isVideoEmbedURL(value) {
			t.Fatalf("expected video URL to be rejected: %s", value)
		}
	}
}

func TestComposeArticleHTMLKeepsSummaryAndFullArticle(t *testing.T) {
	got := composeArticleHTML(`<p>A short RSS summary.</p>`, `<article><p>The complete article has substantially different text.</p></article>`)
	if !strings.Contains(got, `A short RSS summary.`) || !strings.Contains(got, `<hr>`) || !strings.Contains(got, `The complete article`) {
		t.Fatalf("expected summary followed by full article: %s", got)
	}
}

func TestComposeArticleHTMLAvoidsDuplicateFullFeed(t *testing.T) {
	feed := `<p>This is the same complete article body with enough text to identify it as duplicated content.</p>`
	full := `<article><p>This is the same complete article body with enough text to identify it as duplicated content.</p></article>`
	got := composeArticleHTML(feed, full)
	if strings.Contains(got, `<hr>`) || got != full {
		t.Fatalf("expected only extracted full article, got: %s", got)
	}
}

func TestComposeArticleHTMLUsesCompleteFeedWhenWebExtractionIsTruncated(t *testing.T) {
	feed := `<p>Introduction before the quotation.</p><blockquote><p>A quoted rule that is long enough to identify the excerpt.</p></blockquote><p>The complete ending from the article.</p>`
	truncated := `<blockquote><p>A quoted rule that is long enough to identify the excerpt.</p></blockquote>`
	got := composeArticleHTML(feed, truncated)
	if got != feed || strings.Contains(got, `<hr>`) {
		t.Fatalf("expected the complete feed body instead of a duplicated truncated extraction: %s", got)
	}
}

func TestComposeArticleHTMLDoesNotPrependQuotedExcerpt(t *testing.T) {
	excerpt := `<blockquote><p>A quoted introduction long enough to be recognized as an excerpt.</p></blockquote>`
	full := `<p>Article introduction.</p>` + excerpt + `<p>The rest of the complete article.</p>`
	got := composeArticleHTML(excerpt, full)
	if got != full || strings.HasPrefix(got, `<blockquote>`) {
		t.Fatalf("expected the full article to keep its real introduction: %s", got)
	}
}

func TestLikelyFeedExcerptRequiresWebExtraction(t *testing.T) {
	if !isLikelyFeedExcerpt("", `<p>Out of all the things to love and hate with AI, this is what I miss.</p>`) {
		t.Fatal("expected a short RSS description to be treated as an excerpt")
	}
	if isLikelyFeedExcerpt(`<p>Short but explicitly supplied article content.</p>`, `<p>Summary.</p>`) {
		t.Fatal("expected rss_content to be treated as an available article body")
	}
	longDescription := `<p>` + strings.Repeat("Substantial article text. ", 30) + `</p>`
	if isLikelyFeedExcerpt("", longDescription) {
		t.Fatal("expected a substantial description-only feed body to remain usable")
	}
}
