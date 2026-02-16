# Deploying Hello Lightsail

A Rust HTTP server deployed to AWS Lightsail via Pulumi, orchestrated by a
single TypeScript CLI.

---

## Prerequisites

| Tool       | Purpose                        | Install                                 |
|------------|--------------------------------|-----------------------------------------|
| **Rust**   | Build the server binary        | https://rustup.rs                       |
| **just**   | Task runner                    | `cargo install just` or package manager |
| **Node.js**| Run CLI & Pulumi programs      | https://nodejs.org                      |
| **Pulumi** | Infrastructure-as-code CLI     | Auto-installed by `just up` (with permission) |

You also need valid **AWS credentials** configured (`aws configure` or
environment variables `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).

> **Note:** Unlike earlier versions, the AWS CLI is **not** required. The S3
> state bucket is managed directly via the AWS SDK for JavaScript.

---

## Commands

There are exactly three commands:

```sh
# Synchronize infra, then build & deploy
just up

# Assume infra is already up, build & deploy
just deploy

# Remove all infra, including the state bucket
just down
```

### `just up`

Performs the full end-to-end deployment:

1. Checks for Pulumi CLI (asks permission before installing)
2. Installs npm dependencies
3. Builds the Rust server in release mode
4. Creates the S3 state bucket via AWS SDK (idempotent)
5. Logs Pulumi into the S3 backend
6. Runs `pulumi up` to provision Lightsail resources
7. Saves the auto-generated SSH private key locally
8. Waits for SSH to become available on the instance
9. Uploads the binary via SCP and starts the systemd service

### `just deploy`

For code-only changes when infrastructure is already running:

1. Builds the Rust server in release mode
2. Reads instance IP from Pulumi stack outputs
3. Uploads the binary via SCP and restarts the service

### `just down`

Complete teardown — leaves zero AWS resources:

1. Runs `pulumi destroy` to remove all Lightsail resources
2. Removes the Pulumi stack
3. Empties and deletes the S3 state bucket via AWS SDK
4. Cleans up local SSH key files

---

## Architecture

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

The S3 state bucket is created and destroyed by `cli.ts` using the AWS SDK
directly — not by Pulumi, and not by the AWS CLI. This avoids both the
circular dependency problem and the need for the AWS CLI as a dependency.

### Naming Convention

All resources use a triple naming convention: `app-name--stage--description`

| Resource           | Name                              |
|--------------------|-----------------------------------|
| S3 state bucket    | `hello-lightsail--prod--state`    |
| Lightsail instance | `hello-lightsail--prod--instance` |
| Static IP          | `hello-lightsail--prod--ip`       |
| Key pair           | `hello-lightsail--prod--keypair*` |
| Firewall rules     | `hello-lightsail--prod--ports`    |

### Pulumi-Managed Resources

- **Lightsail Key Pair** — Auto-generated SSH key pair (private key stored as Pulumi secret)
- **Lightsail Static IP** — Persistent public IP that survives instance replacement
- **Lightsail Instance** — Ubuntu 22.04, `nano_3_0` bundle (~$3.50/month), us-west-2
- **Static IP Attachment** — Binds the static IP to the instance
- **Instance Public Ports** — Opens port 8337 (server) and port 22 (SSH)

### Systemd Service

The instance's user-data script creates a systemd unit that:
- Starts the server on boot
- Restarts automatically on crash (3s delay)
- Runs from `/opt/hello-lightsail/server`

---

## Project Structure

```
hello-lightsail/
├── cli.ts                     # All deployment logic (TypeScript)
├── justfile                   # Three commands: up, deploy, down
├── package.json               # CLI dependencies (tsx, @aws-sdk/client-s3)
├── examples/
│   └── server.rs              # The Rust HTTP server
├── infra/
│   ├── index.ts               # Pulumi program (Lightsail resources)
│   ├── package.json           # Pulumi dependencies
│   ├── tsconfig.json          # TypeScript config for Pulumi
│   ├── Pulumi.yaml            # Pulumi project definition
│   ├── Pulumi.prod.yaml       # Stack config (region, bundle, etc.)
│   └── id_lightsail           # [gitignored] SSH private key
├── src/
│   └── main.rs                # Placeholder main
├── DEPLOY.md                  # This file
├── Cargo.toml
└── .gitignore
```

---

## Configuration

To change region, instance size, or other settings, edit `infra/Pulumi.prod.yaml`:

```yaml
config:
  aws:region: us-west-2
  hello-lightsail:availabilityZone: us-west-2a
  hello-lightsail:blueprintId: ubuntu_22_04
  hello-lightsail:bundleId: nano_3_0
  hello-lightsail:serverPort: "8337"
```

Then run `just up` to apply changes.

> **Note:** Changing the availability zone will **replace** the instance.

---

## Troubleshooting

### Pulumi not found after install

The install script puts Pulumi in `~/.pulumi/bin`. Ensure it's on your PATH:

```sh
export PATH="$HOME/.pulumi/bin:$PATH"
```

### Service not running after deploy

SSH into the instance and check:

```sh
ssh -i infra/id_lightsail ubuntu@<ip>
sudo systemctl status hello-lightsail.service
sudo journalctl -u hello-lightsail.service --no-pager -n 100
```

### Cross-compilation

This project assumes your local machine is x86_64 Linux (matching the
Lightsail instance). If you're on a different architecture, you'll need
a cross-compilation toolchain targeting `x86_64-unknown-linux-gnu`.