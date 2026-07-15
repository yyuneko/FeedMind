package jobs

import (
	"errors"
	"feedmind/server/internal/htmlfetch"
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

func TestSanitizePreservesSafeArticleMedia(t *testing.T) {
	got := sanitize(`<video poster="https://cdn.example.com/poster.jpg"><source src="https://cdn.example.com/movie.mp4" type="video/mp4"></video><audio><source src="/sound.mp3" type="audio/mpeg"></audio><iframe data-src="https://www.youtube-nocookie.com/embed/abc" allowfullscreen></iframe><iframe src="https://widgets.example/embed"></iframe><iframe src="http://widgets.example/insecure"></iframe>`, "https://news.example/article")
	for _, expected := range []string{
		`<video poster="https://cdn.example.com/poster.jpg">`,
		`<source src="https://cdn.example.com/movie.mp4" type="video/mp4"/>`,
		`<audio><source src="https://news.example/sound.mp3" type="audio/mpeg"/></audio>`,
		`src="https://www.youtube-nocookie.com/embed/abc"`,
		`src="https://widgets.example/embed"`,
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("expected safe media %q to survive: %s", expected, got)
		}
	}
	for _, forbidden := range []string{"insecure", "data-src", "allowfullscreen"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("unexpected media content %q in %s", forbidden, got)
		}
	}
}

func TestSanitizePreservesStaticSVGAndNormalizesFormulas(t *testing.T) {
	got := sanitize(`<p>Equation <script type="math/tex">x^2</script></p><math display="block" onclick="bad()"><mfrac><mi>a</mi><mi>b</mi></mfrac><script>alert(1)</script></math><svg viewBox="0 0 100 50" onload="bad()"><defs><linearGradient id="g"><stop offset="0" stop-color="red"></stop></linearGradient></defs><rect width="100" height="50" fill="url(#g)"></rect><use href="#g"></use><foreignObject><script>bad()</script></foreignObject></svg>`)
	for _, expected := range []string{`<feedmind-math data-format="tex" data-display="inline">x^2</feedmind-math>`, `data-format="mathml"`, `<svg`, `viewbox="0 0 100 50"`, `fill="url(#g)"`, `href="#g"`} {
		if !strings.Contains(got, expected) {
			t.Fatalf("expected safe rich content %q in %s", expected, got)
		}
	}
	for _, forbidden := range []string{"onclick", "onload", "foreignObject", "alert(1)", "<script"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("unexpected rich content %q in %s", forbidden, got)
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

func TestJobRequestID(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		want    string
	}{
		{name: "feed", payload: `{"feedId":"feed-1","requestId":"djygna6hr8ch"}`, want: "djygna6hr8ch"},
		{name: "article", payload: `{"articleId":"article-1","requestId":"article-request"}`, want: "article-request"},
		{name: "missing", payload: `{"feedId":"feed-1"}`, want: ""},
		{name: "invalid JSON", payload: `{`, want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := jobRequestID(job{Payload: []byte(test.payload)}); got != test.want {
				t.Fatalf("jobRequestID() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestMaxJobAttemptsLimitsWorkerFallbackFailures(t *testing.T) {
	workerFailure := &htmlfetch.WorkerFallbackError{
		Direct: errors.New("direct fetch failed"),
		Worker: errors.New("Worker fetch failed"),
	}
	if got := maxJobAttempts(workerFailure); got != 3 {
		t.Fatalf("maxJobAttempts(Worker failure) = %d, want 3", got)
	}
	if got := maxJobAttempts(errors.New("ordinary failure")); got != 8 {
		t.Fatalf("maxJobAttempts(ordinary failure) = %d, want 8", got)
	}
}
