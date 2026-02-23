const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";
/**
 * 原文のまま Discord Webhook を送信する
 */
export async function emitDiscordWebhook(content: string): Promise<void> {
	if (!DISCORD_WEBHOOK_URL) return;

	try {
		await fetch(DISCORD_WEBHOOK_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		});
	} catch (e) {
		console.error("[DiscordLog] Failed to send:", e);
	}
}
