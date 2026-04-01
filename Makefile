.PHONY: dev deploy

dev:
	bun run dev

deploy:
	bash scripts/deploy.sh
