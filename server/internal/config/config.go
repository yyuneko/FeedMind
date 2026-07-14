package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr, DatabaseURL, JWTSecret, PublicURL, AllowedOrigins, Mode   string
	SMTPHost, SMTPUser, SMTPPassword, MailFromName, MailFromAddress string
	HTMLWorkerURL, HTMLWorkerToken                                  string
	SMTPPort, WorkerCount                                           int
	HTMLWorkerMaxBytes                                              int64
	AccessTTL, RefreshTTL, HTMLWorkerTimeout                        time.Duration
	CookieSecure                                                    bool
}

func Load() (Config, error) {
	c := Config{Addr: env("FEEDMIND_ADDR", ":8080"), DatabaseURL: os.Getenv("DATABASE_URL"), JWTSecret: os.Getenv("FEEDMIND_JWT_SECRET"), PublicURL: env("FEEDMIND_PUBLIC_URL", "http://localhost:8080"), AllowedOrigins: env("FEEDMIND_ALLOWED_ORIGINS", "http://localhost:8081,http://localhost:19006"), Mode: env("FEEDMIND_MODE", "all"), AccessTTL: 15 * time.Minute, RefreshTTL: 30 * 24 * time.Hour}
	c.CookieSecure, _ = strconv.ParseBool(env("FEEDMIND_COOKIE_SECURE", "false"))
	c.WorkerCount, _ = strconv.Atoi(env("FEEDMIND_WORKER_COUNT", "8"))
	c.SMTPHost = os.Getenv("FEEDMIND_SMTP_HOST")
	c.SMTPPort, _ = strconv.Atoi(env("FEEDMIND_SMTP_PORT", "587"))
	c.SMTPUser = os.Getenv("FEEDMIND_SMTP_USER")
	c.SMTPPassword = os.Getenv("FEEDMIND_SMTP_PASSWORD")
	c.MailFromName = env("FEEDMIND_MAIL_FROM_NAME", "FeedMind")
	c.MailFromAddress = os.Getenv("FEEDMIND_MAIL_FROM_ADDRESS")
	c.HTMLWorkerURL = strings.TrimSpace(os.Getenv("FEEDMIND_HTML_WORKER_URL"))
	c.HTMLWorkerToken = os.Getenv("FEEDMIND_HTML_WORKER_TOKEN")
	var err error
	c.HTMLWorkerTimeout, err = time.ParseDuration(env("FEEDMIND_HTML_WORKER_TIMEOUT", "20s"))
	if err != nil || c.HTMLWorkerTimeout <= 0 {
		return Config{}, errors.New("FEEDMIND_HTML_WORKER_TIMEOUT must be a positive duration")
	}
	c.HTMLWorkerMaxBytes, err = strconv.ParseInt(env("FEEDMIND_HTML_WORKER_MAX_BYTES", "8388608"), 10, 64)
	if err != nil || c.HTMLWorkerMaxBytes < 1024 || c.HTMLWorkerMaxBytes > 32<<20 {
		return Config{}, errors.New("FEEDMIND_HTML_WORKER_MAX_BYTES must be between 1024 and 33554432")
	}
	if c.DatabaseURL == "" || len(c.JWTSecret) < 32 {
		return Config{}, errors.New("DATABASE_URL and FEEDMIND_JWT_SECRET (at least 32 characters) are required")
	}
	if !contains([]string{"all", "api", "scheduler", "worker"}, c.Mode) {
		return Config{}, errors.New("FEEDMIND_MODE must be all, api, scheduler, or worker")
	}
	if c.WorkerCount < 1 {
		return Config{}, errors.New("FEEDMIND_WORKER_COUNT must be between 1 and 64")
	}
	if c.WorkerCount > 64 {
		return Config{}, errors.New("FEEDMIND_WORKER_COUNT must be between 1 and 64")
	}
	if c.SMTPHost != "" {
		if c.SMTPPort < 1 {
			return Config{}, errors.New("FEEDMIND_SMTP_PORT must be between 1 and 65535")
		}
		if c.SMTPPort > 65535 {
			return Config{}, errors.New("FEEDMIND_SMTP_PORT must be between 1 and 65535")
		}
		if c.MailFromAddress == "" {
			return Config{}, errors.New("FEEDMIND_MAIL_FROM_ADDRESS is required when SMTP is enabled")
		}
	}
	if (c.HTMLWorkerURL == "") != (c.HTMLWorkerToken == "") {
		return Config{}, errors.New("FEEDMIND_HTML_WORKER_URL and FEEDMIND_HTML_WORKER_TOKEN must be configured together")
	}
	if c.HTMLWorkerURL != "" {
		workerURL, parseErr := url.Parse(c.HTMLWorkerURL)
		if parseErr != nil || workerURL.Hostname() == "" || workerURL.User != nil || workerURL.RawQuery != "" || workerURL.Fragment != "" {
			return Config{}, errors.New("FEEDMIND_HTML_WORKER_URL must be an absolute URL without credentials, query, or fragment")
		}
		if workerURL.Scheme != "https" && !(workerURL.Scheme == "http" && isLocalDevelopmentHost(workerURL.Hostname())) {
			return Config{}, errors.New("FEEDMIND_HTML_WORKER_URL must use HTTPS (loopback and host.docker.internal HTTP are allowed for local development)")
		}
		if workerURL.Path == "" || workerURL.Path == "/" {
			return Config{}, fmt.Errorf("FEEDMIND_HTML_WORKER_URL must include the Worker endpoint path, for example /html")
		}
	}
	return c, nil
}

func isLocalDevelopmentHost(host string) bool {
	normalized := strings.TrimSuffix(host, ".")
	if strings.EqualFold(normalized, "localhost") || strings.EqualFold(normalized, "host.docker.internal") {
		return true
	}
	ip := net.ParseIP(normalized)
	return ip != nil && ip.IsLoopback()
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
