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
