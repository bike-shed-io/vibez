FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/suno-proxy ./cmd/suno-proxy

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 suno
WORKDIR /app
COPY --from=build /out/suno-proxy /app/suno-proxy
# Songs live here; mount a volume so a restart keeps the cache warm.
RUN mkdir -p /app/.cache/songs && chown -R suno:suno /app
USER suno
ENV SUNO_PROXY_ADDR=:3006 SUNO_CACHE_DIR=/app/.cache/songs
EXPOSE 3006
ENTRYPOINT ["/app/suno-proxy"]
