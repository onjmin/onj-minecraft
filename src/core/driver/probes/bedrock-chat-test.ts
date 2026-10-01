/**
 * 発言が他プレイヤーに届くかを、ボット2体で確かめる。
 *
 * 本番の Realms ではアカウントが1つしかなく（重複ログインで蹴られる）、
 * 「他人の画面に見えているか」を自分で確認できなかった。ローカルの
 * online-mode=false なサーバーなら別名で何体でも繋げるので、片方に喋らせて
 * もう片方で受け取れるかを見れば、その切り分けができる。
 *
 * 結果の読み方:
 *   届く   → パケットもクライアント側の描画も正常。本番で見えないのは
 *            Xbox/アカウント層の問題に絞られる。
 *   届かない → 手元で再現するバグ。ここで直せる。
 *
 * 実行(WSL の Docker で開発サーバーを起動してから):
 *   docker compose -f docker-compose.bedrock-dev.yml up -d
 *   npx tsx src/core/driver/bedrock-chat-test.ts
 */
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
// Windows から WSL の Docker へは UDP が転送されないため、既定で WSL 経由にする。
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const speaker = new BedrockDriver({
		address: ADDRESS,
		name: "kusabot",
		viaWsl: VIA_WSL,
	});
	const listener = new BedrockDriver({
		address: ADDRESS,
		name: "watcher",
		viaWsl: VIA_WSL,
	});

	const heard: { from: string; message: string }[] = [];
	listener.on("chat", (from: string, message: string) => {
		heard.push({ from, message });
		console.log(`  [watcher が受信] <${from}> ${message}`);
	});

	console.log(`[chat-test] ${ADDRESS} へ2体つなぎます（WSL経由: ${VIA_WSL}）`);
	// 同時に繋ぐと RakNet のハンドシェイクがぶつかることがあるので順に繋ぐ。
	await listener.connect();
	console.log("[chat-test] watcher が参加しました");
	await speaker.connect();
	console.log("[chat-test] kusabot が参加しました");

	// 互いを認識するまで少し待つ
	await sleep(3000);
	const seen = listener.nearbyEntities(128).map((e) => e.name);
	console.log(`  watcher から見えるエンティティ: ${seen.join(", ") || "なし"}`);

	const message = `発言テスト ${Date.now() % 100000}`;
	console.log(`[chat-test] kusabot が発言します: ${message}`);
	await speaker.chat(message);

	await sleep(5000);

	const got = heard.find((h) => h.message.includes(message));
	if (got) {
		console.log(`\n届きました（送信者: ${got.from}）`);
		console.log("→ パケットもクライアント側の受信も正常。本番で見えない原因は");
		console.log("  Xbox/アカウント層に絞られる。");
	} else {
		console.log("\n届きませんでした");
		console.log("→ 手元で再現するバグ。received のログを見て原因を追える。");
		console.log(`  watcher が受け取った発言: ${JSON.stringify(heard)}`);
		// サーバーが発言を受理したなら、送信者にも返ってくるはず。
		// 返ってこないなら受理そのものが失敗している。
		const dump = (label: string, lines: string[]) => {
			const chat = lines.filter((l) => l.includes('"chat"'));
			console.log(`  ${label}: ${chat.length ? "" : "なし"}`);
			for (const l of chat) console.log(`    ${l}`);
		};
		dump("kusabot 側の chat イベント(エコー)", speaker.recentPackets);
		dump("watcher 側の chat イベント", listener.recentPackets);
	}

	await speaker.disconnect();
	await listener.disconnect();
	process.exit(got ? 0 : 1);
}

main().catch((e) => {
	console.error("[chat-test] 失敗:", e);
	process.exit(1);
});
