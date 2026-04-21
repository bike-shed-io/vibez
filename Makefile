.PHONY: dev deploy env macos-project macos-build macos-run

MACOS_DERIVED_DATA := .build/VibezMac

dev:
	bun run dev

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
