package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bike-shed-io/vibez/suno-proxy/internal/cache"
	"github.com/bike-shed-io/vibez/suno-proxy/internal/suno"
)

const (
	songID = "6d6536c7-4e24-405c-8d6d-0c4e1c4ee981"
	token  = "s3cret-dj-token"
	audio  = "ftypM4A  plenty-of-audio-bytes"
)

type fakeResolver struct {
	resolves    int
	payload     string
	resolveErr  error
	downloadErr error
}

func (f *fakeResolver) Resolve(context.Context, string) (suno.Song, error) {
	f.resolves++
	if f.resolveErr != nil {
		return suno.Song{ID: songID, PageURL: suno.SongPageURL(songID)}, f.resolveErr
	}
	return suno.Song{
		ID:         songID,
		PageURL:    suno.SongPageURL(songID),
		Title:      "Raised on Rewind & Friends",
		Candidates: []string{"https://cdn1.suno.ai/" + songID + ".mp4"},
	}, nil
}

func (f *fakeResolver) Download(_ context.Context, _ suno.Song, dst io.Writer) (string, error) {
	if f.downloadErr != nil {
		return "", f.downloadErr
	}
	_, err := io.WriteString(dst, f.payload)
	return "video/mp4", err
}

func newServer(t *testing.T) (http.Handler, *cache.Cache, *fakeResolver) {
	t.Helper()
	resolver := &fakeResolver{payload: audio}
	store, err := cache.New(cache.Options{
		Dir:      t.TempDir(),
		Resolver: resolver,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(store.Close)

	handler, err := New(Options{
		Cache:         store,
		Token:         token,
		PublicBaseURL: "https://suno-proxy.example/",
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return handler, store, resolver
}

func addSong(t *testing.T, handler http.Handler, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	body := strings.NewReader(`{"url":"` + suno.SongPageURL(songID) + `"}`)
	req := httptest.NewRequest(http.MethodPost, "/songs", body)
	if bearer != "" {
		req.Header.Set("Authorization", bearer)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

// cacheSong adds a song and waits for its file, the way Vibez waits before it
// puts a track on air.
func cacheSong(t *testing.T, handler http.Handler, store *cache.Cache) {
	t.Helper()
	if res := addSong(t, handler, "Bearer "+token); res.Code != http.StatusOK {
		t.Fatalf("POST /songs = %d, want 200", res.Code)
	}
	waitForStatus(t, store, cache.StatusReady)
}

func waitForStatus(t *testing.T, store *cache.Cache, want cache.Status) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if entry, ok := store.Get(songID); ok && entry.Status == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("song never reached %q", want)
}

func TestAddSongRequiresTheToken(t *testing.T) {
	handler, _, resolver := newServer(t)

	tests := map[string]string{
		"no header":    "",
		"wrong token":  "Bearer nope",
		"not a bearer": token,
		"empty bearer": "Bearer ",
	}
	for name, bearer := range tests {
		t.Run(name, func(t *testing.T) {
			res := addSong(t, handler, bearer)
			if res.Code != http.StatusUnauthorized {
				t.Errorf("status = %d, want 401", res.Code)
			}
		})
	}
	if resolver.resolves != 0 {
		t.Errorf("resolved %d times, want nothing downloaded without the token", resolver.resolves)
	}
}

func TestAuthChecksTheToken(t *testing.T) {
	handler, _, _ := newServer(t)

	tests := map[string]int{
		"Bearer " + token: http.StatusOK,
		"Bearer nope":     http.StatusUnauthorized,
		"":                http.StatusUnauthorized,
	}
	for bearer, want := range tests {
		req := httptest.NewRequest(http.MethodGet, "/auth", nil)
		if bearer != "" {
			req.Header.Set("Authorization", bearer)
		}
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != want {
			t.Errorf("GET /auth with %q = %d, want %d", bearer, res.Code, want)
		}
	}
}

func TestAddSongReturnsTheAudioURL(t *testing.T) {
	handler, _, _ := newServer(t)

	res := addSong(t, handler, "Bearer "+token)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.Code)
	}
	var body songResponse
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.ID != songID {
		t.Errorf("id = %q", body.ID)
	}
	if want := "https://suno-proxy.example/audio/" + songID; body.AudioURL != want {
		t.Errorf("audioUrl = %q, want %q", body.AudioURL, want)
	}
	if body.Title != "Raised on Rewind & Friends" {
		t.Errorf("title = %q, want metadata for the DJ's queue", body.Title)
	}
}

// An unpublished song has to be refused as it is added, so the DJ hears about it
// while they are queueing rather than when the track is due on air.
func TestAddSongPassesTheUnpublishedComplaintToTheDJ(t *testing.T) {
	handler, store, resolver := newServer(t)
	resolver.resolveErr = suno.ErrNotPublished

	res := addSong(t, handler, "Bearer "+token)
	if res.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", res.Code)
	}
	var body songResponse
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error != suno.ErrNotPublished.Error() {
		t.Errorf("error = %q, want %q", body.Error, suno.ErrNotPublished)
	}
	if body.Status == cache.StatusQueued {
		t.Error("a song that cannot play must not come back as queued")
	}
	if entry, ok := store.Get(songID); ok {
		t.Errorf("cached %+v, want nothing taken on", entry)
	}
}

func TestSongStatusReportsWhyADownloadFailed(t *testing.T) {
	handler, store, resolver := newServer(t)
	resolver.downloadErr = suno.ErrNoPlayableAudio

	if res := addSong(t, handler, "Bearer "+token); res.Code != http.StatusOK {
		t.Fatalf("POST /songs = %d, want 200", res.Code)
	}
	waitForStatus(t, store, cache.StatusFailed)

	req := httptest.NewRequest(http.MethodGet, "/songs/"+songID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	var body songResponse
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Status != cache.StatusFailed {
		t.Errorf("status = %q, want %q", body.Status, cache.StatusFailed)
	}
	if !strings.Contains(body.Error, suno.ErrNoPlayableAudio.Error()) {
		t.Errorf("error = %q, want the download's complaint", body.Error)
	}
}

func TestAddSongRejectsAMissingURL(t *testing.T) {
	handler, _, _ := newServer(t)

	req := httptest.NewRequest(http.MethodPost, "/songs", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", res.Code)
	}
}

func TestSongStatusNeedsTheTokenAndReportsReady(t *testing.T) {
	handler, store, _ := newServer(t)

	req := httptest.NewRequest(http.MethodGet, "/songs/"+songID, nil)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated status = %d, want 401", res.Code)
	}

	cacheSong(t, handler, store)

	req = httptest.NewRequest(http.MethodGet, "/songs/"+songID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.Code)
	}
	var body songResponse
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Status != cache.StatusReady {
		t.Errorf("status = %q, want %q", body.Status, cache.StatusReady)
	}
	if body.ExpiresAt == "" {
		t.Error("a ready song should report when it expires")
	}
}

func TestAudioIsPublicAndSupportsRange(t *testing.T) {
	handler, store, resolver := newServer(t)
	cacheSong(t, handler, store)

	// No Authorization header: a listener is anonymous.
	req := httptest.NewRequest(http.MethodGet, "/audio/"+songID, nil)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 without a token", res.Code)
	}
	if res.Body.String() != audio {
		t.Errorf("body = %q, want the cached song", res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "video/mp4" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := res.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Errorf("Accept-Ranges = %q", got)
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want * for the web player", got)
	}

	// Seeking in the player sends a Range request.
	req = httptest.NewRequest(http.MethodGet, "/audio/"+songID, nil)
	req.Header.Set("Range", "bytes=4-7")
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", res.Code)
	}
	if res.Body.String() != audio[4:8] {
		t.Errorf("range body = %q, want %q", res.Body.String(), audio[4:8])
	}
	if got := res.Header().Get("Content-Range"); got == "" {
		t.Error("a partial response needs Content-Range")
	}

	if resolver.resolves != 1 {
		t.Errorf("resolved %d times, want listeners to never trigger a download", resolver.resolves)
	}
}

func TestAudioNeverStartsADownload(t *testing.T) {
	handler, _, resolver := newServer(t)

	req := httptest.NewRequest(http.MethodGet, "/audio/"+songID, nil)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 for a song nobody cached", res.Code)
	}
	if resolver.resolves != 0 {
		t.Errorf("resolved %d times, want an anonymous request to fetch nothing", resolver.resolves)
	}
}

func TestNewRequiresAToken(t *testing.T) {
	store, err := cache.New(cache.Options{
		Dir:      t.TempDir(),
		Resolver: &fakeResolver{},
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	defer store.Close()

	if _, err := New(Options{Cache: store}); err == nil {
		t.Error("a proxy without an access token must not start")
	}
}
