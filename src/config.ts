import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FailureLogEntry, RelayConfig } from "./types.ts";

const AGENT_DIR = join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "pi-telegram.json");
const FAILURE_LOG_DIR = join(homedir(), ".pi", "pi-telegram");

export async function readRelayConfig(): Promise<RelayConfig | null> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as RelayConfig;
		if (parsed.version !== 1) {
			throw new Error(`Unsupported config version: ${String((parsed as { version?: unknown }).version)}`);
		}
		return parsed;
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw error;
	}
}

export async function writeRelayConfig(config: RelayConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	let existing: Record<string, unknown> = {};
	try {
		const current = await readFile(CONFIG_PATH, "utf8");
		existing = JSON.parse(current) as Record<string, unknown>;
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}
	// Deep-merge top-level keys; for nested objects, prefer new config values
	// but preserve unknown top-level keys from existing file
	const merged: Record<string, unknown> = {};
	for (const key of Object.keys(existing)) {
		merged[key] = existing[key];
	}
	for (const key of Object.keys(config)) {
		merged[key] = (config as Record<string, unknown>)[key];
	}
	const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	await rename(tmpPath, CONFIG_PATH);
}

export async function deleteRelayConfig(): Promise<void> {
	await rm(CONFIG_PATH, { force: true });
}

export function createRetryLogPath(now: Date = new Date()): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
		now.getMinutes(),
	)}${pad(now.getSeconds())}`;
	return join(FAILURE_LOG_DIR, `${stamp}.log`);
}

export async function appendFailureLog(path: string, entry: FailureLogEntry): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}
