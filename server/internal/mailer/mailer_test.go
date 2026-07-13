package mailer

import (
	"context"
	"errors"
	"testing"
)

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

func TestSendReturnsErrorWhenDeliveryIsDisabled(t *testing.T) {
	sender := &Sender{}
	err := sender.Send(context.Background(), "reader@example.com", "Verify", "123456")
	if !errors.Is(err, ErrDeliveryDisabled) {
		t.Fatalf("Send() error = %v, want ErrDeliveryDisabled", err)
	}
}
