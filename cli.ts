#!/usr/bin/env npx tsx
import { execSync } from "child_process";
import { copyFileSync, existsSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
	CreateBucketCommand,
	DeleteBucketCommand,
	DeleteObjectsCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	S3Client,
} from "@aws-sdk/client-s3";
import * as readline from "readline";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// S3 backend requires a passphrase for encrypting secrets in state.
// Set via env var so Pulumi doesn't prompt interactively.
// Override with PULUMI_CONFIG_PASSPHRASE env var for production use.
if (
	!process.env.PULUMI_CONFIG_PASSPHRASE &&
	!process.env.PULUMI_CONFIG_PASSPHRASE_FILE
) {
	process.env.PULUMI_CONFIG_PASSPHRASE = "";
}
const APP = "hello-lightsail";
const STAGE = "prod";
const PREFIX = `${APP}--${STAGE}`;
const BUCKET = `${PREFIX}--state`;
const REGION = "us-west-2";
const INFRA_DIR = "infra";
const KEY_FILE = join(INFRA_DIR, "id_lightsail");
// Binary name will be determined from command line arguments, defaults to "server"
let BINARY_NAME = "server";
const REMOTE_DIR = `/opt/${APP}`;
const REMOTE_BINARY_NAME = "app";
const SERVICE_NAME = APP;
const SSH_USER = "ubuntu";
const MUSL_TARGET = "x86_64-unknown-linux-musl";
const SSH_OPTS =
	`-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${KEY_FILE}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a command with inherited stdio (visible output). Returns stdout if piped. */
function run(cmd: string, opts?: { cwd?: string; silent?: boolean }): string {
	const cwd = opts?.cwd ?? process.cwd();
	if (opts?.silent) {
		return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }) ?? "";
	}
	execSync(cmd, { cwd, stdio: "inherit" });
	return "";
}

/** Run a command and capture stdout, trimmed. */
function capture(cmd: string, opts?: { cwd?: string }): string {
	return execSync(cmd, {
		cwd: opts?.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		encoding: "utf-8",
	}).trim();
}

/** Prompt the user for a yes/no answer. */
async function ask(question: string): Promise<boolean> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) => {
		rl.question(`${question} (y/N) `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y");
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// S3 — AWS SDK (replaces aws-cli dependency)
// ---------------------------------------------------------------------------

const s3 = new S3Client({ region: REGION });

async function bucketExists(): Promise<boolean> {
	try {
		await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
		return true;
	} catch {
		return false;
	}
}

async function ensureBucket(): Promise<void> {
	console.log(`🪣 Ensuring state bucket s3://${BUCKET} exists...`);
	if (await bucketExists()) {
		console.log(`   Bucket already exists.`);
		return;
	}
	await s3.send(
		new CreateBucketCommand({
			Bucket: BUCKET,
			CreateBucketConfiguration: { LocationConstraint: REGION },
		}),
	);
	console.log(`   ✅ Bucket created.`);
}

async function emptyBucket(): Promise<void> {
	let token: string | undefined;
	do {
		const list = await s3.send(
			new ListObjectsV2Command({
				Bucket: BUCKET,
				ContinuationToken: token,
			}),
		);
		if (list.Contents && list.Contents.length > 0) {
			await s3.send(
				new DeleteObjectsCommand({
					Bucket: BUCKET,
					Delete: {
						Objects: list.Contents.map((o) => ({ Key: o.Key })),
					},
				}),
			);
		}
		token = list.NextContinuationToken;
	} while (token);
}

async function removeBucket(): Promise<void> {
	console.log(`🗑️  Removing state bucket s3://${BUCKET}...`);
	if (!(await bucketExists())) {
		console.log(`   Bucket doesn't exist, skipping.`);
		return;
	}
	await emptyBucket();
	await s3.send(new DeleteBucketCommand({ Bucket: BUCKET }));
	console.log(`   ✅ Bucket removed.`);
}

// ---------------------------------------------------------------------------
// Pulumi helpers
// ---------------------------------------------------------------------------

async function checkPulumi(): Promise<void> {
	try {
		capture("pulumi version");
		console.log(`✅ Pulumi found: ${capture("pulumi version")}`);
	} catch {
		const yes = await ask(
			"Pulumi CLI is not installed. Install it now?",
		);
		if (!yes) {
			console.error("❌ Pulumi is required. Aborting.");
			process.exit(1);
		}
		console.log("📦 Installing Pulumi CLI...");
		run("curl -fsSL https://get.pulumi.com | sh");
		process.env.PATH = `${process.env.HOME}/.pulumi/bin:${process.env.PATH}`;
		console.log(`   ✅ Pulumi installed: ${capture("pulumi version")}`);
	}
}

function npmInstall(): void {
	console.log("📦 Installing npm dependencies...");
	run("npm install --silent");
	run("npm install --silent", { cwd: INFRA_DIR });
}

function pulumiLogin(): void {
	console.log(`🔐 Logging Pulumi into s3://${BUCKET}...`);
	run(`pulumi login s3://${BUCKET}`, { cwd: INFRA_DIR });
}

function pulumiSelectOrInitStack(): void {
	try {
		run(`pulumi stack select ${STAGE}`, { cwd: INFRA_DIR, silent: true });
	} catch {
		run(`pulumi stack init ${STAGE}`, { cwd: INFRA_DIR });
	}
}

function pulumiUp(): void {
	console.log("🚀 Running pulumi up...");
	run(`pulumi up --yes --stack ${STAGE}`, { cwd: INFRA_DIR });
}

function pulumiDestroy(): void {
	console.log("💣 Destroying infrastructure...");
	try {
		run(`pulumi destroy --yes --stack ${STAGE}`, { cwd: INFRA_DIR });
	} catch (e) {
		console.log("   (pulumi destroy encountered an issue, continuing...)");
	}
	try {
		run(`pulumi stack rm ${STAGE} --yes --force`, { cwd: INFRA_DIR });
	} catch {
		console.log("   (stack rm may have already been done)");
	}
}

function pulumiOutput(key: string): string {
	return capture(
		`pulumi stack output ${key} --stack ${STAGE}`,
		{ cwd: INFRA_DIR },
	);
}

function pulumiOutputSecret(key: string): string {
	return capture(
		`pulumi stack output ${key} --show-secrets --stack ${STAGE}`,
		{ cwd: INFRA_DIR },
	);
}

// ---------------------------------------------------------------------------
// SSH key management
// ---------------------------------------------------------------------------

function saveKey(): void {
	console.log("🔑 Saving SSH private key...");
	const key = pulumiOutputSecret("privateKey");
	writeFileSync(KEY_FILE, key + "\n", { mode: 0o600 });
	console.log(`   ✅ Key saved to ${KEY_FILE}`);
}

function cleanKey(): void {
	for (const f of [KEY_FILE, `${KEY_FILE}.pub`]) {
		try {
			unlinkSync(f);
		} catch {}
	}
	console.log("✅ Local key files removed.");
}

function requireKey(): void {
	if (!existsSync(KEY_FILE)) {
		console.error(
			`❌ SSH key not found at ${KEY_FILE}. Run 'just up' first.`,
		);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Build & Deploy
// ---------------------------------------------------------------------------

function build(): void {
	console.log("🔨 Building server binary (musl, static)...");
	run(`cargo build --example ${BINARY_NAME} --release --target ${MUSL_TARGET}`);
	console.log(
		`   ✅ Binary built: $CARGO_TARGET_DIR/${MUSL_TARGET}/release/examples/${BINARY_NAME}`,
	);
}

async function waitForSSH(ip: string): Promise<void> {
	console.log("⏳ Waiting for instance SSH to become available...");
	const maxAttempts = 30;
	for (let i = 0; i < maxAttempts; i++) {
		try {
			capture(
				`ssh ${SSH_OPTS} -o ConnectTimeout=5 ${SSH_USER}@${ip} 'echo ready'`,
			);
			console.log("   ✅ SSH is ready.");
			return;
		} catch {
			process.stdout.write(".");
			await sleep(10_000);
		}
	}
	console.error(
		"\n❌ Timed out waiting for SSH. Instance may still be booting.",
	);
	process.exit(1);
}

function deployBinary(ip: string, port: string): void {
	const localBinary =
		`$CARGO_TARGET_DIR/${MUSL_TARGET}/release/examples/${BINARY_NAME}`;

	// Write systemd unit file locally, then SCP it over
	const serviceUnit = `[Unit]
Description=${APP} ${BINARY_NAME}
After=network.target

[Service]
Type=simple
ExecStart=${REMOTE_DIR}/${REMOTE_BINARY_NAME}
WorkingDirectory=${REMOTE_DIR}
Restart=always
RestartSec=3
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
`;
	const localServiceFile = join(INFRA_DIR, `${SERVICE_NAME}.service`);
	writeFileSync(localServiceFile, serviceUnit);

	console.log(`📤 Uploading binary and service file to ${ip}...`);
	run(
		`scp ${SSH_OPTS} ${localBinary} ${SSH_USER}@${ip}:/tmp/${REMOTE_BINARY_NAME}`,
	);
	run(
		`scp ${SSH_OPTS} ${localServiceFile} ${SSH_USER}@${ip}:/tmp/${SERVICE_NAME}.service`,
	);

	// Clean up local temp file
	try {
		unlinkSync(localServiceFile);
	} catch {}

	console.log("🔄 Installing and restarting service...");
	const remoteCmd = [
		`sudo mkdir -p ${REMOTE_DIR}`,
		`sudo mv /tmp/${REMOTE_BINARY_NAME} ${REMOTE_DIR}/${REMOTE_BINARY_NAME}`,
		`sudo chmod +x ${REMOTE_DIR}/${REMOTE_BINARY_NAME}`,
		`sudo mv /tmp/${SERVICE_NAME}.service /etc/systemd/system/${SERVICE_NAME}.service`,
		`sudo systemctl daemon-reload`,
		`sudo systemctl enable ${SERVICE_NAME}.service`,
		`sudo systemctl restart ${SERVICE_NAME}.service`,
		`sleep 2`,
		`sudo systemctl is-active ${SERVICE_NAME}.service`,
	].join(" && ");
	run(`ssh ${SSH_OPTS} ${SSH_USER}@${ip} '${remoteCmd}'`);

	console.log(`\n✅ Binary deployed and service running!`);
	console.log(`📦 Service: ${SERVICE_NAME}`);
	if (BINARY_NAME === "server") {
		console.log(`🌐 http://${ip}:${port}`);
	}
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Full deploy: build, provision infrastructure, deploy binary. */
async function cmdUp(): Promise<void> {
	await checkPulumi();
	npmInstall();
	build();
	await ensureBucket();
	pulumiLogin();
	pulumiSelectOrInitStack();
	pulumiUp();
	saveKey();

	const ip = pulumiOutput("staticIpAddress");
	const port = pulumiOutput("port");

	await waitForSSH(ip);
	deployBinary(ip, port);
}

/** Assume infra is already up. Build and deploy the binary. */
async function cmdDeploy(): Promise<void> {
	requireKey();
	build();
	// need to login to read stack outputs
	pulumiLogin();

	const ip = pulumiOutput("staticIpAddress");
	const port = pulumiOutput("port");

	deployBinary(ip, port);
}

/** Tear down all infrastructure and remove state. */
async function cmdDown(): Promise<void> {
	// pulumi stack rm deletes Pulumi.<stack>.yaml — back it up
	const stackConfig = join(INFRA_DIR, `Pulumi.${STAGE}.yaml`);
	const stackConfigBackup = `${stackConfig}.bak`;
	if (existsSync(stackConfig)) {
		copyFileSync(stackConfig, stackConfigBackup);
	}

	try {
		pulumiLogin();
		pulumiDestroy();
	} catch {
		console.log(
			"   (pulumi cleanup may have partially failed, continuing...)",
		);
	}
	try {
		run("pulumi logout", { cwd: INFRA_DIR, silent: true });
	} catch {}

	// restore stack config so `just up` works again from clean state
	if (existsSync(stackConfigBackup)) {
		copyFileSync(stackConfigBackup, stackConfig);
		unlinkSync(stackConfigBackup);
	}
	await removeBucket();
	cleanKey();
	console.log("\n✅ Everything torn down.");
}

/** Stream logs from the running service. */
async function cmdWatch(): Promise<void> {
	requireKey();
	pulumiLogin();

	const ip = pulumiOutput("staticIpAddress");
	const lines = process.argv[3] || "50";

	console.log(`📜 Streaming logs from ${SERVICE_NAME}...`);
	console.log(
		`   (Press Ctrl+C to stop watching - service will keep running)\n`,
	);

	// Stream logs via journalctl -f follows in real-time
	const remoteCmd = `sudo journalctl -f -u ${SERVICE_NAME}.service -n ${lines}`;
	try {
		run(`ssh ${SSH_OPTS} -t ${SSH_USER}@${ip} '${remoteCmd}'`);
	} catch {
		// SSH exits with non-zero when user hits Ctrl+C, which is expected
		console.log("\n✅ Stopped watching logs. Service is still running.");
	}
}

/** Log the IP address of the running instance. */
async function cmdIp(): Promise<void> {
	pulumiLogin();

	const ip = pulumiOutput("staticIpAddress");
	console.log(ip);

	// Save IP to .env file
	const envContent = `IP=${ip}\n`;
	writeFileSync(".env", envContent);
	console.log(`   💾 IP saved to .env`);
}

/** Ping the live site. */
async function cmdPing(): Promise<void> {
	pulumiLogin();

	const ip = pulumiOutput("staticIpAddress");
	const port = pulumiOutput("port");

	console.log(`🌐 Pinging http://${ip}:${port}/...\n`);
	try {
		const response = await fetch(`http://${ip}:${port}/`);
		const body = await response.text();
		console.log(`Status: ${response.status} ${response.statusText}`);
		console.log(`\nBody:\n${body}`);
	} catch (err) {
		console.error(`❌ Failed to ping: ${err}`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

// Support passing binary name as third argument
if (process.argv[3]) {
	BINARY_NAME = process.argv[3];
}

async function main(): Promise<void> {
	switch (command) {
		case "up":
			return cmdUp();
		case "deploy":
			return cmdDeploy();
		case "down":
			return cmdDown();
		case "watch":
			return cmdWatch();
		case "ip":
			return cmdIp();
		case "ping":
			return cmdPing();
		default:
			console.error(
				"Usage: cli.ts <up|deploy|down|watch|ip|ping> [binary|lines]",
			);
			console.error("");
			console.error("Commands:");
			console.error("  up      Synchronize infra, then build & deploy");
			console.error("  deploy  Assume infra is up, build & deploy");
			console.error(
				"  down    Remove all infra, including state bucket",
			);
			console.error("  watch   Stream logs from the running service");
			console.error("  ip      Log the IP address of the running instance");
			console.error("  ping    Ping the live site");
			console.error("");
			console.error("Binary options (for up/deploy):");
			console.error("  server  (default) - HTTP server example");
			console.error("  discord           - Discord bot example");
			console.error("");
			console.error("Watch options:");
			console.error(
				"  cli.ts watch [lines]  - Number of lines to show (default: 50)",
			);
			process.exit(1);
	}
}

main().catch((err) => {
	console.error("❌ Error:", err.message ?? err);
	process.exit(1);
});
