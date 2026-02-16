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
const BINARY_NAME = "server";
const REMOTE_DIR = `/opt/${APP}`;
const SSH_USER = "ubuntu";
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
	console.log("🔨 Building server binary...");
	run(`cargo build --example ${BINARY_NAME} --release`);
	console.log(`   ✅ Binary built: target/release/examples/${BINARY_NAME}`);
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
	const binary = `target/release/examples/${BINARY_NAME}`;

	console.log(`📤 Uploading binary to ${ip}...`);
	run(`scp ${SSH_OPTS} ${binary} ${SSH_USER}@${ip}:/tmp/${BINARY_NAME}`);

	console.log("🔄 Installing and restarting service...");
	const remoteCmd = [
		`sudo mv /tmp/${BINARY_NAME} ${REMOTE_DIR}/${BINARY_NAME}`,
		`sudo chmod +x ${REMOTE_DIR}/${BINARY_NAME}`,
		`sudo systemctl restart ${APP}.service`,
		`sleep 1`,
		`sudo systemctl is-active ${APP}.service`,
	].join(" && ");
	run(`ssh ${SSH_OPTS} ${SSH_USER}@${ip} '${remoteCmd}'`);

	console.log(`\n✅ Binary deployed and service running!`);
	console.log(`🌐 http://${ip}:${port}`);
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

async function main(): Promise<void> {
	switch (command) {
		case "up":
			return cmdUp();
		case "deploy":
			return cmdDeploy();
		case "down":
			return cmdDown();
		default:
			console.error("Usage: cli.ts <up|deploy|down>");
			console.error("");
			console.error("Commands:");
			console.error("  up      Synchronize infra, then build & deploy");
			console.error("  deploy  Assume infra is up, build & deploy");
			console.error(
				"  down    Remove all infra, including state bucket",
			);
			process.exit(1);
	}
}

main().catch((err) => {
	console.error("❌ Error:", err.message ?? err);
	process.exit(1);
});
