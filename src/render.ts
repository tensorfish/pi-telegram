import type { ActiveRunState, RenderAction } from "./types.ts";

const MAX_PROGRESS_ACTIONS = 5;
const MAX_INLINE_FILES = 3;
export const MAX_BODY_CHARS = 3500;

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours > 0) return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	return `${seconds}s`;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatFileList(files: string[]): string {
	if (files.length <= MAX_INLINE_FILES) return files.join(", ");
	const kept = files.slice(0, MAX_INLINE_FILES);
	return `${kept.join(", ")} …(+${files.length - MAX_INLINE_FILES} more)`;
}

export function summarizeToolAction(toolName: string, args: unknown): string {
	const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	if (toolName === "read") {
		return `reading ${String(record.path ?? "file")}`;
	}
	if (toolName === "write") {
		return `writing ${String(record.path ?? "file")}`;
	}
	if (toolName === "edit") {
		return `editing ${String(record.path ?? "file")}`;
	}
	if (toolName === "bash") {
		return `running ${truncate(String(record.command ?? "command"), 80)}`;
	}
	if (toolName === "find") {
		return `finding ${String(record.pattern ?? record.path ?? "files")}`;
	}
	if (toolName === "grep") {
		return `searching ${String(record.pattern ?? "text")}`;
	}
	if (toolName === "ls") {
		return `listing ${String(record.path ?? "directory")}`;
	}
	return `using ${toolName}`;
}

export function summarizeToolResult(toolName: string, args: unknown, result: unknown, isError: boolean): string {
	if (isError) return `failed ${summarizeToolAction(toolName, args)}`;
	const details = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
	if (toolName === "write" || toolName === "edit") {
		const path = (typeof args === "object" && args !== null ? (args as Record<string, unknown>).path : undefined) as
			| string
			| undefined;
		return `${toolName === "write" ? "updated" : "edited"} ${path ?? "file"}`;
	}
	if (toolName === "read") {
		const path = (typeof args === "object" && args !== null ? (args as Record<string, unknown>).path : undefined) as
			| string
			| undefined;
		return `read ${path ?? "file"}`;
	}
	if (toolName === "bash") {
		return `completed ${truncate(String((typeof args === "object" && args !== null ? (args as Record<string, unknown>).command : "command") ?? "command"), 80)}`;
	}
	const files = Array.isArray(details.files) ? details.files.filter((value): value is string => typeof value === "string") : [];
	if (files.length > 0) return `updated ${formatFileList(files)}`;
	return `completed ${toolName}`;
}

function renderActionLine(action: RenderAction): string {
	const prefix = action.status === "done" ? "✓" : action.status === "error" ? "✗" : "↻";
	return `${prefix} ${action.label}`;
}

export function renderProgress(run: ActiveRunState, now: number): string {
	const step = Math.max(1, run.turnIndex);
	const header = `working · pi · ${formatElapsed(now - run.startedAt)} · step ${step}`;
	const actions = run.actions.slice(-MAX_PROGRESS_ACTIONS).map(renderActionLine);
	const body = actions.length > 0 ? `\n\n${actions.join("\n")}` : "";
	const footer = "\n\nreply in Telegram to guide the agent";
	return `${header}${body}${footer}`;
}

export function renderFinal(run: ActiveRunState, now: number): string {
	const status = run.lastAssistantError ? "error" : "done";
	const header = `${status} · pi · ${formatElapsed(now - run.startedAt)}`;
	const body = run.lastAssistantText?.trim() || (run.lastAssistantError ? "Run failed." : "Run completed.");
	return `${header}\n\n${body}`;
}

export function extractAssistantText(message: unknown): { text: string; error: boolean } {
	const assistant = typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
	const content = Array.isArray(assistant.content) ? assistant.content : [];
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text") {
			const text = (item as { text?: unknown }).text;
			if (typeof text === "string" && text.trim().length > 0) parts.push(text.trim());
		}
	}
	const error = Boolean((assistant as { errorMessage?: unknown }).errorMessage) || (assistant as { stopReason?: unknown }).stopReason === "error";
	return { text: parts.join("\n\n"), error };
}

function splitLinesPreservingFences(text: string, maxChars: number): string[] {
	const chunks: string[] = [];
	let current = "";
	let openFence = false;
	let fenceHeader = "```";
	const closingFence = "```";
	const lines = text.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine;
		const fenceMatch = line.match(/^```.*$/);
		const nextLine = current.length === 0 ? line : `${current}\n${line}`;
		if (nextLine.length > maxChars && current.length > 0) {
			let flushed = current;
			if (openFence && !flushed.endsWith(`\n${closingFence}`)) flushed = `${flushed}\n${closingFence}`;
			chunks.push(flushed);
			current = openFence ? `${fenceHeader}\n${line}` : line;
		} else {
			current = nextLine;
		}
		if (fenceMatch) {
			if (openFence) {
				openFence = false;
			} else {
				openFence = true;
				fenceHeader = line;
			}
		}
	}
	if (current.length > 0) {
		if (openFence && !current.endsWith(`\n${closingFence}`)) current = `${current}\n${closingFence}`;
		chunks.push(current);
	}
	return chunks.filter((chunk) => chunk.trim().length > 0);
}

export function splitFinalText(text: string): string[] {
	if (text.length <= MAX_BODY_CHARS) return [text];
	const paragraphs = text.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";
	for (const paragraph of paragraphs) {
		const next = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
		if (next.length <= MAX_BODY_CHARS) {
			current = next;
			continue;
		}
		if (current.length > 0) {
			chunks.push(...splitLinesPreservingFences(current, MAX_BODY_CHARS));
			current = "";
		}
		if (paragraph.length <= MAX_BODY_CHARS) {
			current = paragraph;
		} else {
			chunks.push(...splitLinesPreservingFences(paragraph, MAX_BODY_CHARS));
		}
	}
	if (current.length > 0) chunks.push(...splitLinesPreservingFences(current, MAX_BODY_CHARS));
	if (chunks.length <= 1) return chunks;
	return chunks.map((chunk, index) => {
		const suffix = `continued (${index + 1}/${chunks.length})`;
		return index === 0 ? chunk : `${suffix}\n\n${chunk}`;
	});
}
