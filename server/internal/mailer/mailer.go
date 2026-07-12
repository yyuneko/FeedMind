package mailer

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"gopkg.in/gomail.v2"
	"log/slog"
)

type Sender struct {
	Host, User, Password, FromName, FromAddress string
	Port                                        int
}

func NewToken() (string, error) {
	b := make([]byte, 9)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func (s *Sender) Enabled() bool { return s != nil && s.Host != "" }
func (s *Sender) Send(ctx context.Context, to, subject, body string) error {
	if !s.Enabled() {
		slog.InfoContext(ctx, "email delivery disabled", "to", to, "subject", subject, "body", body)
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	msg := gomail.NewMessage()
	msg.SetAddressHeader("From", s.FromAddress, s.FromName)
	msg.SetHeader("To", to)
	msg.SetHeader("Subject", subject)
	msg.SetBody("text/plain", body)
	dialer := gomail.NewDialer(s.Host, s.Port, s.User, s.Password)
	return dialer.DialAndSend(msg)
}
func VerificationBody(token string) string {
	return "欢迎使用 FeedMind。\n\n您的邮箱验证码是：" + token + "\n\n验证码 24 小时内有效。如非本人操作，请忽略此邮件。"
}
func ResetBody(token string) string {
	return "您正在重置 FeedMind 密码。\n\n您的重置验证码是：" + token + "\n\n验证码 1 小时内有效。如非本人操作，请忽略此邮件。"
}
