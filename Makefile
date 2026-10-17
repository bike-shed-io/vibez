.PHONY: dev deploy env macos-project macos-build macos-run suno-proxy-dev suno-proxy-test

MACOS_DERIVED_DATA := .build/VibezMac

dev:
	bun run dev

# The Suno proxy is a separate service: run it alongside `make dev` and point
# Vibez at it with SUNO_PROXY_URL=http://localhost:3006.
suno-proxy-dev:
	cd suno-proxy && SUNO_ACCESS_TOKEN=$${SUNO_ACCESS_TOKEN:-dev-token} go run ./cmd/suno-proxy

suno-proxy-test:
	cd suno-proxy && go test -race ./...

deploy:
	bash scripts/deploy.sh

env:
	op inject -i env/prod.env.tpl -o env/prod.env -f
	@echo "env/prod.env written from 1Password"

macos-project:
	xcodegen generate --spec macos/VibezMac/project.yml

macos-build: macos-project
	xcodebuild -project macos/VibezMac/VibezMac.xcodeproj -scheme VibezMac -configuration Debug -derivedDataPath $(MACOS_DERIVED_DATA) build

macos-run: macos-build
	open "$(MACOS_DERIVED_DATA)/Build/Products/Debug/Vibez.app"
