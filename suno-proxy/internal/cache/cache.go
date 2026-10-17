// Package cache keeps one downloaded file per Suno song for a fixed lifetime.
//
// A song is downloaded at most once at a time (singleflight) and at most a few
// songs download at once (semaphore), so a DJ dumping a queue cannot stampede
// Suno. Files are written to a temp file and renamed into place, so a listener
// never opens a half-written song. Everything older than the TTL is deleted by
// a sweeper even if nobody asks for it again.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/semaphore"
	"golang.org/x/sync/singleflight"

	"github.com/bike-shed-io/vibez/suno-proxy/internal/suno"
)

// Status is where a song is in its trip from link to playable file.
type Status string

const (
	// StatusQueued means accepted but waiting for a download slot.
	StatusQueued Status = "queued"
	// StatusDownloading means bytes are moving.
	StatusDownloading Status = "downloading"
	// StatusReady means the whole file is on disk and /audio/{id} will serve it.
	StatusReady Status = "ready"
	// StatusFailed means no candidate was playable. Asking again retries.
	StatusFailed Status = "failed"
)

// ErrNotReady is returned when a song has no finished file to serve.
var ErrNotReady = errors.New("song is not downloaded")

// Entry is one song in the cache. It is also the sidecar file format, so a
// restart can rebuild the index from disk.
type Entry struct {
	ID           string    `json:"id"`
	PageURL      string    `json:"pageUrl"`
	Title        string    `json:"title,omitempty"`
	Artwork      string    `json:"artwork,omitempty"`
	DurationSec  float64   `json:"durationSec,omitempty"`
	Status       Status    `json:"status"`
	Error        string    `json:"error,omitempty"`
	ContentType  string    `json:"contentType,omitempty"`
	Size         int64     `json:"size,omitempty"`
	DownloadedAt time.Time `json:"downloadedAt"`
	ExpiresAt    time.Time `json:"expiresAt"`
}

// Resolver is the Suno half of the cache, swapped out in tests.
type Resolver interface {
	Resolve(ctx context.Context, raw string) (suno.Song, error)
	Download(ctx context.Context, song suno.Song, dst io.Writer) (string, error)
}

// Options configures [New]. Only Dir and Resolver are required.
type Options struct {
	Dir             string
	Resolver        Resolver
	TTL             time.Duration
	MaxDownloads    int64
	DownloadTimeout time.Duration
	Logger          *slog.Logger
	// Now is the clock, overridden in tests to age entries.
	Now func() time.Time
}

// Cache is safe for concurrent use.
type Cache struct {
	dir             string
	resolver        Resolver
	ttl             time.Duration
	downloadTimeout time.Duration
	log             *slog.Logger
	now             func() time.Time

	sem   *semaphore.Weighted
	group singleflight.Group
	mu    sync.RWMutex
	byID  map[string]Entry
	// wg tracks background downloads so Close can wait for them.
	wg sync.WaitGroup
}

// New prepares the cache directory and rebuilds the index from any files that
// survived a restart and are still inside their lifetime.
func New(opts Options) (*Cache, error) {
	if opts.Dir == "" {
		return nil, errors.New("cache: Dir is required")
	}
	if opts.Resolver == nil {
		return nil, errors.New("cache: Resolver is required")
	}
	if opts.TTL <= 0 {
		opts.TTL = 24 * time.Hour
	}
	if opts.MaxDownloads <= 0 {
		opts.MaxDownloads = 3
	}
	if opts.DownloadTimeout <= 0 {
		opts.DownloadTimeout = 5 * time.Minute
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if err := os.MkdirAll(opts.Dir, 0o755); err != nil {
		return nil, fmt.Errorf("cache: %w", err)
	}

	c := &Cache{
		dir:             opts.Dir,
		resolver:        opts.Resolver,
		ttl:             opts.TTL,
		downloadTimeout: opts.DownloadTimeout,
		log:             opts.Logger,
		now:             opts.Now,
		sem:             semaphore.NewWeighted(opts.MaxDownloads),
		byID:            map[string]Entry{},
	}
	c.load()
	return c, nil
}

// TTL is how long a downloaded song is kept.
func (c *Cache) TTL() time.Duration { return c.ttl }

// Request makes sure a song is cached and returns what is known about it now.
// A song already on disk and inside its lifetime is returned without touching
// Suno. Otherwise the metadata is resolved and the download runs in the
// background, so the caller is not held for the length of a download.
func (c *Cache) Request(ctx context.Context, rawURL string) (Entry, error) {
	// A direct song link carries its own id, so a cache hit costs no page fetch.
	if link := suno.ParseLink(rawURL); link.Kind == suno.KindSong {
		if entry, ok := c.Get(link.UUID); ok && entry.Status != StatusFailed {
			return entry, nil
		}
	}

	song, err := c.resolver.Resolve(ctx, rawURL)
	if err != nil {
		return Entry{}, err
	}
	if existing, ok := c.Get(song.ID); ok && existing.Status != StatusFailed {
		return existing, nil
	}

	entry := Entry{
		ID:          song.ID,
		PageURL:     song.PageURL,
		Title:       song.Title,
		Artwork:     song.Artwork,
		DurationSec: song.DurationSec,
		Status:      StatusQueued,
	}
	c.put(entry)
	c.startDownload(song)
	return entry, nil
}

// Get returns a song from the index, treating an expired entry as absent.
func (c *Cache) Get(id string) (Entry, bool) {
	c.mu.RLock()
	entry, ok := c.byID[id]
	c.mu.RUnlock()
	if !ok || c.expired(entry) {
		return Entry{}, false
	}
	return entry, true
}

// Open returns the finished file for a song, for serving to listeners. The file
// stays readable through an in-flight response even if the sweeper deletes it.
func (c *Cache) Open(id string) (*os.File, Entry, error) {
	entry, ok := c.Get(id)
	if !ok || entry.Status != StatusReady {
		return nil, Entry{}, ErrNotReady
	}
	file, err := os.Open(c.audioPath(id))
	if err != nil {
		return nil, Entry{}, errors.Join(ErrNotReady, err)
	}
	return file, entry, nil
}

// Sweep deletes every song past its lifetime and returns how many it removed.
func (c *Cache) Sweep() int {
	c.mu.Lock()
	var stale []string
	for id, entry := range c.byID {
		if c.expired(entry) {
			stale = append(stale, id)
			delete(c.byID, id)
		}
	}
	c.mu.Unlock()

	for _, id := range stale {
		c.removeFiles(id)
		c.log.Info("evicted song", "id", id)
	}
	return len(stale)
}

// Run sweeps on an interval until ctx is done.
func (c *Cache) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.Sweep()
		}
	}
}

// Close waits for background downloads to finish.
func (c *Cache) Close() { c.wg.Wait() }

func (c *Cache) startDownload(song suno.Song) {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		// Deliberately not the request context: the HTTP response returns long
		// before the download does.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), c.downloadTimeout)
		defer cancel()
		if _, err, _ := c.group.Do(song.ID, func() (any, error) {
			return nil, c.download(ctx, song)
		}); err != nil {
			c.log.Error("download failed", "id", song.ID, "err", err)
		}
	}()
}

func (c *Cache) download(ctx context.Context, song suno.Song) error {
	if entry, ok := c.Get(song.ID); ok && entry.Status == StatusReady {
		return nil
	}
	if err := c.sem.Acquire(ctx, 1); err != nil {
		c.fail(song, err)
		return err
	}
	defer c.sem.Release(1)

	c.update(song.ID, func(entry *Entry) { entry.Status = StatusDownloading })

	temp, err := os.CreateTemp(c.dir, song.ID+".part-*")
	if err != nil {
		c.fail(song, err)
		return err
	}
	tempName := temp.Name()
	defer func() {
		temp.Close()
		os.Remove(tempName) // no-op once the rename succeeded
	}()

	contentType, err := c.resolver.Download(ctx, song, temp)
	if err != nil {
		c.fail(song, err)
		return err
	}
	size, err := temp.Seek(0, io.SeekCurrent)
	if err != nil {
		c.fail(song, err)
		return err
	}
	if err := temp.Sync(); err != nil {
		c.fail(song, err)
		return err
	}
	if err := temp.Close(); err != nil {
		c.fail(song, err)
		return err
	}
	// Rename is atomic within the directory, so readers see either nothing or
	// the whole song.
	if err := os.Rename(tempName, c.audioPath(song.ID)); err != nil {
		c.fail(song, err)
		return err
	}

	now := c.now()
	entry := Entry{
		ID:           song.ID,
		PageURL:      song.PageURL,
		Title:        song.Title,
		Artwork:      song.Artwork,
		DurationSec:  song.DurationSec,
		Status:       StatusReady,
		ContentType:  contentType,
		Size:         size,
		DownloadedAt: now,
		ExpiresAt:    now.Add(c.ttl),
	}
	c.put(entry)
	c.writeSidecar(entry)
	c.log.Info("cached song", "id", song.ID, "bytes", size, "expires", entry.ExpiresAt)
	return nil
}

func (c *Cache) fail(song suno.Song, cause error) {
	now := c.now()
	c.put(Entry{
		ID:          song.ID,
		PageURL:     song.PageURL,
		Title:       song.Title,
		Artwork:     song.Artwork,
		DurationSec: song.DurationSec,
		Status:      StatusFailed,
		Error:       cause.Error(),
		ExpiresAt:   now.Add(c.ttl),
	})
}

func (c *Cache) put(entry Entry) {
	c.mu.Lock()
	c.byID[entry.ID] = entry
	c.mu.Unlock()
}

func (c *Cache) update(id string, apply func(*Entry)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.byID[id]
	if !ok {
		return
	}
	apply(&entry)
	c.byID[id] = entry
}

// expired reports whether an entry is past its lifetime. Entries still waiting
// on a download have no expiry yet and never count as expired.
func (c *Cache) expired(entry Entry) bool {
	return !entry.ExpiresAt.IsZero() && c.now().After(entry.ExpiresAt)
}

func (c *Cache) audioPath(id string) string   { return filepath.Join(c.dir, id+".audio") }
func (c *Cache) sidecarPath(id string) string { return filepath.Join(c.dir, id+".json") }

func (c *Cache) removeFiles(id string) {
	for _, path := range []string{c.audioPath(id), c.sidecarPath(id)} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			c.log.Error("could not delete cached file", "path", path, "err", err)
		}
	}
}

func (c *Cache) writeSidecar(entry Entry) {
	data, err := json.Marshal(entry)
	if err != nil {
		c.log.Error("could not encode sidecar", "id", entry.ID, "err", err)
		return
	}
	temp := c.sidecarPath(entry.ID) + ".tmp"
	if err := os.WriteFile(temp, data, 0o644); err != nil {
		c.log.Error("could not write sidecar", "id", entry.ID, "err", err)
		return
	}
	if err := os.Rename(temp, c.sidecarPath(entry.ID)); err != nil {
		c.log.Error("could not write sidecar", "id", entry.ID, "err", err)
	}
}

// load rebuilds the index after a restart. A sidecar is only written once its
// song is fully downloaded, so anything interrupted mid-download is simply
// absent and will be fetched again on demand.
func (c *Cache) load() {
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		c.log.Error("could not read cache dir", "dir", c.dir, "err", err)
		return
	}
	kept := 0
	for _, file := range entries {
		name := file.Name()
		if file.IsDir() || !strings.HasSuffix(name, ".json") {
			if strings.Contains(name, ".part-") {
				os.Remove(filepath.Join(c.dir, name))
			}
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		data, err := os.ReadFile(filepath.Join(c.dir, name))
		if err != nil {
			continue
		}
		var entry Entry
		if err := json.Unmarshal(data, &entry); err != nil || entry.ID != id {
			c.removeFiles(id)
			continue
		}
		if entry.Status != StatusReady || c.expired(entry) {
			c.removeFiles(id)
			continue
		}
		if _, err := os.Stat(c.audioPath(id)); err != nil {
			c.removeFiles(id)
			continue
		}
		c.byID[id] = entry
		kept++
	}
	if kept > 0 {
		c.log.Info("restored cached songs", "count", kept)
	}
}
