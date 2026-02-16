# Hello Lightsail
# All logic lives in cli.ts — these are the only three commands you need.

# Synchronize infra, then build & deploy
up:
	npx tsx cli.ts up

# Assume infra is up, build & deploy
deploy:
	npx tsx cli.ts deploy

# Remove all infra, including state bucket
down:
	npx tsx cli.ts down
