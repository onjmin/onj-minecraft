import type { AgentProfile } from "../profiles/types";
import { llm } from "./llm-client";

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
export async function emitDiscordWebhook(payload: WebhookPayload): Promise<void> {
	if (!DISCORD_WEBHOOK_URL) return;

	try {
		await fetch(DISCORD_WEBHOOK_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (e) {
		console.error("[DiscordLog] Failed to send:", e);
	}
}

// 翻訳関数
export async function translateText(text: string) {
	try {
		const response = await fetch("http://localhost:5000/translate", {
			method: "POST",
			body: JSON.stringify({
				q: text,
				source: "en",
				target: "ja",
				format: "text",
			}),
			headers: { "Content-Type": "application/json" },
		});

		const data = await response.json();
		return data.translatedText;
	} catch (error) {
		console.error("Translation Error:", error);
		return text; // 失敗時は原文を返す
	}
}

/**
 * 英語のテキストを、エージェントの性格（roleplayPrompt）に基づいて
 * 日本語になりきり翻訳する。
 */
export async function translateWithRoleplay(
	englishText: string,
	profile: AgentProfile,
): Promise<string> {
	// 翻訳フラグや空文字チェック
	if (!englishText.trim()) return englishText;

	const prompt = `
# 命令書
以下の英文（エージェントの思考や行動）を、指定されたキャラクターの口調で自然な日本語に翻訳してください。

# キャラクター設定
- 名前: ${profile.displayName}
- 性格設定: ${profile.personality}
- 口調・なりきり指針: ${profile.roleplayPrompt}

# 翻訳対象の英文
${englishText}

# 制約事項
- 絵文字やフォーマットはそのまま維持すること。
- 解説やメタな発言（「〜と訳しました」など）は一切含めないこと。
- 必ず「口調・なりきり指針」を最優先し、そのキャラが本当に言いそうな表現にすること。
- 出力は翻訳後の日本語のみとすること。

# 翻訳後の日本語:
`;

	try {
		const translated = await llm.complete(prompt);
		// 稀に「」で囲んでくるモデルがあるので、不要な囲みを除去
		return translated.trim().replace(/^「(.*)」$/, "$1");
	} catch (e) {
		console.error(`[LLM] Roleplay translation failed for ${profile.displayName}:`, e);
		return englishText; // 失敗時は原文を返す
	}
}
