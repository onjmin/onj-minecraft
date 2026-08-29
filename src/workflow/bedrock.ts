/**
 * 統合版(Bedrock)Realms でエージェントを1体動かす入り口。
 *
 * 実行:
 *   REALM_INVITE=https://realms.gg/xxxx npx tsx src/workflow/bedrock.ts
 *
 * Java版(src/workflow/index.ts)との違いは、mineflayer のボットを作らず
 * BedrockDriver を注入する点だけ。LLM層・プロフィール・スキルは共通のものを使う。
 *
 * 統合版はまだ world / dig / craft / placeBlock が未実装なため、
 * 到達できるのは移動・探索・会話まで。未実装のスキルは実行時に
 * 明示的なエラーを返して失敗として記録される。
 */
import { MinecraftAgent } from "../core/agent";
import { BedrockDriver } from "../core/driver/bedrock";
import { kusabot } from "../profiles/kusabot";

// 統合版で現在動かせるスキルは無い。
//
// - 移動系: player_auth_input のスキーマがサーバーの版に追いついておらず、
//   送ると malformed 判定で切断される。BedrockDriver 側で明示的に落とす。
// - world 依存(探索/採掘/建築/クラフト): チャンク解析が未実装。
//
// 接続・状態読み取り・会話は送信に依存しないため問題なく動く。
// いまの統合版エージェントは「その場から動かないが会話はできる」状態。
// 上流のスキーマが更新されたら移動系から戻す。
const bedrockSkills: unknown[] = [];

async function main() {
	const invite = process.env.REALM_INVITE;
	if (!invite) throw new Error("REALM_INVITE を指定してください");

	// 統合版は1体だけで、話し相手は日本語話者の人間。
	// 複数体の社会シミュレーション向けに書かれた既存キャラではなく専用の人格を使う。
	const profile = kusabot;

	const driver = new BedrockDriver({
		realmInvite: invite,
		onMsaCode: (m) => console.log("要サインイン:", m),
	});

	const agent = new MinecraftAgent(profile, bedrockSkills as any[], driver);

	console.log(`[bedrock] ${profile.displayName} を Realm に接続します...`);
	await driver.connect();
	console.log("[bedrock] スポーン完了。ループを開始します。");

	// 統合版は接続完了のタイミングを呼び出し側が握っているので明示的に起動する
	agent.startLoops();

	// 切断に気づかず空回りし続けるのを防ぐ。
	// BedrockX は接続断を必ずしもイベントで教えてくれないため、
	// Driver 側の無通信監視も含めてここで受ける。
	driver.on("end", (reason: string) => {
		console.log(`[bedrock] 切断されました: ${reason}`);
		console.log("[bedrock] 直近に受信したパケット:");
		for (const line of driver.recentPackets.slice(-25)) console.log(`  ${line}`);
		agent.cancelAllTasks();
		process.exit(1);
	});

	const shutdown = async () => {
		console.log("\n[bedrock] 終了します");
		agent.cancelAllTasks();
		await driver.disconnect();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// 実行時間の上限。未指定なら回し続ける。
	const limit = Number(process.env.RUN_SECONDS ?? 0);
	if (limit > 0) {
		setTimeout(shutdown, limit * 1000);
	}
}

main().catch((e) => {
	console.error("[bedrock] 起動に失敗:", e);
	process.exit(1);
});
