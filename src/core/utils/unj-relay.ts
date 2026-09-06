/**
 * unj（うんでも実況J）上の人間の書き込みを、Minecraftのチャットへ中継する。
 * unj-bridge.ts（Minecraft→unj）と逆方向。
 *
 * unj-bridge.ts側と違い、unjはNetlify等の公開クラウドにあるのに対し
 * onj-minecraftはLAN内（.env.exampleのMINECRAFT_HOST/LLM_API_BASEが192.168.x.x）
 * で動く前提のため、unjからこちらへHTTPでpush通知することはできない
 * （NAT越しに待ち受けポートを晒す必要が出る）。そのため、こちら側から一定間隔
 * でunjに新着を尋ねに行くポーリング方式にしている。
 *
 * 発話は bot.chat() 相当（driver.chat、agent.relaySpeak）のみを使う。
 * `/say` はサーバー管理者権限（op）が要るコマンドで、README/AGENTSに
 * 「検証は必ず一般アカウントで行う」とある通りボットのアカウントはopではない
 * 前提のため使えない。既存コードのどこにも/sayが無いのも同じ理由のはず。
 */
import { activeAgents } from "../agent.js";
import { envNum, envStr } from "./env.js";
import { fetchNewHumanRes, isUnjBridgeConfigured, markRelayed } from "./unj-bridge.js";

const UNJ_RELAY_POLL_MS = envNum("UNJ_RELAY_POLL_MS", 8000);
// ゲーム内チャットの発言上限に合わせる（conversation.tsのCHAT_MAX_CHARSと同じ既定値）
const CHAT_MAX_CHARS = envNum("CHAT_MAX_CHARS", 160);
// 未指定なら起動順で最初に登録されたエージェントが喋る
const UNJ_RELAY_MINECRAFT_NAME = envStr("UNJ_RELAY_MINECRAFT_NAME", "");

function pickRelayAgent() {
	if (UNJ_RELAY_MINECRAFT_NAME) {
		const found = activeAgents.find((a) => a.minecraftName === UNJ_RELAY_MINECRAFT_NAME);
		if (found) return found;
	}
	return activeAgents[0];
}

function formatForGame(ccUserName: string, contentText: string): string {
	const name = ccUserName.trim() || "名無しさん";
	// ゲーム内チャットは改行を送れないので1行に畳む
	const text = contentText.replace(/\s+/g, " ").trim();
	const prefix = `[unj] ${name}: `;
	const budget = Math.max(1, CHAT_MAX_CHARS - prefix.length);
	const body = text.length > budget ? `${text.slice(0, budget - 1)}…` : text;
	return `${prefix}${body}`;
}

let polling = false;

async function pollOnce(): Promise<void> {
	if (polling) return; // 前回の巡回が詰まっていたら重ねない
	polling = true;
	try {
		const fetched = await fetchNewHumanRes();
		if (!fetched || fetched.list.length === 0) return;
		const { threadId, list } = fetched;

		const agent = pickRelayAgent();
		if (!agent) return; // まだどのエージェントも起動していない

		for (const item of list) {
			try {
				await agent.relaySpeak(formatForGame(item.ccUserName, item.contentText));
			} catch (e) {
				console.error("[UnjRelay] Failed to speak:", e);
				// この1件は喋れなかったが、番号だけは進めて無限リトライを避ける
			}
			markRelayed(threadId, item.num);
		}
	} catch (e) {
		console.error("[UnjRelay] Poll failed:", e);
	} finally {
		polling = false;
	}
}

/**
 * ポーリングを開始する。UNJ_BASE_URL/UNJ_ADMIN_API_KEYが未設定なら何もしない。
 * workflow/index.ts からエージェント起動後に1回だけ呼ぶこと。
 */
export function startUnjRelayPolling(): void {
	if (!isUnjBridgeConfigured()) return;
	setInterval(() => {
		void pollOnce();
	}, UNJ_RELAY_POLL_MS);
}
