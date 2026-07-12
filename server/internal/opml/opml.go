package opml

import (
	"encoding/xml"
	"errors"
	"strings"
)

type Feed struct {
	Title    string
	URL      string
	Category string
}

type document struct {
	XMLName xml.Name
	Body    struct {
		Outlines []outline `xml:"outline"`
	} `xml:"body"`
}

type outline struct {
	Text     string
	Title    string
	XMLURL   string
	Children []outline
}

func (o *outline) UnmarshalXML(decoder *xml.Decoder, start xml.StartElement) error {
	for _, attribute := range start.Attr {
		switch strings.ToLower(attribute.Name.Local) {
		case "text":
			o.Text = strings.TrimSpace(attribute.Value)
		case "title":
			o.Title = strings.TrimSpace(attribute.Value)
		case "xmlurl":
			o.XMLURL = strings.TrimSpace(attribute.Value)
		}
	}

	for {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		switch value := token.(type) {
		case xml.StartElement:
			if strings.EqualFold(value.Name.Local, "outline") {
				var child outline
				if err := decoder.DecodeElement(&child, &value); err != nil {
					return err
				}
				o.Children = append(o.Children, child)
			} else if err := decoder.Skip(); err != nil {
				return err
			}
		case xml.EndElement:
			if value.Name == start.Name {
				return nil
			}
		}
	}
}

func Parse(data []byte, limit int) ([]Feed, error) {
	if limit <= 0 {
		return nil, errors.New("OPML feed limit must be positive")
	}

	var doc document
	decoder := xml.NewDecoder(strings.NewReader(string(data)))
	decoder.Strict = false
	if err := decoder.Decode(&doc); err != nil {
		return nil, err
	}
	if !strings.EqualFold(doc.XMLName.Local, "opml") {
		return nil, errors.New("document is not OPML")
	}

	feeds := make([]Feed, 0)
	var walk func([]outline, string) error
	walk = func(items []outline, category string) error {
		for _, item := range items {
			title := strings.TrimSpace(item.Title)
			if title == "" {
				title = strings.TrimSpace(item.Text)
			}

			if item.XMLURL != "" {
				feeds = append(feeds, Feed{Title: title, URL: item.XMLURL, Category: category})
				if len(feeds) > limit {
					return errors.New("OPML contains too many feeds")
				}
			}

			nextCategory := category
			if item.XMLURL == "" && title != "" {
				nextCategory = title
			}
			if err := walk(item.Children, nextCategory); err != nil {
				return err
			}
		}
		return nil
	}

	if err := walk(doc.Body.Outlines, ""); err != nil {
		return nil, err
	}
	if len(feeds) == 0 {
		return nil, errors.New("OPML does not contain any feeds")
	}
	return feeds, nil
}
