.PHONY: dev deploy env

dev:
	bun run dev

deploy:
	bash scripts/deploy.sh

env:
	op inject -i env/prod.env.tpl -o env/prod.env -f
	@echo "env/prod.env written from 1Password"
