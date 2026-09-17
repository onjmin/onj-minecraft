/**
 * ローカルの開発サーバーで、生存ループを決まった条件で回して結果を採点する。
 *
 * これまで変更の確認は「本番 Realm で8時間動かして、ログを目で読む」しか
 * 無かった。世界も時刻も湧きも毎回違うので、良くなったのか運が良かったのか
 * 区別できない。しかも1回の確認に8時間かかるので、変更の方が速く積み上がる。
 * 5日ぶんのログで死亡率が動かなかったのは、確かめ方の問題でもある。
 *
 * ここは「本番へ繋ぐ前に通す関門」。世界の内容までは固定できないが、
 * 制御ループの壊れ方(止まる・握りっぱなし・空振りし続ける)はここで捕まる。
 * 実際、2026-09-17 の4時間26分の停止は、この採点があれば10分で落ちていた。
 *
 * 実行:
 *   docker compose -f docker-compose.bedrock-dev.yml up -d
 *   pnpm scenario                       # 既定10分
 *   SCENARIO_MINUTES=30 pnpm scenario
 *
 * 本番 Realm には繋がない。接続先はローカル固定にしてある。
 */
import { MinecraftAgent } from "../core/agent";
import { BedrockDriver } from "../core/driver/bedrock";
import { kusabot } from "../profiles/kusabot";
import { bedrockSkills } from "./bedrock-skills";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
// Windows から WSL の Docker へは UDP が転送されないため、既定で WSL 経由にする。
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
const MINUTES = Number(process.env.SCENARIO_MINUTES ?? 10);

/**
 * 合格の条件。
 *
 * 世界の運に左右されない、制御ループそのものの健全性だけを見る。
 * 「何回死んだか」は湧き方で変わるので、ここでは落第の理由にしない。
 */
const THRESHOLDS = {
	/** スキルが1つも動かない時間の上限。停止の検知。 */
	longestStallMs: Number(process.env.MAX_STALL_MS ?? 5 * 60_000),
	/** 生存側が担当を握っていない時間の下限(割合)。握りっぱなしの検知。 */
	minSkillIdleRatio: Number(process.env.MIN_IDLE_RATIO ?? 0.3),
	/** スキルの空振り率の上限。何も変わらない行動の繰り返しの検知。 */
	maxEmptyRatio: Number(process.env.MAX_EMPTY_RATIO ?? 0.6),
	/** 最低でもこれだけはスキルが動いていること。 */
	minSkillRuns: Number(process.env.MIN_SKILL_RUNS ?? 5),
};

async function main() {
	if (!ADDRESS.startsWith("127.0.0.1") && !ADDRESS.startsWith("localhost")) {
		throw new Error(`scenario はローカル専用です (BEDROCK_ADDRESS=${ADDRESS})`);
	}

	const driver = new BedrockDriver({ address: ADDRESS, viaWsl: VIA_WSL, name: "scenariobot" });
	const agent = new MinecraftAgent(kusabot, bedrockSkills as any[], driver);

	console.log(`[scenario] ${ADDRESS} に接続します`);
	await driver.connect();
	console.log(`[scenario] スポーン完了: ${driver.getState().username}`);
	agent.startLoops();

	const until = Date.now() + MINUTES * 60_000;
	while (Date.now() < until) {
		await new Promise((r) => setTimeout(r, 15_000));
	}

	agent.cancelAllTasks();
	const summary = agent.metricsSummary();
	await driver.disconnect();

	const runs = Object.values(summary.skills).reduce((sum, s) => sum + s.runs, 0);
	const empty = Object.values(summary.skills).reduce((sum, s) => sum + s.empty, 0);
	const emptyRatio = runs > 0 ? empty / runs : 0;

	const results = [
		{
			label: "スキルが止まっていない",
			ok: summary.longestStallMs <= THRESHOLDS.longestStallMs,
			detail: `最長停滞 ${(summary.longestStallMs / 60_000).toFixed(1)}分 (上限 ${(THRESHOLDS.longestStallMs / 60_000).toFixed(1)}分)`,
		},
		{
			label: "生存側が担当を握りっぱなしにしていない",
			ok: summary.skillIdleRatio >= THRESHOLDS.minSkillIdleRatio,
			detail: `スキル可 ${(summary.skillIdleRatio * 100).toFixed(0)}% (下限 ${(THRESHOLDS.minSkillIdleRatio * 100).toFixed(0)}%)`,
		},
		{
			label: "スキルが実際に動いている",
			ok: runs >= THRESHOLDS.minSkillRuns,
			detail: `${runs}回 (下限 ${THRESHOLDS.minSkillRuns}回)`,
		},
		{
			label: "空振りを繰り返していない",
			ok: emptyRatio <= THRESHOLDS.maxEmptyRatio,
			detail: `空振り ${(emptyRatio * 100).toFixed(0)}% (上限 ${(THRESHOLDS.maxEmptyRatio * 100).toFixed(0)}%)`,
		},
	];

	console.log("");
	console.log(`[scenario] ${MINUTES}分の結果`);
	for (const r of results) {
		console.log(`${r.ok ? "  OK  " : " FAIL "} ${r.label} — ${r.detail}`);
	}
	console.log(`[scenario] 食事 ${summary.meals} 回 / 死亡 ${summary.deaths} 回`);
	console.log(`[scenario] 担当の内訳: ${JSON.stringify(summary.controlMsByRule)}`);
	console.log(JSON.stringify(summary, null, 2));

	const failed = results.filter((r) => !r.ok).length;
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("[scenario] 失敗:", err);
	process.exit(1);
});
