# Google Auth Design

## Goal

Replace the shared basic-auth password with "Sign in with Google", open to any Google account. Listening stays public; DJing and queueing require sign-in. Vibez must not depend on one company's domain.

This is part 1 of 3. Part 2 is person-based channels (`2026-09-30-channels-design.md`). Part 3 (later) is persistent channels with co-DJ grants.

## Access Rules

| Action | Needs sign-in |
|---|---|
| Load web app / Mac app, listen, see listeners | No |
| Move the shared vibez slider | No |
| `dj:*` actions (claim, play, pause, seek, ...) | Yes |
| `queue:*` actions | Yes |

Anonymous listeners still send a display name on `join`.

## Server

- `GET /auth/google?client=web|mac` redirects to Google with scopes `openid email profile` and an HMAC-signed `state` (client type, nonce, 10 min expiry).
- `GET /auth/google/callback` verifies `state`, exchanges the code at Google's token endpoint (server-side, with client secret), reads `email`, `email_verified`, `name`, `given_name`, `picture` from the returned ID token. The ID token comes directly from Google over TLS, so no JWKS signature check is needed.
  - Reject if `email_verified` is false or email is in `BANNED_EMAILS`.
  - Issue a session token: `base64url(payload).base64url(hmac-sha256(payload, SESSION_SECRET))`, payload `{ email, name, picture, exp }`, expiry 30 days.
  - `client=web`: set HttpOnly, Secure, SameSite=Lax cookie `vibez_session`, redirect to `/`.
  - `client=mac`: redirect to `vibez://auth?token=<token>`.
- `POST /auth/logout` clears the cookie.
- `GET /auth/me` returns `{ email, name, picture }` or 401.
- WebSocket upgrade reads the token from the cookie or `Authorization: Bearer <token>`. A valid, non-banned token attaches the user to the connection; anything else connects as anonymous. The connection is never refused.
- `dj:*` and `queue:*` messages from anonymous connections get `{ type: "error", message: "Sign in to DJ" }`.
- Remove `AUTH_PASSWORD` and the basic-auth middleware.
- Slack `/vibez` commands are unchanged (authenticated by Slack).

## DJ Name

- Clients have a "DJ name" setting, prefilled with the Google `given_name`, stored locally per device (`localStorage` on web, `UserDefaults` on Mac).
- The client sends it on `dj:claim` (`{ type: "dj:claim", djName }`). Server trims it to 30 chars and falls back to the Google name.
- Identity for admin and bans is always the Google email, never the DJ name. The channel UI shows the DJ name next to the Google avatar.

## Admin

- `ADMIN_EMAILS` and `BANNED_EMAILS`: comma-separated env vars, read at startup. Changing them takes a redeploy.
- Part 1 only uses `BANNED_EMAILS` (sign-in and WebSocket connections rejected, as described above). Admin actions arrive with channels.

## Web Client

- Header shows "Sign in with Google" (link to `/auth/google?client=web`) or avatar + DJ name + sign out.
- DJ and queue controls are disabled with a "Sign in to DJ" hint when signed out.

## Mac App

- Setup drops the password field. "Sign in with Google" uses `ASWebAuthenticationSession` with callback scheme `vibez`.
- The token is stored in `~/Library/Application Support/Vibez/session-token` (directory 0700, file 0600), not Keychain: releases are ad-hoc signed, so every `brew upgrade` changes the signature and Keychain would prompt for access each time. Any stored basic-auth password is deleted on first launch after upgrade.
- The token is sent as `Authorization: Bearer` on the WebSocket request.
- Listening works without signing in.

## Config and Secrets

New env vars, stored in 1Password `infra/vibez` and added to `env/prod.env.tpl`:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
SESSION_SECRET
ADMIN_EMAILS
BANNED_EMAILS
```

One-time Google Cloud setup: OAuth client of type "Web application", consent screen "External" and published ("In production"). Only non-sensitive scopes are requested, so no Google verification review is needed. Redirect URIs:

- `https://vibez.bike-shed.io/auth/google/callback`
- `http://localhost:3005/auth/google/callback`

## Edge Cases

- Expired, tampered or banned token: connect as anonymous; client shows "Sign in to DJ".
- Google error or cancelled sign-in: redirect back to `/` with `?auth_error=1`; web shows a short message.
- Old Mac app sending basic auth: the header is ignored, so it connects as an anonymous listener. Users upgrade with `brew upgrade --cask vibez` to get DJ rights.

## Rollout

One push to `main`. The deploy workflow ships the server and the Mac release workflow ships the app together. Remove `AUTH_PASSWORD` from `env/prod.env.tpl` in the same change.

## Testing

`bun test`:

- Token sign/verify round trip; tampered signature and expired token rejected.
- Callback with the Google token call faked: verified email gets a session; unverified or banned email is rejected.
- WebSocket: anonymous `dj:claim` / `queue:add` gets an error; signed-in succeeds; anonymous `join` and `vibez:boost` work.

Manual check on the Mac app: sign in, DJ, restart app, still signed in.

## Out of Scope

Refresh tokens, session revocation lists, account page, server-side profile storage (part 3).
