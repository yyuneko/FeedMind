package config

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr, DatabaseURL, JWTSecret, PublicURL, AllowedOrigins, Mode   string
	SMTPHost, SMTPUser, SMTPPassword, MailFromName, MailFromAddress string
	SMTPPort                                                        int
	AccessTTL, RefreshTTL                                           time.Duration
	CookieSecure                                                    bool
}

func Load() (Config, error) {
	c := Config{Addr: env("FEEDMIND_ADDR", ":8080"), DatabaseURL: os.Getenv("DATABASE_URL"), JWTSecret: os.Getenv("FEEDMIND_JWT_SECRET"), PublicURL: env("FEEDMIND_PUBLIC_URL", "http://localhost:8080"), AllowedOrigins: env("FEEDMIND_ALLOWED_ORIGINS", "http://localhost:8081,http://localhost:19006"), Mode: env("FEEDMIND_MODE", "all"), AccessTTL: 15 * time.Minute, RefreshTTL: 30 * 24 * time.Hour}
	c.CookieSecure, _ = strconv.ParseBool(env("FEEDMIND_COOKIE_SECURE", "false"))
	c.SMTPHost = os.Getenv("FEEDMIND_SMTP_HOST")
	c.SMTPPort, _ = strconv.Atoi(env("FEEDMIND_SMTP_PORT", "587"))
	c.SMTPUser = os.Getenv("FEEDMIND_SMTP_USER")
	c.SMTPPassword = os.Getenv("FEEDMIND_SMTP_PASSWORD")
	c.MailFromName = env("FEEDMIND_MAIL_FROM_NAME", "FeedMind")
	c.MailFromAddress = os.Getenv("FEEDMIND_MAIL_FROM_ADDRESS")
	if c.DatabaseURL == "" || len(c.JWTSecret) < 32 {
		return Config{}, errors.New("DATABASE_URL and FEEDMIND_JWT_SECRET (at least 32 characters) are required")
	}
	if !contains([]string{"all", "api", "scheduler", "worker"}, c.Mode) {
		return Config{}, errors.New("FEEDMIND_MODE must be all, api, scheduler, or worker")
	}
	return c, nil
}
func env(k, v string) string {
	if x := strings.TrimSpace(os.Getenv(k)); x != "" {
		return x
	}
	return v
}
func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
