# Hello Lightsail

A Rust HTTP server ([beet](./beet) framework) deployed to AWS Lightsail via Pulumi, orchestrated by a single TypeScript CLI.

## What it does

Deploys a statically-linked (musl) Rust binary to a Lightsail Ubuntu instance. The server listens on `0.0.0.0:8337`, tracks visitor count, and responds with a greeting.

```sh
curl http://<ip>:8337
curl http://<ip>:8337?name=pete
```

## Commands

```sh
just up      # Build binary, provision infra (S3 state bucket + Lightsail), deploy
just deploy  # Rebuild and redeploy binary (infra must already exist)
just down    # Destroy all AWS resources including state bucket
```

## Prerequisites

- **Rust** with `x86_64-unknown-linux-musl` target (`rustup target add x86_64-unknown-linux-musl`)
- **Node.js** (runs CLI + Pulumi programs)
- **just** (task runner)
- **Pulumi** (auto-installed on first `just up` if missing)
- **AWS credentials** configured via environment or `aws configure`

## Architecture

`cli.ts` does everything:

1. Creates an S3 bucket for Pulumi state (AWS SDK, not Pulumi-managed)
2. Runs `pulumi up` to provision Lightsail keypair, instance, static IP, firewall
3. Builds the server with `cargo build --example server --release --target x86_64-unknown-linux-musl`
4. SCPs the binary + systemd unit file to the instance
5. Restarts the systemd service

The musl static build avoids glibc version mismatches between local machine and the Ubuntu 22.04 instance.

## Resources created

| Resource | Name |
|---|---|
| S3 bucket (state) | `hello-lightsail--prod--state` |
| Lightsail instance | `hello-lightsail--prod--instance` |
| Static IP | `hello-lightsail--prod--ip` |
| Key pair | `hello-lightsail--prod--keypair*` |
| Firewall | ports 8337 (server) + 22 (SSH) |

Instance: Ubuntu 22.04, `nano_3_0` (~$3.50/mo), us-west-2.

## Troubleshooting

```sh
# SSH into instance
ssh -i infra/id_lightsail ubuntu@<ip>

# Check service
sudo systemctl status hello-lightsail.service
sudo journalctl -u hello-lightsail.service --no-pager -n 50
```
