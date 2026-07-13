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

func TestNormalizeArticleTextMarkersCreatesLinksAndImages(t *testing.T) {
	source := `<p>This is the original post: https://news.ycombinator.com/item?id=33755016</p><p>img://antirez.com/misc/hnstyle_1.jpg</p>`
	got := sanitize(normalizeArticleTextMarkers(source))
	for _, expected := range []string{
		`<a href="https://news.ycombinator.com/item?id=33755016"`,
		`>https://news.ycombinator.com/item?id=33755016</a>`,
		`<img src="https://antirez.com/misc/hnstyle_1.jpg"/>`,
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("expected %q in normalized article: %s", expected, got)
		}
	}
	for _, forbidden := range []string{"img://", "<hr>"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("unexpected marker %q in normalized article: %s", forbidden, got)
		}
	}
}

func TestNormalizeArticleTextMarkersSkipsExistingLinksAndCode(t *testing.T) {
	source := `<p><a href="https://example.com">Existing</a></p><pre><code>https://example.com/code</code></pre>`
	got := normalizeArticleTextMarkers(source)
	if strings.Count(got, "<a ") != 1 {
		t.Fatalf("expected existing link not to be nested: %s", got)
	}
	if !strings.Contains(got, `<code>https://example.com/code</code>`) {
		t.Fatalf("expected code URL to stay as text: %s", got)
	}
}

func TestNormalizeArticleTextMarkersExpandsArticleProsePre(t *testing.T) {
	source := `<pre>First paragraph with <a rel="nofollow" href="https://news.ycombinator.com/item?id=33755016">the original post</a>.

Second paragraph.

<img src="http://antirez.com/misc/hnstyle_1.jpg"></pre>`
	got := sanitize(normalizeArticleTextMarkers(source))
	for _, expected := range []string{
		`<a href="https://news.ycombinator.com/item?id=33755016"`,
		`<img src="http://antirez.com/misc/hnstyle_1.jpg"/>`,
		"<br/>",
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("expected %q in normalized article: %s", expected, got)
		}
	}
	if strings.Contains(got, "<pre>") {
		t.Fatalf("expected article-level prose pre to be expanded: %s", got)
	}
}

func TestNormalizeArticleTextMarkersKeepsRealCodePre(t *testing.T) {
	source := `<pre><code class="language-go">fmt.Println("https://example.com")</code></pre>`
	got := normalizeArticleTextMarkers(source)
	if !strings.Contains(got, `<pre><code class="language-go">`) || !strings.Contains(got, "https://example.com") || strings.Contains(got, "<a ") {
		t.Fatalf("expected real code pre to stay unchanged: %s", got)
	}
}

func TestJobEntityAttrsIncludesEntityID(t *testing.T) {
	tests := []struct {
		job  job
		want string
	}{
		{job: job{Type: "fetch_feed", Payload: []byte(`{"feedId":"feed-1"}`)}, want: "feed-1"},
		{job: job{Type: "parse_article", Payload: []byte(`{"articleId":"article-1"}`)}, want: "article-1"},
	}
	for _, test := range tests {
		attrs := jobEntityAttrs(test.job)
		if len(attrs) != 2 || attrs[1] != test.want {
			t.Fatalf("jobEntityAttrs(%q) = %#v, want entity ID %q", test.job.Type, attrs, test.want)
		}
	}
}
