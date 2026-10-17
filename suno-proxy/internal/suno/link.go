// Package suno turns a public Suno song link into a downloaded media file.
//
// Suno exposes several URLs per song and most of them are useless to a player:
// `og:audio` is a silent decoy, the studio `audio_url` answers `/api/forbidden`,
// and the cloudfront clip is encrypted on current public songs. Only a file whose
// first bytes are an `ftyp` box is worth keeping, so every candidate is checked
// while it is being downloaded.
//
// Only published songs can be streamed: an unpublished song's page offers no
// mp4 at all, leaving nothing but the encrypted clip, so it fails with
// [ErrNotPublished] instead of a vaguer complaint.
package suno

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// LinkKind is what a pasted Suno URL points at.
type LinkKind string

const (
	KindSong     LinkKind = "song"
	KindShort    LinkKind = "short"
	KindPlaylist LinkKind = "playlist"
	KindProfile  LinkKind = "profile"
	KindOther    LinkKind = "other"
)

const songHint = "Paste a suno.com/song/… or suno.com/s/… link."

var sunoHosts = map[string]bool{
	"suno.com":     true,
	"www.suno.com": true,
	"app.suno.ai":  true,
}

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Link is a parsed Suno URL. UUID is set for [KindSong], Code for [KindShort].
type Link struct {
	Kind LinkKind
	UUID string
	Code string
}

// IsSunoURL reports whether raw is hosted on Suno, whatever it points at.
func IsSunoURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && sunoHosts[strings.ToLower(u.Hostname())]
}

// ParseLink classifies a pasted URL without touching the network.
func ParseLink(raw string) Link {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !sunoHosts[strings.ToLower(u.Hostname())] {
		return Link{Kind: KindOther}
	}

	var parts []string
	for _, part := range strings.Split(u.Path, "/") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	if len(parts) == 0 {
		return Link{Kind: KindOther}
	}
	first := parts[0]
	second := ""
	if len(parts) > 1 {
		second = parts[1]
	}

	switch {
	case first == "playlist" || first == "playlists":
		return Link{Kind: KindPlaylist}
	case first == "profile" || strings.HasPrefix(first, "@"):
		return Link{Kind: KindProfile}
	case first == "song" && uuidRE.MatchString(second):
		return Link{Kind: KindSong, UUID: strings.ToLower(second)}
	case first == "s" && second != "":
		return Link{Kind: KindShort, Code: second}
	}
	return Link{Kind: KindOther}
}

// SongPageURL is the canonical page for a song id.
func SongPageURL(uuid string) string {
	return "https://suno.com/song/" + strings.ToLower(uuid)
}

// LinkError is the DJ-facing complaint about a link that can never resolve to a song.
func LinkError(kind LinkKind) error {
	switch kind {
	case KindPlaylist:
		return fmt.Errorf("Suno playlists aren't supported. %s", songHint)
	case KindProfile:
		return fmt.Errorf("Suno profiles aren't supported. %s", songHint)
	case KindShort:
		return fmt.Errorf("That Suno short link didn't resolve to a song. %s", songHint)
	default:
		return fmt.Errorf("That Suno link isn't a song. %s", songHint)
	}
}
