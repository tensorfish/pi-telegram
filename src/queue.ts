import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { QueuedTelegramInput } from "./types.ts";
import { report } from "./relay.ts";

export class PromptQueue {
	private items: QueuedTelegramInput[] = [];
	private index = new Map<number, QueuedTelegramInput>();
	private nextSeq = 1;

	constructor(private readonly pi: ExtensionAPI) {}

	get length(): number {
		return this.items.length;
	}

	/** Accept a new Telegram prompt into the queue. */
	enqueue(text: string, telegramMessageId: number, senderId: number): QueuedTelegramInput {
		const seq = this.nextSeq++;
		const item: QueuedTelegramInput = {
			seq,
			telegramMessageId,
			senderId,
			text,
			acceptedAt: Date.now(),
			dispatched: false,
		};
		this.items.push(item);
		this.index.set(telegramMessageId, item);
		report("telegram.queue.accepted", { seq, telegramMessageId, senderId, text, queueLength: this.items.length });
		return item;
	}

	/** Try to edit a queued item before it has been dispatched. Returns true if edited. */
	tryEdit(telegramMessageId: number, newText: string): boolean {
		const queued = this.index.get(telegramMessageId);
		if (!queued || queued.dispatched) {
			report("telegram.edit.ignored", { messageId: telegramMessageId });
			return false;
		}
		queued.text = newText;
		report("telegram.queue.updated", { messageId: telegramMessageId, seq: queued.seq, text: queued.text });
		return true;
	}

	/**
	 * Dispatch the next queued item as a follow-up inside the current run.
	 * Returns true if an item was dispatched.
	 */
	flushOneAsFollowUp(): boolean {
		if (this.items.length === 0) return false;
		const next = this.items[0];
		if (!next || next.dispatched) return false;
		try {
			this.pi.sendUserMessage(next.text, { deliverAs: "followUp" });
			next.dispatched = true;
			this.items.shift();
			this.index.delete(next.telegramMessageId);
			report("telegram.queue.dispatched", { seq: next.seq, telegramMessageId: next.telegramMessageId, mode: "followUp", queueLength: this.items.length });
			return true;
		} catch (error) {
			report("telegram.queue.dispatch_failed", {
				seq: next.seq,
				telegramMessageId: next.telegramMessageId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Dispatch the next queued item as a new prompt when idle.
	 * Returns true if an item was dispatched.
	 */
	promoteOneToNewRun(): boolean {
		if (this.items.length === 0) return false;
		const next = this.items[0];
		if (!next) return false;
		try {
			this.pi.sendUserMessage(next.text);
			this.items.shift();
			this.index.delete(next.telegramMessageId);
			report("telegram.queue.promoted_to_new_run", { seq: next.seq, telegramMessageId: next.telegramMessageId });
			return true;
		} catch (error) {
			report("telegram.queue.promote_failed", {
				seq: next.seq,
				telegramMessageId: next.telegramMessageId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Try to dispatch immediately when idle. If sendUserMessage throws,
	 * enqueue instead so the item isn't lost.
	 */
	dispatchOrEnqueue(text: string, telegramMessageId: number, senderId: number): boolean {
		try {
			this.pi.sendUserMessage(text);
			report("telegram.dispatch.immediate", { telegramMessageId, senderId, text });
			return true;
		} catch (error) {
			report("telegram.dispatch.immediate_failed", {
				telegramMessageId,
				senderId,
				error: error instanceof Error ? error.message : String(error),
			});
			this.enqueue(text, telegramMessageId, senderId);
			return false;
		}
	}
}
