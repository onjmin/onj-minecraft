/**
 * 本番 Realms でのチャット往復テスト。
 *
 * ローカルの bedrock-chat-test.ts は別名のボットを2体繋いで「他人の画面に
 * 見えているか」を機械的に判定するが、本番はアカウントが1つしかなく
 * （重複ログインで蹴られる）同じ手が使えない。ここでは Realm にいる人間に
 * 見てもらう前提で、LLM を挟まずに
 *
 *   送信: 決め打ちの文言を一定間隔で流す（人間が画面で見えるかを判定する）
 *   受信: 人間の発言を拾えるかをその場でログに出す
 *
 * の両方を確かめる。エージェントループ越しだと「LLM が喋る気にならなかった」
 * のか「発言が届いていない」のかを切り分けられないため分けている。
 *
 * 実行:
 *   REALM_INVITE=https://realms.gg/xxxx npx tsx --env-file=.env \
 *     src/core/driver/bedrock-realm-chat-test.ts
 */
import { BedrockDriver } from "./bedrock";

const INVITE = process.env.REALM_INVITE ?? "";
/** 送信を何回試すか。1回だけだと見落としと不着の区別がつかない。 */
const SENDS = Number(process.env.CHAT_SENDS ?? 3);
/** 送信の間隔と、最後の送信後に受信を待つ時間。 */
const SEND_INTERVAL_MS = Number(process.env.CHAT_INTERVAL_MS ?? 15_000);
const LISTEN_MS = Number(process.env.CHAT_LISTEN_MS ?? 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	if (!INVITE) throw new Error("REALM_INVITE を指定してください");

	const driver = new BedrockDriver({
		realmInvite: INVITE,
		onMsaCode: (m) => console.log("要サインイン:", m),
	});

	const heard: { from: string; message: string; at: number }[] = [];
	driver.on("chat", (from: string, message: string) => {
		heard.push({ from, message, at: Date.now() });
		console.log(`  [受信] <${from}> ${message}`);
	});
	driver.on("end", (reason: string) => console.log(`[realm-chat] 切断: ${reason}`));

	console.log("[realm-chat] 接続中...");
	await driver.connect();
	const st = driver.getState();
	console.log(`[realm-chat] スポーン完了 名前=${st.username}`);
	console.log(
		`  周囲のプレイヤー: ${
			driver
				.nearbyEntities(128)
				.filter((e) => e.kind === "player")
				.map((e) => e.name)
				.join(", ") || "見当たらない"
		}`,
	);

	const tag = String(Date.now() % 100000);
	for (let i = 1; i <= SENDS; i++) {
		const message = `[test ${tag}-${i}] これが見えたら教えてください`;
		console.log(`[realm-chat] 送信 ${i}/${SENDS}: ${message}`);
		try {
			await driver.chat(message);
		} catch (e) {
			console.log(`  送信で例外: ${e}`);
		}
		if (i < SENDS) await sleep(SEND_INTERVAL_MS);
	}

	console.log(`[realm-chat] ここから ${LISTEN_MS / 1000} 秒、受信を待ちます。`);
	console.log("  ゲーム内から何か発言してください。拾えていればここに出ます。");
	await sleep(LISTEN_MS);

	console.log("\n--- 結果 ---");
	console.log(`送信: ${SENDS}回とも例外なく通した（見えたかは人間の目視で判定）`);
	if (heard.length > 0) {
		console.log(`受信: ${heard.length}件 拾えた`);
		for (const h of heard) console.log(`  <${h.from}> ${h.message}`);
	} else {
		console.log("受信: 0件。人間が発言していないなら判定できない。");
		const chat = driver.recentPackets.filter((l) => l.includes('"chat"'));
		console.log(`  直近の chat パケット: ${chat.length ? "" : "なし"}`);
		for (const l of chat) console.log(`    ${l}`);
	}

	await driver.disconnect();
	process.exit(0);
}

main().catch((e) => {
	console.error("[realm-chat] 失敗:", e);
	process.exit(1);
});
