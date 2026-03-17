import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractAssistantText, renderFinal, renderProgress, splitFinalText, summarizeToolAction, summarizeToolResult } from "./render.ts";
import { RelayConnection, report } from "./relay.ts";
import { CommandHandler } from "./commands.ts";
import { PromptQueue } from "./queue.ts";
import type { ActiveRunState, TelegramUpdate } from "./types.ts";

const MIN_PROGRESS_EDIT_INTERVAL_MS = 2_000;

type AssistantPhase = "waiting" | "llm" | "toolExecution" | "turnBoundary" | "ending";

export default function telegramExtension(pi: ExtensionAPI): void {
	const relay = new RelayConnection(pi);
	const commands = new CommandHandler(relay);
	const queue = new PromptQueue(pi);
	relay.getQueueLength = () => queue.length;

	let run: ActiveRunState | null = null;
	let nextRunId = 1;
	let assistantPhase: AssistantPhase = "waiting";
	let lastProgressEditAt = 0;

	// --- Telegram update dispatch ---

	async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
		if (!relay.config) return;
		const rawMessage = update.message ?? update.edited_message;
		if (!rawMessage) return;
		const isEdit = Boolean(update.edited_message);
		const senderId = rawMessage.from?.id;
		const chatId = rawMessage.chat.id;

		// Reject wrong chat
		if (chatId !== relay.config.chatId) {
			report("telegram.reject", { reason: "wrong_chat", chatId });
			return;
		}

		// Reject non-whitelisted or bot senders
		if (!senderId || !relay.config.allowedUserIds.includes(senderId) || rawMessage.from?.is_bot) {
			report("telegram.reject", { reason: "sender_not_allowed", senderId });
			return;
		}

		// Test reply check
		if (commands.pendingTest && Date.now() <= commands.pendingTest.expiresAt && rawMessage.text?.trim() === commands.pendingTest.code) {
			await commands.completeTestSuccess(senderId);
			return;
		}

		// Edits of queued items
		if (isEdit) {
			if (typeof rawMessage.text !== "string") {
				report("telegram.reject", { reason: "caption_or_non_text_edit", messageId: rawMessage.message_id });
				return;
			}
			queue.tryEdit(rawMessage.message_id, rawMessage.text);
			return;
		}

		// Only text messages count as prompts
		if (typeof rawMessage.text !== "string") {
			report("telegram.reject", { reason: "caption_or_non_text", messageId: rawMessage.message_id });
			return;
		}
		const text = rawMessage.text.trim();
		if (!text) return;

		// Remote commands
		if (commands.handleRemoteTelegramCommand(text)) return;

		// Prompt dispatch
		if (!run) {
			queue.dispatchOrEnqueue(text, rawMessage.message_id, senderId);
		} else {
			queue.enqueue(text, rawMessage.message_id, senderId);
			if (assistantPhase === "turnBoundary") queue.flushOneAsFollowUp();
		}
	}

	// --- Progress messaging ---

	async function ensureProgressMessage(): Promise<void> {
		if (!run || run.progressMessageId || !relay.config?.enabled) return;
		if (!relay.isConnected()) return;
		const text = renderProgress(run, Date.now());
		const messageId = await relay.telegramSend(text);
		if (!messageId) return;
		run.progressMessageId = messageId;
		run.lastRenderedText = text;
		lastProgressEditAt = Date.now();
		report("run.progress.created", { runId: run.id, messageId });
	}

	async function updateProgressMessage(): Promise<void> {
		if (!run || !relay.config?.enabled) return;
		await ensureProgressMessage();
		if (!run.progressMessageId) return;

		// Throttle edits to avoid rate limits
		const now = Date.now();
		if (now - lastProgressEditAt < MIN_PROGRESS_EDIT_INTERVAL_MS) return;

		const rendered = renderProgress(run, now);
		if (rendered === run.lastRenderedText) return;

		const ok = await relay.telegramEdit(run.progressMessageId, rendered);
		if (ok) {
			run.lastRenderedText = rendered;
			lastProgressEditAt = Date.now();
			report("run.progress.edited", { runId: run.id, messageId: run.progressMessageId });
		}
	}

	async function finalizeRun(): Promise<void> {
		if (!run || !relay.config?.enabled) return;
		await ensureProgressMessage();
		if (!run.progressMessageId) return;
		const finalText = renderFinal(run, Date.now());
		const chunks = splitFinalText(finalText);
		const first = chunks[0] ?? finalText;
		const ok = await relay.telegramEdit(run.progressMessageId, first);
		if (ok) report("run.finalized", { runId: run.id, messageId: run.progressMessageId, chunks: chunks.length });
		for (let i = 1; i < chunks.length; i++) {
			await relay.telegramSend(chunks[i]!);
		}
	}

	// --- Wire up handlers ---

	relay.setHandlers(handleTelegramUpdate, () => commands.expirePendingTestIfNeeded());

	pi.registerCommand("telegram", {
		description: "Manage the Telegram relay",
		handler: async (args, ctx) => {
			relay.rememberContext(ctx);
			await commands.handleTelegramCommand(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		relay.rememberContext(ctx);
		await commands.loadConfig();
		relay.ensureHealthTimer();
		// Send startup message before polling to avoid 409 race
		await relay.sendStartupConnectedMessageIfNeeded();
		await relay.ensureDesiredConnection();
		relay.refreshFooter();
		report("session_start", { configPresent: Boolean(relay.config), enabled: relay.config?.enabled ?? false });
	});

	pi.on("session_switch", async (_event, ctx) => {
		relay.rememberContext(ctx);
		relay.refreshFooter();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		relay.rememberContext(ctx);
		await relay.sendShutdownDisconnectedMessage();
		await relay.stopPolling();
		relay.clearHealthTimer();
		relay.clearFooter();
	});

	pi.on("input", async (event, ctx) => {
		relay.rememberContext(ctx);
		if (event.source === "interactive" || event.source === "rpc") {
			report("input.accepted", { source: event.source, busy: !ctx.isIdle(), text: event.text });
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		relay.rememberContext(ctx);
		run = {
			id: nextRunId++,
			startedAt: Date.now(),
			turnIndex: 1,
			actions: [],
		};
		assistantPhase = "llm";
		lastProgressEditAt = 0;
		report("run.start", { runId: run.id });
		await ensureProgressMessage();
		await updateProgressMessage();
	});

	pi.on("turn_start", async (event, ctx) => {
		relay.rememberContext(ctx);
		if (run) run.turnIndex = event.turnIndex + 1;
		assistantPhase = "llm";
		await updateProgressMessage();
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		relay.rememberContext(ctx);
		assistantPhase = "toolExecution";
		if (run) {
			run.actions.push({ id: event.toolCallId, label: summarizeToolAction(event.toolName, event.args), status: "running" });
		}
		await updateProgressMessage();
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		relay.rememberContext(ctx);
		assistantPhase = "toolExecution";
		if (run) {
			const existing = run.actions.find((a) => a.id === event.toolCallId);
			if (existing) {
				existing.status = event.isError ? "error" : "done";
			} else {
				run.actions.push({
					id: event.toolCallId,
					label: summarizeToolResult(event.toolName, null, event.result, event.isError),
					status: event.isError ? "error" : "done",
				});
			}
		}
		await updateProgressMessage();
	});

	pi.on("message_end", async (event, ctx) => {
		relay.rememberContext(ctx);
		if (!run) return;
		const message = event.message as { role?: unknown };
		if (message.role === "assistant") {
			const extracted = extractAssistantText(event.message);
			if (extracted.text.trim().length > 0) run.lastAssistantText = extracted.text;
			run.lastAssistantError = extracted.error;
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		relay.rememberContext(ctx);
		assistantPhase = "turnBoundary";
		queue.flushOneAsFollowUp();
		await updateProgressMessage();
	});

	pi.on("agent_end", async (event, ctx) => {
		relay.rememberContext(ctx);
		assistantPhase = "ending";
		if (run) {
			const lastAssistant = [...event.messages].reverse().find((m) => (m as { role?: unknown }).role === "assistant");
			if (lastAssistant) {
				const extracted = extractAssistantText(lastAssistant);
				if (extracted.text.trim().length > 0) run.lastAssistantText = extracted.text;
				run.lastAssistantError = extracted.error;
			}
			await finalizeRun();
		}
		run = null;
		assistantPhase = "waiting";
		queue.promoteOneToNewRun();
	});
}
