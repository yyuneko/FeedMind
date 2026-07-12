package main

import (
	"context"
	"feedmind/server/internal/api"
	"feedmind/server/internal/auth"
	"feedmind/server/internal/config"
	"feedmind/server/internal/database"
	"feedmind/server/internal/fetchsafe"
	"feedmind/server/internal/jobs"
	"feedmind/server/internal/mailer"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	cfg, e := config.Load()
	if e != nil {
		slog.Error("configuration", "error", e)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, e := database.Open(ctx, cfg.DatabaseURL)
	if e != nil {
		slog.Error("database", "error", e)
		os.Exit(1)
	}
	defer db.Close()
	if e = database.Migrate(ctx, db); e != nil {
		slog.Error("migrations", "error", e)
		os.Exit(1)
	}
	runner := &jobs.Runner{DB: db, Fetch: fetchsafe.New()}
	if cfg.Mode == "all" || cfg.Mode == "scheduler" {
		go runner.Scheduler(ctx)
	}
	if cfg.Mode == "all" || cfg.Mode == "worker" {
		go runner.Worker(ctx)
	}
	if cfg.Mode == "all" || cfg.Mode == "api" {
		mail := &mailer.Sender{Host: cfg.SMTPHost, Port: cfg.SMTPPort, User: cfg.SMTPUser, Password: cfg.SMTPPassword, FromName: cfg.MailFromName, FromAddress: cfg.MailFromAddress}
		srv := &http.Server{Addr: cfg.Addr, Handler: (&api.Server{DB: db, Auth: &auth.Service{DB: db, Secret: []byte(cfg.JWTSecret), AccessTTL: cfg.AccessTTL, RefreshTTL: cfg.RefreshTTL}, Config: cfg, Mailer: mail}).Router(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
		go func() {
			<-ctx.Done()
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = srv.Shutdown(shutdownCtx)
		}()
		slog.Info("FeedMind API listening", "addr", cfg.Addr, "mode", cfg.Mode)
		if e = srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			slog.Error("server", "error", e)
			os.Exit(1)
		}
	} else {
		<-ctx.Done()
	}
}
