package opml

import "testing"

func TestParseNestedOutlines(t *testing.T) {
	feeds, err := Parse([]byte(`<?xml version="1.0"?><opml version="2.0"><body><outline text="Technology"><outline text="Example" type="rss" xmlUrl="https://example.com/feed.xml"/></outline><outline title="News" xmlurl="https://news.example.com/rss"/></body></opml>`), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(feeds) != 2 {
		t.Fatalf("expected 2 feeds, got %d", len(feeds))
	}
	if feeds[0].Title != "Example" || feeds[0].Category != "Technology" || feeds[0].URL != "https://example.com/feed.xml" {
		t.Fatalf("unexpected first feed: %#v", feeds[0])
	}
	if feeds[1].Title != "News" || feeds[1].Category != "" || feeds[1].URL != "https://news.example.com/rss" {
		t.Fatalf("unexpected second feed: %#v", feeds[1])
	}
}

func TestParseRejectsNonOPML(t *testing.T) {
	if _, err := Parse([]byte(`<rss version="2.0"></rss>`), 10); err == nil {
		t.Fatal("expected non-OPML document to fail")
	}
}

func TestParseEnforcesLimit(t *testing.T) {
	if _, err := Parse([]byte(`<opml><body><outline xmlUrl="https://one.example/rss"/><outline xmlUrl="https://two.example/rss"/></body></opml>`), 1); err == nil {
		t.Fatal("expected feed limit error")
	}
}
