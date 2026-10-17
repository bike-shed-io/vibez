package cache

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bike-shed-io/vibez/suno-proxy/internal/suno"
)

const songID = "6d6536c7-4e24-405c-8d6d-0c4e1c4ee981"

// fakeResolver stands in for Suno. release gates the download so a test can
// inspect the in-between states.
type fakeResolver struct {
	resolves    atomic.Int32
	downloads   atomic.Int32
	payload     string
	resolveErr  error
	downloadErr error
	release     chan struct{}
}

func (f *fakeResolver) Resolve(_ context.Context, raw string) (suno.Song, error) {
	f.resolves.Add(1)
	if f.resolveErr != nil {
		return suno.Song{}, f.resolveErr
	}
	return suno.Song{
		ID:          songID,
		PageURL:     suno.SongPageURL(songID),
		Title:       "Raised on Rewind & Friends",
		Artwork:     "https://cdn2.suno.ai/" + songID + "_cover.jpeg",
		DurationSec: 220.64,
		Candidates:  []string{"https://cdn1.suno.ai/" + songID + ".mp4"},
	}, nil
}

func (f *fakeResolver) Download(_ context.Context, _ suno.Song, dst io.Writer) (string, error) {
	f.downloads.Add(1)
	if f.release != nil {
		<-f.release
	}
	if f.downloadErr != nil {
		return "", f.downloadErr
	}
	if _, err := io.WriteString(dst, f.payload); err != nil {
		return "", err
	}
	return "video/mp4", nil
}

func newCache(t *testing.T, resolver Resolver, now func() time.Time) *Cache {
	t.Helper()
	c, err := New(Options{
		Dir:      t.TempDir(),
		Resolver: resolver,
		TTL:      24 * time.Hour,
		Now:      now,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(c.Close)
	return c
}

// waitForStatus polls the index, which is how the HTTP status route behaves.
func waitForStatus(t *testing.T, c *Cache, id string, want Status) Entry {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if entry, ok := c.Get(id); ok && entry.Status == want {
			return entry
		}
		time.Sleep(5 * time.Millisecond)
	}
	entry, _ := c.Get(id)
	t.Fatalf("song never reached %q (last status %q, error %q)", want, entry.Status, entry.Error)
	return Entry{}
}

func TestRequestDownloadsAndServes(t *testing.T) {
	resolver := &fakeResolver{payload: "ftypaudio"}
	c := newCache(t, resolver, time.Now)

	entry, err := c.Request(context.Background(), suno.SongPageURL(songID))
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if entry.Status != StatusQueued {
		t.Errorf("status = %q, want %q so the DJ is not held for the download", entry.Status, StatusQueued)
	}
	if entry.Title != "Raised on Rewind & Friends" {
		t.Errorf("title = %q, want metadata available before the download finishes", entry.Title)
	}

	ready := waitForStatus(t, c, songID, StatusReady)
	if ready.Size != int64(len(resolver.payload)) {
		t.Errorf("size = %d, want %d", ready.Size, len(resolver.payload))
	}
	if ready.ContentType != "video/mp4" {
		t.Errorf("contentType = %q", ready.ContentType)
	}
	if ready.ExpiresAt.IsZero() {
		t.Error("a ready song must expire")
	}

	file, _, err := c.Open(songID)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer file.Close()
	got, _ := io.ReadAll(file)
	if string(got) != resolver.payload {
		t.Errorf("served %q, want %q", got, resolver.payload)
	}
}

func TestRequestReusesCachedSong(t *testing.T) {
	resolver := &fakeResolver{payload: "ftypaudio"}
	c := newCache(t, resolver, time.Now)

	if _, err := c.Request(context.Background(), suno.SongPageURL(songID)); err != nil {
		t.Fatalf("Request: %v", err)
	}
	waitForStatus(t, c, songID, StatusReady)

	// The same song inside its lifetime must not touch Suno again, not even for
	// the page.
	entry, err := c.Request(context.Background(), suno.SongPageURL(songID))
	if err != nil {
		t.Fatalf("second Request: %v", err)
	}
	if entry.Status != StatusReady {
		t.Errorf("status = %q, want an immediate %q", entry.Status, StatusReady)
	}
	if got := resolver.resolves.Load(); got != 1 {
		t.Errorf("resolved %d times, want 1", got)
	}
	if got := resolver.downloads.Load(); got != 1 {
		t.Errorf("downloaded %d times, want 1", got)
	}
}

func TestConcurrentRequestsDownloadOnce(t *testing.T) {
	resolver := &fakeResolver{payload: "ftypaudio", release: make(chan struct{})}
	c := newCache(t, resolver, time.Now)

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Request(context.Background(), suno.SongPageURL(songID)); err != nil {
				t.Errorf("Request: %v", err)
			}
		}()
	}
	wg.Wait()
	close(resolver.release)

	waitForStatus(t, c, songID, StatusReady)
	if got := resolver.downloads.Load(); got != 1 {
		t.Errorf("downloaded %d times, want 1 for eight callers", got)
	}
}

func TestExpiredSongIsSweptAndRefetched(t *testing.T) {
	resolver := &fakeResolver{payload: "ftypaudio"}
	clock := time.Now()
	now := func() time.Time { return clock }
	c := newCache(t, resolver, now)

	if _, err := c.Request(context.Background(), suno.SongPageURL(songID)); err != nil {
		t.Fatalf("Request: %v", err)
	}
	waitForStatus(t, c, songID, StatusReady)

	// A day later nobody has asked again, and the song goes anyway.
	clock = clock.Add(24*time.Hour + time.Minute)
	if removed := c.Sweep(); removed != 1 {
		t.Fatalf("swept %d songs, want 1", removed)
	}
	if _, ok := c.Get(songID); ok {
		t.Error("expired song is still in the index")
	}
	if _, err := os.Stat(filepath.Join(c.dir, songID+".audio")); !errors.Is(err, os.ErrNotExist) {
		t.Error("expired audio file is still on disk")
	}
	if _, _, err := c.Open(songID); !errors.Is(err, ErrNotReady) {
		t.Errorf("Open after eviction = %v, want ErrNotReady", err)
	}

	// Asking again downloads it a second time.
	if _, err := c.Request(context.Background(), suno.SongPageURL(songID)); err != nil {
		t.Fatalf("Request after eviction: %v", err)
	}
	waitForStatus(t, c, songID, StatusReady)
	if got := resolver.downloads.Load(); got != 2 {
		t.Errorf("downloaded %d times, want a fresh download after eviction", got)
	}
}

func TestFailedDownloadIsReportedAndRetried(t *testing.T) {
	resolver := &fakeResolver{downloadErr: suno.ErrNoPlayableAudio}
	c := newCache(t, resolver, time.Now)

	if _, err := c.Request(context.Background(), suno.SongPageURL(songID)); err != nil {
		t.Fatalf("Request: %v", err)
	}
	failed := waitForStatus(t, c, songID, StatusFailed)
	if !strings.Contains(failed.Error, suno.ErrNoPlayableAudio.Error()) {
		t.Errorf("error = %q, want the download's complaint for the DJ to read", failed.Error)
	}
	if _, _, err := c.Open(songID); !errors.Is(err, ErrNotReady) {
		t.Errorf("Open = %v, want ErrNotReady", err)
	}

	// A failed song is worth another try: the next ask re-resolves it.
	resolver.downloadErr = nil
	resolver.payload = "ftypaudio"
	if _, err := c.Request(context.Background(), suno.SongPageURL(songID)); err != nil {
		t.Fatalf("retry: %v", err)
	}
	waitForStatus(t, c, songID, StatusReady)
}

func TestRequestReportsResolveFailure(t *testing.T) {
	resolver := &fakeResolver{resolveErr: errors.New("Suno playlists aren't supported.")}
	c := newCache(t, resolver, time.Now)

	_, err := c.Request(context.Background(), "https://suno.com/playlist/chill")
	if err == nil || err.Error() != "Suno playlists aren't supported." {
		t.Errorf("error = %v, want the resolver's message passed through", err)
	}
}

func TestRequestKeepsTheUnpublishedSentinel(t *testing.T) {
	resolver := &fakeResolver{resolveErr: suno.ErrNotPublished}
	c := newCache(t, resolver, time.Now)

	_, err := c.Request(context.Background(), suno.SongPageURL(songID))
	if !errors.Is(err, suno.ErrNotPublished) {
		t.Errorf("error = %v, want ErrNotPublished", err)
	}
	if _, ok := c.Get(songID); ok {
		t.Error("a song that cannot be downloaded must not be indexed")
	}
}

func TestLoadRestoresUnexpiredSongsOnly(t *testing.T) {
	resolver := &fakeResolver{payload: "ftypaudio"}
	dir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := time.Now()

	first, err := New(Options{Dir: dir, Resolver: resolver, Now: func() time.Time { return clock }, Logger: logger})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := first.Request(context.Background(), suno.SongPageURL(songID)); err != nil {
		t.Fatalf("Request: %v", err)
	}
	waitForStatus(t, first, songID, StatusReady)
	first.Close()

	// A restart inside the lifetime keeps the song, without a new download.
	restarted, err := New(Options{Dir: dir, Resolver: resolver, Now: func() time.Time { return clock }, Logger: logger})
	if err != nil {
		t.Fatalf("New after restart: %v", err)
	}
	if entry, ok := restarted.Get(songID); !ok || entry.Status != StatusReady {
		t.Fatalf("song was not restored: %+v", entry)
	}
	restarted.Close()

	// A restart after the lifetime drops it from disk.
	clock = clock.Add(25 * time.Hour)
	late, err := New(Options{Dir: dir, Resolver: resolver, Now: func() time.Time { return clock }, Logger: logger})
	if err != nil {
		t.Fatalf("New after expiry: %v", err)
	}
	defer late.Close()
	if _, ok := late.Get(songID); ok {
		t.Error("expired song survived a restart")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("cache dir still holds %d files", len(entries))
	}
}
