set dotenv-load

# Hello Lightsail
# All logic lives in cli.ts — these are the only commands you need.

# Synchronize infra, then build & deploy
up binary:
	npx tsx cli.ts up {{binary}}

# Assume infra is up, build & deploy
deploy binary:
	npx tsx cli.ts deploy {{binary}}

# Remove all infra, including state bucket
down:
	npx tsx cli.ts down

# Stream logs from the running service (press Ctrl+C to stop)
watch LINES="50":
	npx tsx cli.ts watch {{LINES}}

# Log the IP address of the running instance
ip:
	npx tsx cli.ts ip

# Ping the live site
ping:
	curl $IP:8337
	# npx tsx cli.ts ping
