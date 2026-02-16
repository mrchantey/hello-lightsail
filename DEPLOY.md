# Deploying Hello Lightsail

This document describes how the deployment works end-to-end, including the
Pulumi state bootstrap, infrastructure provisioning, binary deployment, and
full teardown.

---

## Overview

```
┌──────────────┐     ┌───────────────────┐     ┌────────────────────┐
│  Local Build │────▶│   Pulumi (IaC)    │────▶│  AWS Lightsail     │
│  cargo build │     │   TypeScript      │     │  Ubuntu instance   │
└──────────────┘     └───────────────────┘     └────────────────────┘
                            │                          ▲
                            ▼                          │
                     ┌───────────────────┐      SCP binary + SSH
                     │  S3 State Bucket  │      restart service
                     │  (Pulumi backend) │
                     └───────────────────┘
```

The Rust HTTP server at `examples/server.rs` is compiled locally, then uploaded
to a Lightsail instance over SSH.  Pulumi manages all AWS resources
(instance, static IP, firewall rules, SSH key pair) and stores its state in an
S3 bucket.

---

## Prerequisites

| Tool       | Purpose                              | Install                                |
|------------|--------------------------------------|----------------------------------------|
| **Rust**   | Build the server binary              | https://rustup.rs                      |
| **just**   | Task runner                          | `cargo install just` or package manager|
| **Node.js**| Run Pulumi TypeScript programs       | https://nodejs.org                     |
| **Pulumi** | Infrastructure-as-code CLI           | Auto-installed by `just up` if missing |
| **AWS CLI**| Create/destroy the S3 state bucket   | https://aws.amazon.com/cli             |

You also need valid **AWS credentials** configured (`aws configure` or
environment variables `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).

---

## Naming Convention

All resources use a **triple naming convention**:

```
app-name--stage--description
```

| Resource             | Name                              |
|----------------------|-----------------------------------|
| Pulumi stack         | `prod`                            |
| S3 state bucket      | `hello-lightsail--prod--state`    |
| Lightsail instance   | `hello-lightsail--prod--instance` |
| Static IP            | `hello-lightsail--prod--ip`       |
| Key pair             | `hello-lightsail--prod--keypair*` |
| Firewall rules       | `hello-lightsail--prod--ports`    |

---

## Quick Start

### Deploy everything

```sh
just up
```

This single command performs **all** of the following steps:

1. Installs Pulumi CLI (if missing) and npm dependencies
2. Builds the Rust server in release mode
3. Creates the S3 state bucket (idempotent)
4. Logs Pulumi into the S3 backend
5. Runs `pulumi up` to create all Lightsail resources
6. Saves the auto-generated SSH private key locally
7. Uploads the binary via SCP and starts the systemd service

### Tear down everything

```sh
just down
```

This destroys all AWS resources **and** the S3 state bucket.

---

## Step-by-Step Walkthrough

### 1. Build the Binary

```sh
just build
```

Runs `cargo build --example server --release`.  The output binary lands at
`target/release/examples/server`.

> **Cross-compilation note:** This project assumes your local machine is
> x86\_64 Linux (matching the Lightsail instance).  If you're on a different
> architecture, you'll need a cross-compilation toolchain (e.g.
> `cross build --target x86_64-unknown-linux-gnu --example server --release`).

### 2. Bootstrap the State Bucket

```sh
just bootstrap
```

This step solves the **chicken-and-egg problem**: Pulumi needs a backend to
store state, but we want that backend to be in AWS (an S3 bucket).

The solution is simple — create the bucket with the AWS CLI *before* Pulumi
runs:

```
aws s3 mb s3://hello-lightsail--prod--state --region us-east-1
pulumi login s3://hello-lightsail--prod--state
pulumi stack init prod
```

The bucket is **not** managed by Pulumi — it's managed by the justfile.
This avoids circular dependency: Pulumi doesn't need to bootstrap itself.

> **Idempotent:** The bootstrap step checks if the bucket already exists
> before attempting to create it, so it's safe to run repeatedly.

### 3. Provision Infrastructure

```sh
just infra-up
```

Runs `pulumi up` which creates:

- **Lightsail Key Pair** — Auto-generated SSH key pair.  The private key is
  stored as a Pulumi secret output.
- **Lightsail Static IP** — A persistent public IP that survives instance
  replacement.
- **Lightsail Instance** — Ubuntu 22.04, `nano_3_0` bundle ($3.50/month).
  The user-data script creates a systemd service (`hello-lightsail.service`)
  that will run the binary from `/opt/hello-lightsail/server`.
- **Static IP Attachment** — Binds the IP to the instance.
- **Instance Public Ports** — Opens port 8337 (server) and port 22 (SSH).

### 4. Save the SSH Key

```sh
just save-key
```

Extracts the private key from Pulumi's secret outputs and saves it to
`infra/id_lightsail` (mode 600).  This file is gitignored.

### 5. Deploy the Binary

```sh
just deploy
```

1. SCPs the release binary to the instance at `/tmp/server`
2. SSHs in and moves it to `/opt/hello-lightsail/server`
3. Restarts the `hello-lightsail` systemd service
4. Verifies the service is active

After this step, the server is live at `http://<static-ip>:8337`.

---

## Common Operations

### Redeploy after code changes

```sh
just redeploy
```

Rebuilds the binary and re-deploys it to the running instance — no
infrastructure changes needed.

### SSH into the instance

```sh
just ssh
```

### View server logs

```sh
just logs
```

Streams `journalctl` output from the `hello-lightsail.service` unit.

### Health check

```sh
just health
```

Curls the server's root endpoint and prints the response.

### Preview infrastructure changes

```sh
just infra-preview
```

Runs `pulumi preview` to show what would change without applying anything.

### Show the public URL

```sh
just url
```

---

## Teardown Details

### Destroy infrastructure only (keep state bucket)

```sh
just infra-down
```

Runs `pulumi destroy` to remove all Lightsail resources, then removes the
Pulumi stack.  The S3 state bucket is preserved so you can re-deploy later
without losing history.

### Full teardown (infrastructure + state bucket)

```sh
just down
```

1. Destroys all Lightsail resources via `pulumi destroy`
2. Removes the Pulumi stack
3. Force-deletes the S3 state bucket and all its contents
4. Removes the local SSH key file

After `just down`, there are **zero** AWS resources remaining.  Running
`just up` again will recreate everything from scratch.

> **State after teardown:** Since `pulumi destroy` removes all tracked
> resources before the bucket is deleted, there's nothing lost.  The state
> file in S3 only recorded "everything is destroyed" at that point, so
> deleting it is safe.

---

## Architecture Details

### Pulumi State Backend

Pulumi supports several backends for storing state.  This project uses **S3**:

```
pulumi login s3://hello-lightsail--prod--state
```

Unlike Terraform, Pulumi's S3 backend does **not** require a DynamoDB table
for locking.  The state files are stored directly in the bucket under a
`.pulumi/` prefix.

### Systemd Service

The instance's user-data script creates `/etc/systemd/system/hello-lightsail.service`:

```ini
[Unit]
Description=Hello Lightsail HTTP Server
After=network.target

[Service]
Type=simple
ExecStart=/opt/hello-lightsail/server
WorkingDirectory=/opt/hello-lightsail
Restart=always
RestartSec=3
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
```

Key properties:
- **Restart=always** — if the process crashes, systemd restarts it after 3s
- **After=network.target** — waits for networking before starting
- **WantedBy=multi-user.target** — starts on boot

### Security

- The SSH private key is a **Pulumi secret** (encrypted in state) and saved
  locally to a gitignored file.
- Port 22 (SSH) is open; in production you'd restrict this to your IP.
- Port 8337 is open to all traffic (the server is HTTP, not HTTPS).

---

## Project Structure

```
hello-lightsail/
├── examples/
│   └── server.rs              # The Rust HTTP server
├── infra/
│   ├── index.ts               # Pulumi program (Lightsail resources)
│   ├── package.json           # Node dependencies
│   ├── tsconfig.json          # TypeScript config
│   ├── Pulumi.yaml            # Pulumi project definition
│   ├── Pulumi.prod.yaml       # Stack-specific config (region, bundle, etc.)
│   ├── id_lightsail           # [gitignored] SSH private key
│   └── node_modules/          # [gitignored] npm packages
├── src/
│   └── main.rs                # Placeholder main
├── justfile                   # All deployment commands
├── DEPLOY.md                  # This file
├── plan.md                    # Original project plan
├── Cargo.toml
└── .gitignore
```

---

## Troubleshooting

### "Pulumi not found" after install

The install script puts Pulumi in `~/.pulumi/bin`.  Make sure it's on your
`PATH`:

```sh
export PATH="$HOME/.pulumi/bin:$PATH"
```

### Instance exists but service isn't running

SSH in and check the service status:

```sh
just ssh
sudo systemctl status hello-lightsail.service
sudo journalctl -u hello-lightsail.service --no-pager -n 100
```

Common causes:
- Binary wasn't deployed yet (run `just deploy`)
- Binary crashed on startup (check logs for Rust panics)

### "Permission denied" when SCPing

Make sure the key file has correct permissions:

```sh
chmod 600 infra/id_lightsail
```

### State bucket already exists (in another account)

S3 bucket names are globally unique.  If someone else has
`hello-lightsail--prod--state`, change the bucket name in the justfile.

### Want to change region or instance size

Edit `infra/Pulumi.prod.yaml`:

```yaml
config:
  aws:region: us-west-2
  hello-lightsail:availabilityZone: us-west-2a
  hello-lightsail:bundleId: micro_3_0
```

Then run `just infra-up` to apply changes.  Note that changing the
availability zone will **replace** the instance.