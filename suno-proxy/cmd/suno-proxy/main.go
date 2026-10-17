// Command suno-proxy downloads Suno songs a Vibez DJ asks for and streams them
// to anonymous listeners.
//
// Vibez talks to /songs with the shared access token; listeners hit /audio/{id}
// with no credentials at all.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/bike-shed-io/vibez/suno-proxy/internal/cache"
	"github.com/bike-shed-io/vibez/suno-proxy/internal/httpapi"
	"github.com/bike-shed-io/vibez/suno-proxy/internal/suno"
)

const sweepInterval = 5 * time.Minute

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	slog.SetDefault(log)

	if err := run(log); err != nil {
		log.Error("suno-proxy stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	token := os.Getenv("SUNO_ACCESS_TOKEN")
	if token == "" {
		return errors.New("SUNO_ACCESS_TOKEN is required")
	}

	store, err := cache.New(cache.Options{
		Dir:             env("SUNO_CACHE_DIR", ".cache/songs"),
		Resolver:        &suno.Resolver{},
		TTL:             envDuration("SUNO_CACHE_TTL", 24*time.Hour, log),
		MaxDownloads:    int64(envInt("SUNO_MAX_DOWNLOADS", 3, log)),
		DownloadTimeout: envDuration("SUNO_DOWNLOAD_TIMEOUT", 5*time.Minute, log),
		Logger:          log,
	})
	if err != nil {
		return err
	}
	defer store.Close()

	handler, err := httpapi.New(httpapi.Options{
		Cache:         store,
		Token:         token,
		PublicBaseURL: os.Getenv("SUNO_PROXY_PUBLIC_URL"),
		Logger:        log,
	})
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go store.Run(ctx, sweepInterval)
	store.Sweep() // a long downtime should not resurrect expired songs

	addr := env("SUNO_PROXY_ADDR", ":3006")
	server := &http.Server{
		Addr:    addr,
		Handler: handler,
		// Downloads can be long, so only the header read is bounded.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errs := make(chan error, 1)
	go func() {
		log.Info("suno-proxy listening", "addr", addr, "ttl", store.TTL())
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
	}()

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}

	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envDuration(key string, fallback time.Duration, log *slog.Logger) time.Duration {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		log.Warn("ignoring unparsable duration", "key", key, "value", raw)
		return fallback
	}
	return value
}

func envInt(key string, fallback int, log *slog.Logger) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		log.Warn("ignoring unparsable number", "key", key, "value", raw)
		return fallback
	}
	return value
}
