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
import { profiles } from "../profiles";
import { gotoCoordsSkill } from "../skills/goto/coords";
import { gotoPlayerSkill } from "../skills/goto/player";

// 統合版で現状動くスキルのみを渡す。
// exploring.explore_land は地形サンプリングに world.blockAt を使うため、
// チャンク解析(M3)が入るまでは失敗し続ける。入れると暴走するので外してある。
// 採掘・クラフト・建築系も同様に M3 以降。
const bedrockSkills = [gotoCoordsSkill, gotoPlayerSkill];

async function main() {
	const invite = process.env.REALM_INVITE;
	if (!invite) throw new Error("REALM_INVITE を指定してください");

	const profile = Object.values(profiles)[0];

	const driver = new BedrockDriver({
		realmInvite: invite,
		onMsaCode: (m) => console.log("要サインイン:", m),
	});

	const agent = new MinecraftAgent(profile, bedrockSkills, driver);

	console.log(`[bedrock] ${profile.displayName} を Realm に接続します...`);
	await driver.connect();
	console.log("[bedrock] スポーン完了。ループを開始します。");

	// 統合版は接続完了のタイミングを呼び出し側が握っているので明示的に起動する
	agent.startLoops();

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
