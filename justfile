# Hello Lightsail – Justfile
# Deploys a Rust HTTP server to AWS Lightsail via Pulumi.
#
# Quick start:
#   just up      – build, provision infrastructure, deploy binary
#   just down    – tear everything down (infra + state bucket)
#   just deploy  – rebuild & redeploy binary only (infra already up)
#   just ssh     – open an SSH session to the instance

set dotenv-load := false
set shell := ["bash", "-euo", "pipefail", "-c"]

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
app          := "hello-lightsail"
stage        := "prod"
prefix       := app + "--" + stage
bucket       := prefix + "--state"
stack        := stage
region       := "us-east-1"
infra_dir    := "infra"
key_file     := infra_dir + "/id_lightsail"
binary_name  := "server"
remote_dir   := "/opt/hello-lightsail"
ssh_user     := "ubuntu"

# ---------------------------------------------------------------------------
# Composite recipes
# ---------------------------------------------------------------------------

# Full deploy: build binary, create infra, deploy binary to instance
up: install-pulumi build bootstrap infra-up save-key deploy
	@echo ""
	@echo "✅ Deployment complete!"
	@just _show-url

# Full teardown: destroy infra, remove state bucket
down: infra-down remove-bucket clean-key
	@echo ""
	@echo "✅ Everything torn down."

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

# Build the server binary in release mode
build:
	cargo build --example {{ binary_name }} --release
	@echo "✅ Binary built: target/release/examples/{{ binary_name }}"

# ---------------------------------------------------------------------------
# Pulumi – install & state bucket
# ---------------------------------------------------------------------------

# Install Pulumi CLI if not already present, then install npm deps
install-pulumi:
	@if ! command -v pulumi &>/dev/null; then \
		echo "📦 Installing Pulumi CLI..."; \
		curl -fsSL https://get.pulumi.com | sh; \
	else \
		echo "✅ Pulumi already installed: $(pulumi version)"; \
	fi
	cd {{ infra_dir }} && npm install --silent

# Create the S3 bucket for Pulumi state (idempotent)
bootstrap:
	@echo "🪣 Ensuring state bucket s3://{{ bucket }} exists..."
	@aws s3api head-bucket --bucket {{ bucket }} 2>/dev/null \
		|| aws s3 mb s3://{{ bucket }} --region {{ region }}
	@echo "🔐 Logging Pulumi into s3://{{ bucket }}"
	@cd {{ infra_dir }} && pulumi login s3://{{ bucket }}
	@cd {{ infra_dir }} && pulumi stack select {{ stack }} 2>/dev/null \
		|| pulumi stack init {{ stack }}
	@echo "✅ State bucket ready."

# ---------------------------------------------------------------------------
# Pulumi – infrastructure lifecycle
# ---------------------------------------------------------------------------

# Provision (or update) all Lightsail infrastructure
infra-up:
	@echo "🚀 Running pulumi up..."
	cd {{ infra_dir }} && pulumi up --yes --stack {{ stack }}

# Preview infrastructure changes without applying
infra-preview:
	cd {{ infra_dir }} && pulumi preview --stack {{ stack }}

# Destroy all Lightsail infrastructure (keeps the state bucket)
infra-down:
	@echo "💣 Destroying infrastructure..."
	cd {{ infra_dir }} && pulumi login s3://{{ bucket }} 2>/dev/null || true
	cd {{ infra_dir }} && pulumi destroy --yes --stack {{ stack }} || true
	cd {{ infra_dir }} && pulumi stack rm {{ stack }} --yes --force 2>/dev/null || true
	@echo "✅ Infrastructure destroyed."

# Show all Pulumi stack outputs
outputs:
	cd {{ infra_dir }} && pulumi stack output --stack {{ stack }}

# Show stack outputs including secrets (careful!)
outputs-show-secrets:
	cd {{ infra_dir }} && pulumi stack output --stack {{ stack }} --show-secrets

# ---------------------------------------------------------------------------
# State bucket removal (only used during full teardown)
# ---------------------------------------------------------------------------

# Remove the S3 state bucket and all contents
remove-bucket:
	@echo "🗑️  Removing state bucket s3://{{ bucket }}..."
	@aws s3 rb s3://{{ bucket }} --force 2>/dev/null || true
	@cd {{ infra_dir }} && pulumi logout 2>/dev/null || true
	@echo "✅ State bucket removed."

# ---------------------------------------------------------------------------
# SSH key management
# ---------------------------------------------------------------------------

# Save the private key from Pulumi outputs to a local file
save-key:
	@echo "🔑 Saving SSH private key..."
	@cd {{ infra_dir }} && pulumi stack output privateKey --show-secrets --stack {{ stack }} > ../{{ key_file }}
	@chmod 600 {{ key_file }}
	@echo "✅ Key saved to {{ key_file }}"

# Remove the local SSH key file
clean-key:
	@rm -f {{ key_file }} {{ key_file }}.pub
	@echo "✅ Local key files removed."

# ---------------------------------------------------------------------------
# Deploy binary to instance
# ---------------------------------------------------------------------------

# Build, upload, and restart the server on the Lightsail instance
deploy: _require-key
	#!/usr/bin/env bash
	set -euo pipefail
	IP=$(cd {{ infra_dir }} && pulumi stack output staticIpAddress --stack {{ stack }})
	PORT=$(cd {{ infra_dir }} && pulumi stack output port --stack {{ stack }})
	BINARY="target/release/examples/{{ binary_name }}"

	echo "📤 Uploading binary to ${IP}..."
	scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
		-i {{ key_file }} \
		"${BINARY}" {{ ssh_user }}@${IP}:/tmp/{{ binary_name }}

	echo "🔄 Installing and restarting service..."
	ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
		-i {{ key_file }} {{ ssh_user }}@${IP} << 'REMOTE'
	sudo mv /tmp/{{ binary_name }} {{ remote_dir }}/{{ binary_name }}
	sudo chmod +x {{ remote_dir }}/{{ binary_name }}
	sudo systemctl restart hello-lightsail.service
	sleep 1
	sudo systemctl is-active hello-lightsail.service
	REMOTE

	echo ""
	echo "✅ Binary deployed and service running!"
	echo "🌐 http://${IP}:${PORT}"

# Rebuild and redeploy just the binary
redeploy: build deploy

# ---------------------------------------------------------------------------
# Convenience helpers
# ---------------------------------------------------------------------------

# SSH into the Lightsail instance
ssh: _require-key
	#!/usr/bin/env bash
	set -euo pipefail
	IP=$(cd {{ infra_dir }} && pulumi stack output staticIpAddress --stack {{ stack }})
	exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
		-i {{ key_file }} {{ ssh_user }}@${IP}

# View server logs via journalctl
logs: _require-key
	#!/usr/bin/env bash
	set -euo pipefail
	IP=$(cd {{ infra_dir }} && pulumi stack output staticIpAddress --stack {{ stack }})
	ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
		-i {{ key_file }} {{ ssh_user }}@${IP} \
		"sudo journalctl -u hello-lightsail.service -f --no-pager -n 50"

# Check if the server is responding
health: _require-key
	#!/usr/bin/env bash
	set -euo pipefail
	IP=$(cd {{ infra_dir }} && pulumi stack output staticIpAddress --stack {{ stack }})
	PORT=$(cd {{ infra_dir }} && pulumi stack output port --stack {{ stack }})
	echo "Checking http://${IP}:${PORT} ..."
	curl -s --max-time 5 "http://${IP}:${PORT}" || echo "❌ Server not responding"

# Show the public URL of the deployed server
url:
	@just _show-url

# Run the server locally for testing
run:
	cargo run --example {{ binary_name }}

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_require-key:
	@test -f {{ key_file }} || (echo "❌ SSH key not found at {{ key_file }}. Run 'just save-key' first." && exit 1)

_show-url:
	#!/usr/bin/env bash
	set -euo pipefail
	IP=$(cd {{ infra_dir }} && pulumi stack output staticIpAddress --stack {{ stack }})
	PORT=$(cd {{ infra_dir }} && pulumi stack output port --stack {{ stack }})
	echo "🌐 http://${IP}:${PORT}"
