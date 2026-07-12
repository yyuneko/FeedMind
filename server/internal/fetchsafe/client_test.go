package fetchsafe

import (
	"context"
	"net/url"
	"testing"
)

func TestRejectsLocalDestinations(t *testing.T) {
	for _, raw := range []string{"http://127.0.0.1/feed", "http://[::1]/feed", "file:///etc/passwd"} {
		u, _ := url.Parse(raw)
		if ValidateURL(context.Background(), u) == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
