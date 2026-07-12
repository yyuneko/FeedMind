package opml

import (
	"encoding/xml"
	"errors"
	"strings"
)

type Feed struct{ URL, Title, Category string }
type outline struct {
	Text     string    `xml:"text,attr"`
	Title    string    `xml:"title,attr"`
	XMLURL   string    `xml:"xmlUrl,attr"`
	Outlines []outline `xml:"outline"`
}
type document struct {
	Body struct {
		Outlines []outline `xml:"outline"`
	} `xml:"body"`
}

func Parse(data []byte, maxFeeds int) ([]Feed, error) {
	if maxFeeds < 1 {
		return nil, errors.New("invalid OPML feed limit")
	}
	var doc document
	if err := xml.Unmarshal(data, &doc); err != nil {
		return nil, errors.New("invalid OPML document")
	}
	feeds := make([]Feed, 0)
	var walk func([]outline, string) error
	walk = func(items []outline, category string) error {
		for _, item := range items {
			name := strings.TrimSpace(item.Title)
			if name == "" {
				name = strings.TrimSpace(item.Text)
			}
			if feedURL := strings.TrimSpace(item.XMLURL); feedURL != "" {
				if len(feeds) >= maxFeeds {
					return errors.New("OPML document contains too many feeds")
				}
				feeds = append(feeds, Feed{URL: feedURL, Title: name, Category: category})
			}
			nextCategory := category
			if item.XMLURL == "" && name != "" {
				nextCategory = name
			}
			if err := walk(item.Outlines, nextCategory); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(doc.Body.Outlines, ""); err != nil {
		return nil, err
	}
	if len(feeds) == 0 {
		return nil, errors.New("no feeds found in OPML document")
	}
	return feeds, nil
}
