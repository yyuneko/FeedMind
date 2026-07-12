package opmlimport

import "testing"

func TestCanonicalOPMLURLRewritesRawGist(t *testing.T) {
	input := "https://gist.github.com/emschwartz/e6d2/raw/4269/feeds.opml"
	want := "https://gist.githubusercontent.com/emschwartz/e6d2/raw/4269/feeds.opml"
	if got := canonicalOPMLURL(input); got != want {
		t.Fatalf("canonicalOPMLURL() = %q, want %q", got, want)
	}
}

func TestCanonicalOPMLURLDoesNotRewriteOtherURLs(t *testing.T) {
	inputs := []string{
		"https://gist.github.com/emschwartz/e6d2",
		"https://example.com/user/id/raw/file.opml",
		"https://gist.github.com.evil.example/user/id/raw/file.opml",
	}
	for _, input := range inputs {
		if got := canonicalOPMLURL(input); got != input {
			t.Errorf("canonicalOPMLURL(%q) = %q", input, got)
		}
	}
}
