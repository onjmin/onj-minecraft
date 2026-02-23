const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";

interface WebhookPayload {
	content: string;
	username?: string;
	avatar_url?: string;
}

/**
 * Discord Webhook を送信する
 * 引数が文字列の場合はそのまま content とし、
 * オブジェクトの場合は詳細なパラメータを設定する。
 */
export async function emitDiscordWebhook(payload: string | WebhookPayload): Promise<void> {
	if (!DISCORD_WEBHOOK_URL) return;

	// 文字列が渡された場合のフォールバック
	const body = typeof payload === "string" ? { content: payload } : payload;

	try {
		await fetch(DISCORD_WEBHOOK_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (e) {
		console.error("[DiscordLog] Failed to send:", e);
	}
}
