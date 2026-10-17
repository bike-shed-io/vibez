package suno

import (
	"html"
	"regexp"
	"strconv"
	"strings"
)

// Page is what a public song page says about one song.
type Page struct {
	Title       string
	Artwork     string
	DurationSec float64
	// M4AURL is the cloudfront clip. Current public songs serve it encrypted.
	M4AURL string
	// MP4URL is the same song's video file, which carries a plain AAC track.
	MP4URL string
	// IsPublic is the page's publication flag. Nil means the page never said,
	// which is unknown rather than unpublished.
	IsPublic *bool
}

var (
	metaTagRE   = regexp.MustCompile(`(?i)<meta\b[^>]*>`)
	metaKeyRE   = regexp.MustCompile(`(?i)\b(?:property|name)=["']([^"']+)["']`)
	metaValueRE = regexp.MustCompile(`(?i)\bcontent=["']([^"']*)["']`)
	canonicalRE = regexp.MustCompile(`(?i)<link[^>]+rel=["']canonical["'][^>]*>`)
	hrefRE      = regexp.MustCompile(`(?i)href=["']([^"']+)["']`)
	durationRE  = regexp.MustCompile(`\\?"duration\\?"\s*:\s*(\d+(?:\.\d+)?)`)
	isPublicRE  = regexp.MustCompile(`\\?"is_public\\?"\s*:\s*(true|false)`)
)

// ParsePage reads title, cover, duration and candidate media URLs for one song.
// Media belonging to a different clip on the same page is ignored, as are the
// retired `cdn1.suno.ai/<uuid>.mp3` path and the silent `og:audio` decoy.
func ParsePage(body, uuid string) Page {
	page := strings.ReplaceAll(body, `\/`, "/")
	id := regexp.QuoteMeta(strings.ToLower(uuid))
	mp4 := regexp.MustCompile(`(?i)https://cdn1\.suno\.ai/` + id + `\.mp4\b`).FindString(page)

	return Page{
		Title:       readMeta(page, "og:title"),
		Artwork:     readMeta(page, "og:image"),
		DurationSec: readDuration(page, strings.ToLower(uuid)),
		M4AURL:      clipURL(page, strings.ToLower(uuid)),
		MP4URL:      mp4,
		IsPublic:    readIsPublic(page, strings.ToLower(uuid)),
	}
}

// songIDFrom finds the song a page response is really about: the URL we landed on
// after redirects, else the canonical link, else og:url. A short link that lands
// nowhere useful is reported as [KindOther].
func songIDFrom(finalURL, body string) Link {
	fromURL := ParseLink(finalURL)
	switch fromURL.Kind {
	case KindSong, KindPlaylist, KindProfile:
		return fromURL
	}
	if tag := canonicalRE.FindString(body); tag != "" {
		if href := hrefRE.FindStringSubmatch(tag); href != nil {
			if link := ParseLink(href[1]); link.Kind == KindSong {
				return link
			}
		}
	}
	if ogURL := readMeta(body, "og:url"); ogURL != "" {
		if link := ParseLink(ogURL); link.Kind == KindSong {
			return link
		}
	}
	if fromURL.Kind == KindShort {
		return Link{Kind: KindOther}
	}
	return fromURL
}

func readMeta(body, key string) string {
	for _, tag := range metaTagRE.FindAllString(body, -1) {
		prop := metaKeyRE.FindStringSubmatch(tag)
		if prop == nil || !strings.EqualFold(prop[1], key) {
			continue
		}
		if value := metaValueRE.FindStringSubmatch(tag); value != nil && value[1] != "" {
			return html.UnescapeString(value[1])
		}
	}
	return ""
}

// clipURL prefers the `/1/clip/` variant, which is the full song rather than a preview.
func clipURL(body, uuid string) string {
	found := regexp.MustCompile(`(?i)https://[a-z0-9]+\.cloudfront\.net/\d+/clip/`+regexp.QuoteMeta(uuid)+`\.m4a`).
		FindAllString(body, -1)
	preferred := "/1/clip/" + uuid + ".m4a"
	for _, url := range found {
		if strings.Contains(url, preferred) {
			return url
		}
	}
	if len(found) > 0 {
		return found[0]
	}
	return ""
}

// readDuration looks for a duration next to the song id in the page's embedded JSON.
func readDuration(body, uuid string) float64 {
	for _, idx := range indexesOf(body, uuid) {
		end := min(idx+2500, len(body))
		if match := durationRE.FindStringSubmatch(body[idx:end]); match != nil {
			if seconds, err := strconv.ParseFloat(match[1], 64); err == nil && seconds > 0 {
				return seconds
			}
		}
	}
	return 0
}

// readIsPublic reads this song's publication flag from the page's embedded JSON.
// On a real page the flag sits far behind the song id, past the clip's lyrics,
// so there is no window it has to fit inside. A clip is written id first, so the
// nearest flag that follows an occurrence of the song id is this song's own,
// even on a page carrying several clips. A page that only states flags ahead of
// their ids is read whole instead, but only while every flag on it agrees, so a
// neighbour's flag is never read as this song's. A page that never names this
// song, or never states a flag, stays unknown, so a shape we failed to read is
// never reported to the DJ as an unpublished song.
func readIsPublic(body, uuid string) *bool {
	ids := indexesOf(body, uuid)
	if len(ids) == 0 {
		return nil
	}
	flags := isPublicRE.FindAllStringSubmatchIndex(body, -1)

	var public *bool
	nearest := 0
	for _, flag := range flags {
		gap := gapBehind(ids, flag[0])
		if gap < 0 || (public != nil && gap >= nearest) {
			continue
		}
		nearest = gap
		value := body[flag[2]:flag[3]] == "true"
		public = &value
	}
	if public != nil {
		return public
	}
	return agreedFlag(body, flags)
}

// agreedFlag is what the whole page says, for a page that states its flags ahead
// of their ids. It only answers while every flag on it says the same thing.
func agreedFlag(body string, flags [][]int) *bool {
	if len(flags) == 0 {
		return nil
	}
	first := body[flags[0][2]:flags[0][3]]
	for _, flag := range flags[1:] {
		if body[flag[2]:flag[3]] != first {
			return nil
		}
	}
	public := first == "true"
	return &public
}

// indexesOf is where every occurrence of needle starts in body, left to right.
func indexesOf(body, needle string) []int {
	var found []int
	for from := 0; from < len(body); {
		idx := strings.Index(body[from:], needle)
		if idx < 0 {
			break
		}
		found = append(found, from+idx)
		from += idx + len(needle)
	}
	return found
}

// gapBehind is how far at sits behind the last of positions to precede it, or
// -1 when none does. positions are in ascending order.
func gapBehind(positions []int, at int) int {
	behind := -1
	for _, pos := range positions {
		if pos > at {
			break
		}
		behind = at - pos
	}
	return behind
}
