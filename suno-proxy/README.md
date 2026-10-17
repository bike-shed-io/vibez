# Suno proxy

A standalone Go server that downloads Suno songs a Vibez DJ asks for and streams
them to listeners. It is its own binary, container and origin — it is not served
through the Vibez app on port 3005.

Suno's public song page exposes several URLs per song and most are useless to a
player: `og:audio` is a silent decoy, the studio `audio_url` answers
`/api/forbidden`, and the cloudfront clip is encrypted on current songs. The
proxy downloads candidates in order and keeps the first one whose bytes are a
real `ftyp` container, so listeners get a file a browser can actually play.

Only published songs can be streamed. A published song's page lists an mp4 whose
audio track is unencrypted; an unpublished one lists no mp4 at all, leaving only
the encrypted clip, so there is nothing a browser could play. Adding one answers
`That Suno song isn't published yet. Publish it on Suno, then add it again.`
rather than a vaguer complaint.

## Routes

| Route | Auth | What it does |
|-------|------|--------------|
| `POST /songs` | Bearer token | Resolves a song link and starts a background download. Returns id, metadata and `audioUrl` right away. |
| `GET /songs/{id}` | Bearer token | `queued`, `downloading`, `ready` or `failed`. Vibez waits for `ready` before a track goes on air. |
| `GET /audio/{id}` | none | Serves the cached song with Range support. Never starts a download. |
| `GET /healthz` | none | Liveness. |

Adding songs needs the token; listening never does. A song is kept for 24 hours
from its download and then deleted, whether or not anyone asks again. Asking for
an evicted song downloads it once more.

## Config

| Variable | Default | Notes |
|----------|---------|-------|
| `SUNO_ACCESS_TOKEN` | — | Required. The static token DJs enter in Vibez. |
| `SUNO_PROXY_ADDR` | `:3006` | Listen address. |
| `SUNO_PROXY_PUBLIC_URL` | empty | Public base URL, e.g. `https://suno-proxy.example`. Makes `audioUrl` absolute so listeners can reach it. |
| `SUNO_CACHE_DIR` | `.cache/songs` | Song files and their sidecars. |
| `SUNO_CACHE_TTL` | `24h` | How long a song is kept. |
| `SUNO_MAX_DOWNLOADS` | `3` | Concurrent downloads. |
| `SUNO_DOWNLOAD_TIMEOUT` | `5m` | Per-song limit. |

## Develop

```sh
SUNO_ACCESS_TOKEN=dev-token go run ./cmd/suno-proxy
go test -race ./...
```

Vibez needs `SUNO_PROXY_URL` (and the same `SUNO_ACCESS_TOKEN` is typed by the
DJ, not configured in Vibez).
