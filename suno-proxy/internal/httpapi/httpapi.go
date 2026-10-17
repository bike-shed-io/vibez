// Package httpapi is the proxy's HTTP surface.
//
// Telling the proxy to cache a song needs the static access token. Playing a
// cached song does not: listeners are anonymous, exactly as they are with
// SoundCloud, and /audio/{id} only ever serves a file that is already on disk.
package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/bike-shed-io/vibez/suno-proxy/internal/cache"
)

// Options configures [New].
type Options struct {
	Cache *cache.Cache
	// Token is the shared DJ access token. An empty token is refused by [New].
	Token string
	// PublicBaseURL makes audio URLs absolute, e.g. https://suno.example.
	// Empty leaves them site-relative.
	PublicBaseURL string
	Logger        *slog.Logger
}

type server struct {
	cache      *cache.Cache
	token      []byte
	publicBase string
	log        *slog.Logger
}

type songResponse struct {
	ID          string       `json:"id"`
	Status      cache.Status `json:"status"`
	AudioURL    string       `json:"audioUrl"`
	PageURL     string       `json:"pageUrl"`
	Title       string       `json:"title,omitempty"`
	Artwork     string       `json:"artwork,omitempty"`
	DurationSec float64      `json:"durationSec,omitempty"`
	Error       string       `json:"error,omitempty"`
	ExpiresAt   string       `json:"expiresAt,omitempty"`
}

// New builds the router.
func New(opts Options) (http.Handler, error) {
	if opts.Cache == nil {
		return nil, errors.New("httpapi: Cache is required")
	}
	if opts.Token == "" {
		return nil, errors.New("httpapi: Token is required")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	s := &server{
		cache:      opts.Cache,
		token:      []byte(opts.Token),
		publicBase: strings.TrimSuffix(opts.PublicBaseURL, "/"),
		log:        opts.Logger,
	}

	mux := http.NewServeMux()
	// Lets Vibez check a DJ's token before it commits a room to Suno.
	mux.Handle("GET /auth", s.authenticated(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	mux.Handle("POST /songs", s.authenticated(s.addSong))
	mux.Handle("GET /songs/{id}", s.authenticated(s.songStatus))
	mux.HandleFunc("GET /audio/{id}", s.audio)
	mux.HandleFunc("HEAD /audio/{id}", s.audio)
	mux.HandleFunc("OPTIONS /audio/{id}", s.audioPreflight)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ok\n"))
	})
	return mux, nil
}

// authenticated gates the DJ-only routes behind the static token.
func (s *server) authenticated(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.tokenOK(r.Header.Get("Authorization")) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Suno access token required"})
			return
		}
		next(w, r)
	})
}

func (s *server) tokenOK(header string) bool {
	presented, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(strings.TrimSpace(presented)), s.token) == 1
}

func (s *server) addSong(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Expected a JSON body with a url"})
		return
	}
	if strings.TrimSpace(body.URL) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "URL is required"})
		return
	}

	entry, err := s.cache.Request(r.Context(), body.URL)
	if err != nil {
		// Link and page problems are the DJ's to fix, so the message is theirs to read.
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.describe(entry))
}

func (s *server) songStatus(w http.ResponseWriter, r *http.Request) {
	entry, ok := s.cache.Get(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "That song is not cached"})
		return
	}
	writeJSON(w, http.StatusOK, s.describe(entry))
}

// audio serves a finished song. It never starts a download, so an unknown id is
// just a 404 and an anonymous listener cannot make the proxy fetch anything.
func (s *server) audio(w http.ResponseWriter, r *http.Request) {
	file, entry, err := s.cache.Open(r.PathValue("id"))
	if err != nil {
		allowAnyOrigin(w)
		http.Error(w, "Not cached", http.StatusNotFound)
		return
	}
	defer file.Close()

	allowAnyOrigin(w)
	w.Header().Set("Accept-Ranges", "bytes")
	if entry.ContentType != "" {
		w.Header().Set("Content-Type", entry.ContentType)
	}
	// Browsers may keep a song for as long as the proxy will.
	w.Header().Set("Cache-Control", "public, max-age="+durationSeconds(entry.ExpiresAt))
	// An empty name leaves the Content-Type above alone; ServeContent still
	// handles Range, If-Range and HEAD.
	http.ServeContent(w, r, "", entry.DownloadedAt, file)
}

func (s *server) audioPreflight(w http.ResponseWriter, _ *http.Request) {
	allowAnyOrigin(w)
	w.Header().Set("Access-Control-Allow-Headers", "Range")
	w.Header().Set("Access-Control-Max-Age", "86400")
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) describe(entry cache.Entry) songResponse {
	res := songResponse{
		ID:          entry.ID,
		Status:      entry.Status,
		AudioURL:    s.publicBase + "/audio/" + entry.ID,
		PageURL:     entry.PageURL,
		Title:       entry.Title,
		Artwork:     entry.Artwork,
		DurationSec: entry.DurationSec,
		Error:       entry.Error,
	}
	if !entry.ExpiresAt.IsZero() {
		res.ExpiresAt = entry.ExpiresAt.UTC().Format(time.RFC3339)
	}
	return res
}

func allowAnyOrigin(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
}

func durationSeconds(expires time.Time) string {
	return strconv.FormatInt(max(int64(time.Until(expires).Seconds()), 0), 10)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}
