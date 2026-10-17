package suno

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"time"
)

const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// ErrNoPlayableAudio means every candidate was missing, unreachable, or encrypted.
var ErrNoPlayableAudio = errors.New("couldn't find playable audio for this Suno song")

// ErrNotPublished means the song page says the song is private, which is why it
// offers no plain media file. Only the DJ can fix that, on Suno.
var ErrNotPublished = errors.New("That Suno song isn't published yet. Publish it on Suno, then add it again.")

// Song is one resolved song and the media URLs worth trying, best first.
type Song struct {
	ID          string
	PageURL     string
	Title       string
	Artwork     string
	DurationSec float64
	Candidates  []string
}

// Resolver reads song pages and downloads song media. The zero value is usable.
type Resolver struct {
	// HTTP defaults to a client with a 30s timeout that follows redirects.
	HTTP *http.Client
}

func (r *Resolver) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

// Resolve fetches the song page for a song or short link and reads its metadata.
// Playlists, profiles and anything else fail without a request.
func (r *Resolver) Resolve(ctx context.Context, raw string) (Song, error) {
	link := ParseLink(raw)
	switch link.Kind {
	case KindSong, KindShort:
	default:
		return Song{}, LinkError(link.Kind)
	}

	target := strings.TrimSpace(raw)
	if link.Kind == KindSong {
		target = SongPageURL(link.UUID)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return Song{}, errors.New("couldn't load that Suno song")
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "text/html")

	res, err := r.client().Do(req)
	if err != nil {
		return Song{}, errors.New("couldn't load that Suno song")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return Song{}, fmt.Errorf("couldn't load that Suno song (%d)", res.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return Song{}, errors.New("couldn't load that Suno song")
	}

	resolved := songIDFrom(finalURL(res, target), string(body))
	if resolved.Kind != KindSong {
		kind := resolved.Kind
		if link.Kind == KindShort && kind == KindOther {
			kind = KindShort
		}
		return Song{}, LinkError(kind)
	}

	page := ParsePage(string(body), resolved.UUID)
	song := Song{
		ID:          resolved.UUID,
		PageURL:     SongPageURL(resolved.UUID),
		Title:       page.Title,
		Artwork:     page.Artwork,
		DurationSec: page.DurationSec,
	}
	for _, candidate := range []string{page.M4AURL, page.MP4URL} {
		if candidate != "" {
			song.Candidates = append(song.Candidates, candidate)
		}
	}
	// The cloudfront clip is encrypted, so the mp4 is the only candidate that can
	// actually play: a page without one offers nothing, however much it lists.
	// An unpublished song is never given an mp4, and only the DJ can fix that; a
	// public song without one is a page shape we no longer understand, which is
	// not the DJ's problem to fix.
	if page.MP4URL == "" {
		if page.IsPublic != nil && !*page.IsPublic {
			return song, ErrNotPublished
		}
		return song, ErrNoPlayableAudio
	}
	return song, nil
}

// Download copies the first candidate whose first bytes are an `ftyp` box into dst
// and reports its content type. A candidate that is encrypted or unreachable is
// skipped; nothing partial is ever written for the candidate that wins, because the
// header is buffered before dst is touched.
func (r *Resolver) Download(ctx context.Context, song Song, dst io.Writer) (string, error) {
	var failures []error
	for _, candidate := range song.Candidates {
		contentType, err := r.downloadOne(ctx, candidate, dst)
		if err == nil {
			return contentType, nil
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		failures = append(failures, fmt.Errorf("%s: %w", candidate, err))
	}
	return "", errors.Join(append(failures, ErrNoPlayableAudio)...)
}

func (r *Resolver) downloadOne(ctx context.Context, mediaURL string, dst io.Writer) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, mediaURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)

	res, err := r.client().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", fmt.Errorf("status %d", res.StatusCode)
	}

	header := make([]byte, 16)
	n, err := io.ReadFull(res.Body, header)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return "", err
	}
	header = header[:n]
	if !isPlainContainer(header) {
		return "", errors.New("not a media container")
	}

	if _, err := dst.Write(header); err != nil {
		return "", err
	}
	if _, err := io.Copy(dst, res.Body); err != nil {
		return "", err
	}
	return contentTypeFor(res, mediaURL), nil
}

// finalURL is where the request landed after redirects, which is how a short
// link reveals its song.
func finalURL(res *http.Response, requested string) string {
	if res.Request != nil && res.Request.URL != nil {
		return res.Request.URL.String()
	}
	return requested
}

// isPlainContainer reports whether head starts with an ISO base media `ftyp` box.
// The encrypted cloudfront clip does not, which is how it gets rejected.
func isPlainContainer(head []byte) bool {
	return len(head) >= 8 && bytes.Equal(head[4:8], []byte("ftyp"))
}

func contentTypeFor(res *http.Response, mediaURL string) string {
	if ct := res.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "text/") {
		return ct
	}
	switch strings.ToLower(path.Ext(mediaURL)) {
	case ".m4a", ".mp4":
		return "audio/mp4"
	default:
		return "application/octet-stream"
	}
}
