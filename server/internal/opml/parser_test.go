package opml

import "testing"

func TestParseNestedCategories(t *testing.T) {
	data := []byte(`<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><body><outline text="技术"><outline text="示例订阅" xmlUrl="https://example.com/feed.xml"/></outline><outline title="新闻" xmlUrl="https://news.example.com/rss"/></body></opml>`)
	feeds, err := Parse(data, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(feeds) != 2 || feeds[0].Title != "示例订阅" || feeds[0].Category != "技术" || feeds[1].Category != "" {
		t.Fatalf("unexpected feeds: %#v", feeds)
	}
}

func TestParseRejectsEmptyAndLimit(t *testing.T) {
	if _, err := Parse([]byte(`<opml><body/></opml>`), 10); err == nil {
		t.Fatal("expected empty OPML error")
	}
	data := []byte(`<opml><body><outline xmlUrl="https://a.example/rss"/><outline xmlUrl="https://b.example/rss"/></body></opml>`)
	if _, err := Parse(data, 1); err == nil {
		t.Fatal("expected feed limit error")
	}
}
