package main

import (
	"context"
	"feedmind/server/internal/api"
	"feedmind/server/internal/auth"
	"feedmind/server/internal/config"
	"feedmind/server/internal/database"
	"feedmind/server/internal/fetchsafe"
	"feedmind/server/internal/htmlfetch"
	"feedmind/server/internal/jobs"
	"feedmind/server/internal/logging"
	"feedmind/server/internal/mailer"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	if e := logging.Configure(os.Getenv("FEEDMIND_LOG_LEVEL")); e != nil {
		slog.Error("logging configuration", "error", e)
		os.Exit(1)
	}
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
	feedFetch := fetchsafe.New()
	htmlDirect := fetchsafe.New()
	htmlDirect.MaxBytes = cfg.HTMLWorkerMaxBytes
	htmlFetch := htmlfetch.New(htmlDirect, cfg.HTMLWorkerURL, cfg.HTMLWorkerToken, cfg.HTMLWorkerTimeout, cfg.HTMLWorkerMaxBytes)
	runner := &jobs.Runner{DB: db, Fetch: feedFetch, HTMLFetch: htmlFetch}
	if cfg.Mode == "all" || cfg.Mode == "scheduler" {
		go runner.Scheduler(ctx)
		slog.Info("FeedMind scheduler started")
	}
	if cfg.Mode == "all" || cfg.Mode == "worker" {
		for workerID := 1; workerID <= cfg.WorkerCount; workerID++ {
			go runner.Worker(ctx, workerID)
		}
		slog.Info("FeedMind workers started", "count", cfg.WorkerCount)
	}
	if cfg.Mode == "all" || cfg.Mode == "api" {
		mail := &mailer.Sender{Host: cfg.SMTPHost, Port: cfg.SMTPPort, User: cfg.SMTPUser, Password: cfg.SMTPPassword, FromName: cfg.MailFromName, FromAddress: cfg.MailFromAddress}
		srv := &http.Server{Addr: cfg.Addr, Handler: (&api.Server{DB: db, Auth: &auth.Service{DB: db, Secret: []byte(cfg.JWTSecret), AccessTTL: cfg.AccessTTL, RefreshTTL: cfg.RefreshTTL}, Config: cfg, Mailer: mail, Fetch: feedFetch}).Router(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
		go func() {
			<-ctx.Done()
			slog.Info("FeedMind API shutting down")
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if shutdownErr := srv.Shutdown(shutdownCtx); shutdownErr != nil {
				slog.Error("FeedMind API shutdown failed", "error", shutdownErr)
			}
		}()
		slog.Info("FeedMind API listening", "addr", cfg.Addr, "mode", cfg.Mode)
		if e = srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			slog.Error("server", "error", e)
			os.Exit(1)
		}
	} else {
		<-ctx.Done()
	}
	slog.Info("FeedMind stopped")
}
