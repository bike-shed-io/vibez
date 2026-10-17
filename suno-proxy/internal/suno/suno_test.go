package suno

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

const (
	uuid      = "6d6536c7-4e24-405c-8d6d-0c4e1c4ee981"
	otherUUID = "4e7a04bb-bd77-4b39-b6dc-c0cdfa5d2860"
)

// lyrics is the slab of clip metadata a real page carries between a song id and
// its publication flag, which is what puts the flag out of reach of a window
// around the id.
var lyrics = `\"prompt\":\"` + strings.Repeat("raised on rewind and ready to roll ", 100) + `\"`

// songPage mirrors a real published song page: a silent decoy, a forbidden
// studio audio_url, an encrypted cloudfront clip, the cdn1 mp4 that is the only
// file that actually plays, and another clip's media. As on the real page, the
// publication flag sits far behind the song id.
func songPage(id string) string {
	return `<!doctype html>
	<link rel="canonical" href="https://suno.com/song/` + id + `">
	<meta property="og:audio" content="https://cdn-o.suno.com/sil-100.mp3" />
	<meta property="og:title" content="Raised on Rewind &amp; Friends" />
	<meta property="og:image" content="https://cdn2.suno.ai/` + id + `_cover.jpeg" />
	\"audio_url\":\"https://studio-api.prod.suno.com/api/forbidden\"
	\"video_url\":\"https://cdn1.suno.ai/` + id + `.mp4\"
	\"media_urls\":[{\"url\":\"https://d2lwuy8qc234o3.cloudfront.net/1/clip/` + id + `.m4a\",\"content_type\":\"m4a-opus\"}]
	\"id\":\"` + id + `\",\"metadata\":{\"duration\":220.64},` + lyrics + `,\"is_public\":true
	\"url\":\"https://d2lwuy8qc234o3.cloudfront.net/2/clip/` + otherUUID + `.m4a\"
	\"video_url\":\"https://cdn1.suno.ai/` + otherUUID + `.mp4\"`
}

// pageWithoutMP4 mirrors a real unpublished song page: the encrypted cloudfront
// clip is still listed, but video_url is empty and no cdn1 mp4 appears anywhere,
// so nothing the page offers can be played. isPublic is the literal the page
// carries, `true` or `false`, or empty for a page that never says.
func pageWithoutMP4(id, isPublic string) string {
	flag := ""
	if isPublic != "" {
		flag = `,\"is_public\":` + isPublic
	}
	return `<!doctype html>
	<link rel="canonical" href="https://suno.com/song/` + id + `">
	<meta property="og:title" content="Raised on Rewind &amp; Friends" />
	<meta property="og:image" content="https://cdn2.suno.ai/` + id + `_cover.jpeg" />
	\"audio_url\":\"https://studio-api.prod.suno.com/api/forbidden\"
	\"video_url\":\"\"
	\"media_urls\":[{\"url\":\"https://d2lwuy8qc234o3.cloudfront.net/1/clip/` + id + `.m4a\",\"content_type\":\"m4a-opus\"}]
	\"id\":\"` + id + `\",\"metadata\":{\"duration\":220.64},` + lyrics + flag
}

// pageWithoutMedia is a page that offers nothing downloadable at all, not even
// the encrypted clip.
func pageWithoutMedia(id, isPublic string) string {
	return `<!doctype html>
	<link rel="canonical" href="https://suno.com/song/` + id + `">
	<meta property="og:title" content="Raised on Rewind &amp; Friends" />
	<meta property="og:image" content="https://cdn2.suno.ai/` + id + `_cover.jpeg" />
	\"audio_url\":\"https://studio-api.prod.suno.com/api/forbidden\"
	\"video_url\":\"\"
	\"id\":\"` + id + `\",\"is_public\":` + isPublic + `,\"metadata\":{\"duration\":220.64}`
}

// pageWithTwoClips carries this song next to a neighbour that is published
// differently, so the page as a whole does not say one thing about publication.
func pageWithTwoClips(id string) string {
	return `<!doctype html>
	<link rel="canonical" href="https://suno.com/song/` + id + `">
	\"id\":\"` + id + `\",\"metadata\":{\"duration\":220.64},` + lyrics + `,\"is_public\":false
	\"id\":\"` + otherUUID + `\",\"title\":\"Someone else's song\",` + lyrics + `,\"is_public\":true`
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func respond(req *http.Request, status int, contentType, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": {contentType}},
		Body:       newBody(body),
		Request:    req,
	}
}

func newBody(body string) *bodyCloser { return &bodyCloser{Reader: strings.NewReader(body)} }

type bodyCloser struct{ *strings.Reader }

func (b *bodyCloser) Close() error { return nil }

func ftypBytes() string {
	header := []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'M', '4', 'A', ' ', 0, 0, 0, 0}
	return string(header) + "audio-payload"
}

func TestParseLink(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want Link
	}{
		{"song", "https://suno.com/song/" + uuid, Link{Kind: KindSong, UUID: uuid}},
		{"upper with query", "https://www.suno.com/song/" + strings.ToUpper(uuid) + "/?si=1", Link{Kind: KindSong, UUID: uuid}},
		{"legacy host", "https://app.suno.ai/song/" + uuid, Link{Kind: KindSong, UUID: uuid}},
		{"short", "https://suno.com/s/Ab12", Link{Kind: KindShort, Code: "Ab12"}},
		{"playlist", "https://suno.com/playlist/chill", Link{Kind: KindPlaylist}},
		{"playlists", "https://suno.com/playlists/chill", Link{Kind: KindPlaylist}},
		{"profile at", "https://suno.com/@necthan", Link{Kind: KindProfile}},
		{"profile path", "https://www.suno.com/profile/necthan", Link{Kind: KindProfile}},
		{"other page", "https://suno.com/pricing", Link{Kind: KindOther}},
		{"not suno", "https://soundcloud.com/artist/track", Link{Kind: KindOther}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseLink(tc.raw); got != tc.want {
				t.Errorf("ParseLink(%q) = %+v, want %+v", tc.raw, got, tc.want)
			}
		})
	}

	if !IsSunoURL("https://suno.com/playlist/chill") {
		t.Error("IsSunoURL should accept any Suno host")
	}
	if IsSunoURL("https://soundcloud.com/artist/track") {
		t.Error("IsSunoURL should reject SoundCloud")
	}
}

func TestParsePage(t *testing.T) {
	page := ParsePage(songPage(uuid), uuid)

	if page.Title != "Raised on Rewind & Friends" {
		t.Errorf("title = %q", page.Title)
	}
	if want := "https://cdn2.suno.ai/" + uuid + "_cover.jpeg"; page.Artwork != want {
		t.Errorf("artwork = %q, want %q", page.Artwork, want)
	}
	if page.DurationSec != 220.64 {
		t.Errorf("duration = %v, want 220.64", page.DurationSec)
	}
	if want := "https://d2lwuy8qc234o3.cloudfront.net/1/clip/" + uuid + ".m4a"; page.M4AURL != want {
		t.Errorf("m4a = %q, want %q", page.M4AURL, want)
	}
	if want := "https://cdn1.suno.ai/" + uuid + ".mp4"; page.MP4URL != want {
		t.Errorf("mp4 = %q, want %q", page.MP4URL, want)
	}
	for _, decoy := range []string{otherUUID, "sil-100", "forbidden"} {
		if strings.Contains(page.M4AURL+page.MP4URL, decoy) {
			t.Errorf("picked up decoy %q", decoy)
		}
	}
	if strings.HasSuffix(page.MP4URL, ".mp3") {
		t.Error("picked up the retired mp3 path")
	}
	if page.IsPublic == nil || !*page.IsPublic {
		t.Errorf("isPublic = %v, want true", page.IsPublic)
	}
}

func TestParsePageReadsPublication(t *testing.T) {
	// Both real shapes carry the flag far behind the song id, past the lyrics.
	published := ParsePage(songPage(uuid), uuid)
	if published.IsPublic == nil || !*published.IsPublic {
		t.Errorf("isPublic = %v, want true on the published page", published.IsPublic)
	}
	private := ParsePage(pageWithoutMP4(uuid, "false"), uuid)
	if private.IsPublic == nil || *private.IsPublic {
		t.Errorf("isPublic = %v, want false on the unpublished page", private.IsPublic)
	}

	// A page that never says must stay unknown, so nothing is blamed on the DJ.
	silent := ParsePage(`<link rel="canonical" href="https://suno.com/song/`+uuid+`">`, uuid)
	if silent.IsPublic != nil {
		t.Errorf("isPublic = %v, want unknown", *silent.IsPublic)
	}
}

func TestParsePageReadsThisClipsPublicationNotTheNeighbours(t *testing.T) {
	page := ParsePage(pageWithTwoClips(uuid), uuid)
	if page.IsPublic == nil || *page.IsPublic {
		t.Errorf("isPublic = %v, want this song's own false", page.IsPublic)
	}

	neighbour := ParsePage(pageWithTwoClips(uuid), otherUUID)
	if neighbour.IsPublic == nil || !*neighbour.IsPublic {
		t.Errorf("isPublic = %v, want the neighbour's own true", neighbour.IsPublic)
	}
}

func TestParsePageReadsPublicationStatedAheadOfTheSongID(t *testing.T) {
	ahead := `\"is_public\":false,` + lyrics + `,\"id\":\"` + uuid + `\"`
	page := ParsePage(ahead, uuid)
	if page.IsPublic == nil || *page.IsPublic {
		t.Errorf("isPublic = %v, want false from the page's only flag", page.IsPublic)
	}

	// Once the page disagrees with itself there is no flag ahead of the id that
	// can be shown to be this song's, so nothing is blamed on the DJ.
	disputed := ParsePage(`\"is_public\":true,`+ahead, uuid)
	if disputed.IsPublic != nil {
		t.Errorf("isPublic = %v, want unknown rather than a borrowed flag", *disputed.IsPublic)
	}
}

func TestParsePageIgnoresOtherClipsMedia(t *testing.T) {
	page := ParsePage(songPage(otherUUID), uuid)

	if page.M4AURL != "" || page.MP4URL != "" {
		t.Errorf("borrowed another clip's media: %+v", page)
	}
	if page.DurationSec != 0 {
		t.Errorf("duration = %v, want 0", page.DurationSec)
	}
	if page.IsPublic != nil {
		t.Errorf("borrowed another clip's publication flag: %v", *page.IsPublic)
	}
}

func TestResolveRejectsLinksWithoutARequest(t *testing.T) {
	resolver := &Resolver{HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		t.Errorf("unexpected request to %s", r.URL)
		return nil, errors.New("should not be called")
	})}}

	tests := map[string]string{
		"https://suno.com/playlist/chill": "Suno playlists aren't supported.",
		"https://suno.com/@necthan":       "Suno profiles aren't supported.",
		"https://suno.com/pricing":        "That Suno link isn't a song.",
	}
	for raw, want := range tests {
		if _, err := resolver.Resolve(context.Background(), raw); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Resolve(%q) error = %v, want %q", raw, err, want)
		}
	}
}

func TestResolveFollowsShortLink(t *testing.T) {
	var requested []string
	resolver := &Resolver{HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requested = append(requested, r.URL.String())
		// The short link lands on the song page after redirects.
		landed := r.Clone(r.Context())
		landed.URL.Path = "/song/" + uuid
		return respond(landed, http.StatusOK, "text/html", songPage(uuid)), nil
	})}}

	song, err := resolver.Resolve(context.Background(), "https://suno.com/s/Ab12")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(requested) != 1 || requested[0] != "https://suno.com/s/Ab12" {
		t.Errorf("requested = %v", requested)
	}
	if song.ID != uuid {
		t.Errorf("id = %q, want %q", song.ID, uuid)
	}
	if song.PageURL != "https://suno.com/song/"+uuid {
		t.Errorf("pageURL = %q", song.PageURL)
	}
	if song.Title != "Raised on Rewind & Friends" || song.DurationSec != 220.64 {
		t.Errorf("metadata = %+v", song)
	}
	if len(song.Candidates) != 2 || !strings.HasSuffix(song.Candidates[0], ".m4a") {
		t.Errorf("candidates = %v, want the m4a first", song.Candidates)
	}
}

func TestResolveRejectsShortLinkThatMissesASong(t *testing.T) {
	resolver := &Resolver{HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		landed := r.Clone(r.Context())
		landed.URL.Path = "/"
		return respond(landed, http.StatusOK, "text/html", "<html></html>"), nil
	})}}

	_, err := resolver.Resolve(context.Background(), "https://suno.com/s/nope")
	if err == nil || !strings.Contains(err.Error(), "That Suno short link didn't resolve to a song.") {
		t.Errorf("error = %v", err)
	}
}

func TestResolveReportsPageFailure(t *testing.T) {
	resolver := &Resolver{HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return respond(r, http.StatusForbidden, "text/html", "denied"), nil
	})}}

	_, err := resolver.Resolve(context.Background(), "https://suno.com/song/"+uuid)
	if err == nil || !strings.Contains(err.Error(), "(403)") {
		t.Errorf("error = %v, want the status", err)
	}
}

// An unpublished page still lists the encrypted cloudfront clip, so the song has
// a candidate and the complaint has to come from the missing mp4 instead.
func TestResolveReportsAnUnpublishedSong(t *testing.T) {
	resolver := &Resolver{HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return respond(r, http.StatusOK, "text/html", pageWithoutMP4(uuid, "false")), nil
	})}}

	song, err := resolver.Resolve(context.Background(), "https://suno.com/song/"+uuid)
	if !errors.Is(err, ErrNotPublished) {
		t.Fatalf("error = %v, want ErrNotPublished", err)
	}
	if errors.Is(err, ErrNoPlayableAudio) {
		t.Error("an unpublished song must not be reported as a missing file")
	}
	if !strings.Contains(err.Error(), "Publish it on Suno") {
		t.Errorf("error = %q, want it to tell the DJ what to do", err)
	}
	if len(song.Candidates) != 1 || !strings.HasSuffix(song.Candidates[0], ".m4a") {
		t.Errorf("candidates = %v, want the encrypted clip the page really lists", song.Candidates)
	}
	// The DJ still gets the song back, so the failure can name it.
	if song.ID != uuid || song.Title != "Raised on Rewind & Friends" {
		t.Errorf("song = %+v, want its metadata alongside the error", song)
	}
}

func TestResolveReportsNoPlayableAudioForAPublicSong(t *testing.T) {
	for name, page := range map[string]string{
		"encrypted clip only":   pageWithoutMP4(uuid, "true"),
		"no media":              pageWithoutMedia(uuid, "true"),
		"unknown with a clip":   pageWithoutMP4(uuid, ""),
		"unknown with no media": `<link rel="canonical" href="https://suno.com/song/` + uuid + `">`,
	} {
		t.Run(name, func(t *testing.T) {
			resolver := &Resolver{HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return respond(r, http.StatusOK, "text/html", page), nil
			})}}

			_, err := resolver.Resolve(context.Background(), "https://suno.com/song/"+uuid)
			if !errors.Is(err, ErrNoPlayableAudio) {
				t.Fatalf("error = %v, want ErrNoPlayableAudio", err)
			}
			if errors.Is(err, ErrNotPublished) {
				t.Error("only a page that said the song is private may blame publication")
			}
		})
	}
}

func TestResolveThenDownloadPublishedSong(t *testing.T) {
	resolver := &Resolver{HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch {
		case strings.HasSuffix(r.URL.Path, ".m4a"):
			return respond(r, http.StatusOK, "audio/mp4", strings.Repeat("\x9e", 32)), nil
		case strings.HasSuffix(r.URL.Path, ".mp4"):
			return respond(r, http.StatusOK, "video/mp4", ftypBytes()), nil
		}
		return respond(r, http.StatusOK, "text/html", songPage(uuid)), nil
	})}}

	song, err := resolver.Resolve(context.Background(), "https://suno.com/song/"+uuid)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	var out bytes.Buffer
	if _, err := resolver.Download(context.Background(), song, &out); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if out.String() != ftypBytes() {
		t.Errorf("wrote %q, want the published song's mp4", out.String())
	}
}

func TestDownloadSkipsEncryptedClip(t *testing.T) {
	var fetched []string
	resolver := &Resolver{HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		fetched = append(fetched, r.URL.String())
		if strings.HasSuffix(r.URL.Path, ".m4a") {
			// The current cloudfront clip answers with encrypted bytes.
			return respond(r, http.StatusOK, "audio/mp4", strings.Repeat("\x9e", 32)), nil
		}
		return respond(r, http.StatusOK, "video/mp4", ftypBytes()), nil
	})}}

	song := Song{ID: uuid, Candidates: []string{
		"https://cdn.example/clip/" + uuid + ".m4a",
		"https://cdn1.suno.ai/" + uuid + ".mp4",
	}}
	var out bytes.Buffer
	contentType, err := resolver.Download(context.Background(), song, &out)
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if len(fetched) != 2 {
		t.Errorf("fetched = %v, want both candidates tried in order", fetched)
	}
	if contentType != "video/mp4" {
		t.Errorf("contentType = %q", contentType)
	}
	if out.String() != ftypBytes() {
		t.Errorf("wrote %q, want the whole mp4 including its header", out.String())
	}
}

func TestDownloadFailsWhenNothingIsPlayable(t *testing.T) {
	resolver := &Resolver{HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, ".m4a") {
			return respond(r, http.StatusOK, "audio/mp4", strings.Repeat("\x9e", 32)), nil
		}
		return respond(r, http.StatusForbidden, "text/plain", "denied"), nil
	})}}

	song := Song{ID: uuid, Candidates: []string{
		"https://cdn.example/clip/" + uuid + ".m4a",
		"https://cdn1.suno.ai/" + uuid + ".mp4",
	}}
	var out bytes.Buffer
	if _, err := resolver.Download(context.Background(), song, &out); !errors.Is(err, ErrNoPlayableAudio) {
		t.Errorf("error = %v, want ErrNoPlayableAudio", err)
	}
	if out.Len() != 0 {
		t.Errorf("wrote %d bytes of unplayable audio", out.Len())
	}
}
