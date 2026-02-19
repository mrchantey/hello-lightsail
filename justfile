# Hello Lightsail
# All logic lives in cli.ts — these are the only commands you need.

# Default binary to deploy (can be overridden)
BINARY := "server"

# Synchronize infra, then build & deploy
up:
	npx tsx cli.ts up {{BINARY}}

# Assume infra is up, build & deploy
deploy:
	npx tsx cli.ts deploy {{BINARY}}

# Remove all infra, including state bucket
down:
	npx tsx cli.ts down

# Stream logs from the running service (press Ctrl+C to stop)
watch LINES="50":
	npx tsx cli.ts watch {{LINES}}

# Log the IP address of the running instance
ip:
	npx tsx cli.ts ip
