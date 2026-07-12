package mailer

import "testing"

func TestNewTokenIsSixDigits(t *testing.T) {
	for range 1000 {
		token, err := NewToken()
		if err != nil {
			t.Fatalf("NewToken() error = %v", err)
		}
		if len(token) != 6 {
			t.Fatalf("NewToken() = %q, want 6 characters", token)
		}
		for _, char := range token {
			if char < '0' || char > '9' {
				t.Fatalf("NewToken() = %q, want digits only", token)
			}
		}
	}
}
