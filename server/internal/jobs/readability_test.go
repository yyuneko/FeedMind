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

func TestExtractReadableArticlePreservesMathJaxFormulaSources(t *testing.T) {
	pageURL, err := url.Parse("https://eli.thegreenplace.net/2026/notes-on-the-fourier-transform/")
	if err != nil {
		t.Fatal(err)
	}
	source := `<html><head><title>Notes on the Fourier transform</title></head><body><article><p>`
	source += strings.Repeat("Readable article content about Fourier analysis. ", 40)
	source += `</p><p>Inline: <script type="math/tex">e^{i\\theta}</script>.</p>`
	source += `<script type="math/tex; mode=display">\\hat f(\\xi)=\\int f(x)e^{-2\\pi i x\\xi}dx</script>`
	source += `<math display="block"><mfrac><mi>a</mi><mi>b</mi></mfrac></math></article></body></html>`
	source = strings.Replace(source, `</article>`, `<p>SVG formula: <object class="valign-m4 latex-math" data="https://eli.thegreenplace.net/images/math/example.svg" type="image/svg+xml">(-\\infty,\\infty)</object></p><object class="align-center" data="https://eli.thegreenplace.net/images/math/block.svg" type="image/svg+xml">\[F(\omega)=\int f(x)dx\]</object></article>`, 1)

	article, err := extractReadableArticle([]byte(source), pageURL)
	if err != nil {
		t.Fatal(err)
	}
	got := sanitize(article.Content, pageURL.String())
	for _, expected := range []string{
		`<feedmind-math data-format="tex" data-display="inline">e^{i\\theta}</feedmind-math>`,
		`<feedmind-math data-format="tex" data-display="block">\\hat f(\\xi)=\\int f(x)e^{-2\\pi i x\\xi}dx</feedmind-math>`,
		`<feedmind-math data-format="mathml" data-display="block">`,
		`&lt;mfrac&gt;&lt;mi&gt;a&lt;/mi&gt;&lt;mi&gt;b&lt;/mi&gt;&lt;/mfrac&gt;`,
		`<feedmind-math data-format="tex" data-display="inline">(-\\infty,\\infty)</feedmind-math>`,
		`<feedmind-math data-format="tex" data-display="block">F(\omega)=\int f(x)dx</feedmind-math>`,
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("expected %q after readability extraction: %s", expected, got)
		}
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

func TestExtractReadableArticlePreservesCenteredImageWithLinkedCredit(t *testing.T) {
	pageURL, err := url.Parse(`https://berthub.eu/articles/posts/ben-je-van-de-it-of-niet/`)
	if err != nil {
		t.Fatal(err)
	}
	source := `<html><head><title>Example</title></head><body><article><p>`
	source += strings.Repeat(`Readable article content. `, 40)
	source += `</p><center><div style='max-width: 500px;'><p><img loading='lazy' src='/articles/Zugspitze_-_toilet.jpg'><br>Door Tiia Monto, CC BY-SA 3.0, <a href='https://commons.wikimedia.org/example'>Wikimedia</a></p></div></center>`
	source += `<p>` + strings.Repeat(`More readable content. `, 20) + `</p><center><p><img src='/articles/Pat_Mat.jpg'></p></center></article></body></html>`

	article, err := extractReadableArticle([]byte(source), pageURL)
	if err != nil {
		t.Fatal(err)
	}
	got := sanitize(article.Content, pageURL.String())
	for _, expected := range []string{
		`https://berthub.eu/articles/Zugspitze_-_toilet.jpg`,
		`https://berthub.eu/articles/Pat_Mat.jpg`,
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf(`expected %q after readability extraction: %s`, expected, got)
		}
	}
	if thumbnail := extractThumbnailURL(got, pageURL.String()); thumbnail != `https://berthub.eu/articles/Zugspitze_-_toilet.jpg` {
		t.Fatalf(`expected the first centered image as thumbnail, got %q`, thumbnail)
	}
}
