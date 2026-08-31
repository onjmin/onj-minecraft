/**
 * 統合版(Bedrock)Realms でエージェントを1体動かす入り口。
 *
 * 実行:
 *   REALM_INVITE=https://realms.gg/xxxx npx tsx src/workflow/bedrock.ts
 *
 * Java版(src/workflow/index.ts)との違いは、mineflayer のボットを作らず
 * BedrockDriver を注入する点だけ。LLM層・プロフィール・スキルは共通のものを使う。
 *
 * 接続とプロトコルは Go サイドカーが持つ。移動・状態・持ち物・エンティティ・
 * 発言・ワールド読み取り・採掘・設置・クラフト・攻撃まで通っている。
 */
import { MinecraftAgent } from "../core/agent";
import { BedrockDriver } from "../core/driver/bedrock";
import { kusabot } from "../profiles/kusabot";
import { buildingBaseSkill } from "../skills/building/base";
import { collectDirtSkill } from "../skills/collecting/dirt";
import { huntAnimalsSkill } from "../skills/collecting/hunting";
import { mineOresSkill } from "../skills/collecting/mining";
import { collectStoneSkill } from "../skills/collecting/stone";
import { collectWoodSkill } from "../skills/collecting/wood";
import { craftSmeltingSkill } from "../skills/crafting/smelting";
import { craftToolSkill } from "../skills/crafting/tool";
import { craftTorchSkill } from "../skills/crafting/torch";
import { craftWeaponSkill } from "../skills/crafting/weapon";
import { exploreLandSkill } from "../skills/exploring/land";
import { gotoBaseSkill } from "../skills/goto/base";
import { gotoCoordsSkill } from "../skills/goto/coords";
import { gotoDeathPointSkill } from "../skills/goto/death";
import { gotoPlayerSkill } from "../skills/goto/player";
import { gotoSurfaceSkill } from "../skills/goto/surface";

// 統合版でもスキルは一通り動く。Driver 層が Java 版との差を吸収しているので
// skills/ 側は共通のものをそのまま使う。
//
// collecting.stealing だけ外している。中身を漁るのは他プレイヤーのチェストで、
// 本番の Realm では壊してよいものの範囲外だから。破壊や設置は許可されている。
const bedrockSkills = [
	// 死んだあとの回収を最優先で選べるようにしておく。持ち物は全部その場に
	// 落ち、5分ほどで消える。取りに戻らないと何を積んでも残らない。
	gotoDeathPointSkill,
	exploreLandSkill,
	gotoSurfaceSkill,
	gotoCoordsSkill,
	gotoPlayerSkill,
	gotoBaseSkill,
	collectWoodSkill,
	collectStoneSkill,
	collectDirtSkill,
	mineOresSkill,
	huntAnimalsSkill,
	craftToolSkill,
	craftWeaponSkill,
	craftTorchSkill,
	craftSmeltingSkill,
	buildingBaseSkill,
];

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
