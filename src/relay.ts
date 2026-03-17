import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	appendFailureLog,
	createRetryLogPath,
} from "./config.ts";
import { TelegramApi } from "./telegram-api.ts";
import type { FailureLogEntry, RelayConfig, RelayStatusReport, TelegramUpdate } from "./types.ts";
import { TelegramApiError } from "./types.ts";

const STATUS_KEY = "pi-telegram";
const RETRY_INTERVAL_MS = 5_000;
const NORMAL_POLL_TIMEOUT_S = 50;
const WARMUP_POLL_TIMEOUT_S = 0;
const CLIENT_TIMEOUT_BUFFER_MS = 15_000;

const POLL_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export type LocalContext = ExtensionContext | ExtensionCommandContext;

export function report(kind: string, payload: Record<string, unknown>): void {
	if (process.env.PI_TELEGRAM_DEBUG !== "1") return;
	console.log(`[pi-telegram] ${JSON.stringify({ kind, ...payload })}`);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTimeAgo(timestamp: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ago`;
}

export class RelayConnection {
	config: RelayConfig | null = null;
	api: TelegramApi | null = null;
	lastContext: LocalContext | null = null;
	lastApiSuccessAt: number | null = null;

	pollLoopActive = false;
	private pollLoopGeneration = 0;
	currentOffset: number | undefined;
	private pollAbortController: AbortController | null = null;
	private pollLoopPromise: Promise<void> | null = null;
	pollRequestInFlight = false;
	private pollSpinnerIndex = 0;

	retryActive = false;
	retryAttempt = 0;
	retryLogPath: string | null = null;

	private healthTimer: ReturnType<typeof setInterval> | null = null;
	private startupMessageId: number | undefined;

	private onUpdate: ((update: TelegramUpdate) => Promise<void>) | null = null;
	private onTestExpiry: (() => Promise<void>) | null = null;

	/** Externally set by the orchestrator so footer can show queue depth. */
	getQueueLength: () => number = () => 0;

	constructor(private readonly pi: ExtensionAPI) {}

	setHandlers(onUpdate: (update: TelegramUpdate) => Promise<void>, onTestExpiry: () => Promise<void>): void {
		this.onUpdate = onUpdate;
		this.onTestExpiry = onTestExpiry;
	}

	rememberContext(ctx: LocalContext): void {
		this.lastContext = ctx;
	}

	setWorkingMessage(message?: string): void {
		if (!this.lastContext?.hasUI) return;
		this.lastContext.ui.setWorkingMessage(message);
	}

	// --- Health timer ---

	ensureHealthTimer(): void {
		if (this.healthTimer) return;
		this.healthTimer = setInterval(() => {
			void this.onTestExpiry?.();
			if (this.pollRequestInFlight && !this.isConnected()) {
				this.pollSpinnerIndex = (this.pollSpinnerIndex + 1) % POLL_SPINNER_FRAMES.length;
			}
			this.refreshFooter();
		}, 200);
	}

	clearHealthTimer(): void {
		if (!this.healthTimer) return;
		clearInterval(this.healthTimer);
		this.healthTimer = null;
	}

	// --- Config ---

	setConfig(config: RelayConfig | null): void {
		this.config = config;
		this.api = config ? new TelegramApi(config.botToken) : null;
	}

	// --- Polling lifecycle ---

	async startPolling(): Promise<void> {
		if (this.pollLoopActive || !this.config?.enabled || !this.api) return;
		const generation = ++this.pollLoopGeneration;
		this.pollLoopActive = true;
		this.retryActive = false;
		this.retryAttempt = 0;
		this.retryLogPath = null;
		const loopPromise = this.pollLoop(generation).finally(() => {
			if (this.pollLoopPromise === loopPromise) this.pollLoopPromise = null;
		});
		this.pollLoopPromise = loopPromise;
		void loopPromise;
	}

	async stopPolling(): Promise<void> {
		this.pollLoopGeneration++;
		this.pollLoopActive = false;
		this.pollRequestInFlight = false;
		this.pollSpinnerIndex = 0;
		this.pollAbortController?.abort();
		const loopPromise = this.pollLoopPromise;
		if (loopPromise) {
			try {
				await loopPromise;
			} catch {
				// poll loop errors are already handled internally
			}
		}
	}

	private async pollLoop(generation: number): Promise<void> {
		let firstPoll = true;
		while (generation === this.pollLoopGeneration && this.config?.enabled && this.api) {
			const abortController = new AbortController();
			this.pollAbortController = abortController;
			this.pollRequestInFlight = true;
			this.refreshFooter();

			// Use a short first poll to validate connectivity fast,
			// then switch to normal long-poll timeout.
			const pollTimeoutS = firstPoll ? WARMUP_POLL_TIMEOUT_S : NORMAL_POLL_TIMEOUT_S;
			const clientTimeoutMs = pollTimeoutS * 1000 + CLIENT_TIMEOUT_BUFFER_MS;
			const clientTimer = setTimeout(() => abortController.abort(), clientTimeoutMs);

			try {
				const updates = await this.api.getUpdates(this.currentOffset, pollTimeoutS, abortController.signal);
				clearTimeout(clientTimer);
				if (generation !== this.pollLoopGeneration || !this.config?.enabled) break;
				this.recordApiSuccess();
				firstPoll = false;
				for (const update of updates) {
					this.currentOffset = update.update_id + 1;
					if (this.onUpdate) await this.onUpdate(update);
				}
			} catch (error) {
				clearTimeout(clientTimer);
				if (this.isAbortError(error) && generation !== this.pollLoopGeneration) break;
				await this.handleApiFailure(error, "getUpdates");
				if (generation !== this.pollLoopGeneration || !this.config?.enabled) break;
				// Keep spinner visible during retry sleep
				this.pollRequestInFlight = true;
				this.refreshFooter();
				await sleep(RETRY_INTERVAL_MS);
			} finally {
				clearTimeout(clientTimer);
				if (this.pollAbortController === abortController) {
					this.pollRequestInFlight = false;
					this.pollSpinnerIndex = 0;
					this.pollAbortController = null;
				}
				this.refreshFooter();
			}
		}
		if (generation === this.pollLoopGeneration) {
			this.pollLoopActive = false;
			this.pollRequestInFlight = false;
			this.pollSpinnerIndex = 0;
		}
		this.refreshFooter();
	}

	async ensureDesiredConnection(): Promise<void> {
		if (!this.config?.enabled || !this.api) {
			await this.stopPolling();
			return;
		}
		await this.startPolling();
	}

	// --- Startup / shutdown messages ---

	private get botRef(): string {
		return this.config?.botUsername ? `@${this.config.botUsername}` : "bot";
	}

	async sendStartupConnectedMessageIfNeeded(): Promise<void> {
		if (!this.config?.enabled || !this.api || !this.config.lastValidatedAt) return;
		const messageId = await this.telegramSend(`🟢 ${this.botRef} connected`);
		if (messageId !== undefined) this.startupMessageId = messageId;
	}

	async sendShutdownDisconnectedMessage(): Promise<void> {
		if (!this.config?.enabled || !this.api || !this.isConnected()) return;
		await this.telegramSend(`🔴 ${this.botRef} disconnected`);
	}

	// --- Connection state ---

	isConnected(): boolean {
		if (!this.config?.enabled || !this.pollLoopActive) return false;
		if (!this.lastApiSuccessAt) return false;
		if (this.retryActive) return false;
		return true;
	}

	refreshFooter(): void {
		if (!this.lastContext?.hasUI) return;
		let text: string;
		if (this.isConnected()) {
			text = `Telegram Connected · ${this.botRef}`;
			const qLen = this.getQueueLength();
			if (qLen > 0) text = `${text} · ${qLen} queued`;
		} else if (this.pollRequestInFlight) {
			text = `${POLL_SPINNER_FRAMES[this.pollSpinnerIndex]} Telegram Connecting`;
		} else if (this.retryActive) {
			text = `Telegram Disconnected · retrying in ${Math.floor(RETRY_INTERVAL_MS / 1000)}s`;
		} else {
			text = "Telegram Disconnected";
		}
		this.lastContext.ui.setStatus(STATUS_KEY, text);
	}

	clearFooter(): void {
		if (!this.lastContext?.hasUI) return;
		this.lastContext.ui.setStatus(STATUS_KEY, undefined as unknown as string);
	}

	// --- Error helpers ---

	isAbortError(error: unknown): boolean {
		return error instanceof Error && error.name === "AbortError";
	}

	isTransientDiscoveryError(error: unknown): boolean {
		if (this.isAbortError(error)) return true;
		if (!(error instanceof TelegramApiError)) return false;
		if (error.operation !== "getUpdates") return false;
		if (error.status === 409) return true;
		return error.failureClass === "network" || error.failureClass === "timeout" || error.failureClass === "transport";
	}

	async handleApiFailure(error: unknown, operation: string): Promise<void> {
		const normalized = error instanceof TelegramApiError
			? error
			: new TelegramApiError(error instanceof Error ? error.message : String(error), {
					failureClass: "unknown",
					connectionAffecting: true,
					operation,
				});
		if (!normalized.connectionAffecting) {
			report("api.failure.non_health", {
				operation,
				failureClass: normalized.failureClass,
				message: normalized.message,
			});
			return;
		}
		this.retryActive = true;
		this.retryAttempt += 1;
		if (!this.retryLogPath) this.retryLogPath = createRetryLogPath();
		const entry: FailureLogEntry = {
			timestamp: new Date().toISOString(),
			operation,
			attempt: this.retryAttempt,
			error_type: normalized.failureClass,
			error_message: normalized.message,
		};
		await appendFailureLog(this.retryLogPath, entry);
		report("api.failure", {
			operation,
			failureClass: normalized.failureClass,
			attempt: this.retryAttempt,
			logPath: this.retryLogPath,
		});
		this.refreshFooter();
	}

	recordApiSuccess(): void {
		this.lastApiSuccessAt = Date.now();
		this.retryActive = false;
		this.retryAttempt = 0;
		this.retryLogPath = null;
		this.refreshFooter();
	}

	// --- Telegram send/edit helpers ---

	async telegramSend(text: string): Promise<number | undefined> {
		if (!this.config || !this.api) return undefined;
		try {
			const message = await this.api.sendMessage(this.config.chatId, text);
			this.recordApiSuccess();
			return message.message_id;
		} catch (error) {
			await this.handleApiFailure(error, "sendMessage");
			return undefined;
		}
	}

	async telegramEdit(messageId: number, text: string): Promise<boolean> {
		if (!this.config || !this.api) return false;
		try {
			await this.api.editMessageText(this.config.chatId, messageId, text);
			this.recordApiSuccess();
			return true;
		} catch (error) {
			await this.handleApiFailure(error, "editMessageText");
			return false;
		}
	}

	// --- Status reports ---

	buildStatusReport(): RelayStatusReport {
		return {
			connection: this.isConnected() ? "connected" : "disconnected",
			enabled: this.config?.enabled ?? false,
			bot_username: this.config?.botUsername ?? "none",
			bot_id: this.config?.botId ?? "none",
			chat_id: this.config?.chatId ?? "none",
			allowed_user_ids: this.config ? this.config.allowedUserIds.join(",") : "none",
			queue_length: 0, // overridden by controller
			active_progress_message_id: "none", // overridden by controller
			last_api_success_at: this.lastApiSuccessAt ? new Date(this.lastApiSuccessAt).toISOString() : "none",
			retry_state: this.retryActive ? "active" : "inactive",
			failure_log_path: this.retryLogPath ?? "none",
		};
	}

	buildStatusText(): string {
		const r = this.buildStatusReport();
		return [
			`connection: ${r.connection}`,
			`enabled: ${String(r.enabled)}`,
			`bot_username: ${String(r.bot_username)}`,
			`bot_id: ${String(r.bot_id)}`,
			`chat_id: ${String(r.chat_id)}`,
			`allowed_user_ids: ${String(r.allowed_user_ids)}`,
			`queue_length: ${String(r.queue_length)}`,
			`active_progress_message_id: ${String(r.active_progress_message_id)}`,
			`last_api_success_at: ${String(r.last_api_success_at)}`,
			`retry_state: ${r.retry_state}`,
			`failure_log_path: ${String(r.failure_log_path)}`,
		].join("\n");
	}

	buildCommandHelpText(): string {
		const connection = this.isConnected() ? "connected" : this.pollRequestInFlight ? "connecting" : "disconnected";
		const enabled = this.config?.enabled ? "on" : "off";
		const chat = this.config?.chatId ?? "not configured";
		const allowedUsers = this.config ? this.config.allowedUserIds.join(", ") || "none" : "not configured";
		const lastActivity = this.lastApiSuccessAt ? formatTimeAgo(this.lastApiSuccessAt) : "never";
		return [
			"Telegram relay",
			`Status: ${connection} (${enabled})`,
			`Bot: ${this.config ? this.botRef : "not configured"}`,
			`Chat: ${String(chat)}`,
			`Allowed users: ${allowedUsers}`,
			`Last activity: ${lastActivity}`,
			"",
			"Commands:",
			"/telegram connect — guided setup",
			"/telegram status — raw deterministic state report",
			"/telegram test — verify outbound and inbound relay",
			"/telegram toggle — enable or disable the relay",
			"/telegram logout — remove saved credentials",
			"/telegram clear — clear Telegram footer and working messages from the TUI",
		].join("\n");
	}
}
