/**
 * 全スキルを直接呼んで、Driver 層が実サーバー上で動くことを確認するハーネス。
 *
 * LLM の思考ループに任せると、どのスキルが選ばれるかが運任せになり
 * 網羅性が担保できない。ここではボットを1体だけ繋ぎ、
 * DISABLE_AUTONOMY=1 でループを止めた上で各スキルを順に直接呼ぶ。
 *
 * 実行:
 *   DISABLE_AUTONOMY=1 npx tsx src/core/driver/skillcheck.ts
 *
 * 判定について:
 *   スキルが「失敗」を返すこと自体は異常ではない（材料が無い等）。
 *   検出したいのは TypeError や "is not a function" のような
 *   Driver 層の実装漏れ・移行漏れによるクラッシュ。
 */

import { profiles } from "../../profiles";
import { buildingBaseSkill } from "../../skills/building/base";
import { collectDirtSkill } from "../../skills/collecting/dirt";
import { huntAnimalsSkill } from "../../skills/collecting/hunting";
import { mineOresSkill } from "../../skills/collecting/mining";
import { stealFromChestSkill } from "../../skills/collecting/stealing";
import { collectStoneSkill } from "../../skills/collecting/stone";
import { collectWoodSkill } from "../../skills/collecting/wood";
import { craftSmeltingSkill } from "../../skills/crafting/smelting";
import { craftToolSkill } from "../../skills/crafting/tool";
import { craftTorchSkill } from "../../skills/crafting/torch";
import { craftWeaponSkill } from "../../skills/crafting/weapon";
import { exploreLandSkill } from "../../skills/exploring/land";
import { gotoBaseSkill } from "../../skills/goto/base";
import { gotoCoordsSkill } from "../../skills/goto/coords";
import { gotoPlayerSkill } from "../../skills/goto/player";
import { gotoSurfaceSkill } from "../../skills/goto/surface";
import { MinecraftAgent } from "../agent";

// 1スキルあたりの上限。設置系は tryPlaceBlock が候補ごとに待機を挟むため長めが要る。
const PER_SKILL_TIMEOUT_MS = Number(process.env.SKILLCHECK_TIMEOUT_MS ?? 25_000);

// SKILLCHECK_ONLY にカンマ区切りでスキル名を指定すると、そのスキルだけ実行する。
// 一部だけ追試したいときに全部回さずに済む。
const ONLY = (process.env.SKILLCHECK_ONLY ?? "")
	.split(",")
	.map((v) => v.trim())
	.filter(Boolean);

type Outcome = {
	name: string;
	verdict: "ok" | "skill-fail" | "crash" | "timeout";
	detail: string;
	ms: number;
};

/** Driver 層の実装漏れを示すエラーかどうか。 */
function looksLikeDriverBug(message: string): boolean {
	return /is not a function|Cannot read propert|undefined is not|TypeError|ReferenceError/i.test(
		message,
	);
}

async function main() {
	const profile = Object.values(profiles)[0];
	const agent = new MinecraftAgent(profile, []);

	console.log(`[skillcheck] ${profile.minecraftName} で接続中...`);
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("spawn タイムアウト(60秒)")), 60_000);
		agent.bot.once("spawn", () => {
			clearTimeout(t);
			resolve();
		});
		agent.bot.once("error", (e) => {
			clearTimeout(t);
			reject(e);
		});
	});
	// スポーン直後はチャンクが揃っていないので少し待つ。
	// 外部から RCON で材料を配る場合はこの間に行うため、長めに指定できるようにしている。
	const warmupMs = Number(process.env.SKILLCHECK_WARMUP_MS ?? 3000);
	console.log(`[skillcheck] ウォームアップ ${warmupMs}ms ...`);
	await new Promise((r) => setTimeout(r, warmupMs));

	const state = agent.driver.getState();
	console.log(
		`[skillcheck] スポーン完了 pos=(${state.position.x.toFixed(1)}, ${state.position.y.toFixed(1)}, ${state.position.z.toFixed(1)}) dim=${state.dimension}`,
	);

	// goto.coords は引数が要るので、現在地の少し先を目標にする
	const cases: { skill: any; args?: any }[] = [
		{ skill: exploreLandSkill },
		{ skill: gotoSurfaceSkill },
		{
			skill: gotoCoordsSkill,
			args: {
				x: Math.floor(state.position.x) + 5,
				y: Math.floor(state.position.y),
				z: Math.floor(state.position.z) + 5,
			},
		},
		{ skill: gotoPlayerSkill },
		{ skill: gotoBaseSkill },
		{ skill: collectWoodSkill },
		{ skill: collectDirtSkill },
		{ skill: collectStoneSkill },
		{ skill: mineOresSkill },
		{ skill: huntAnimalsSkill },
		{ skill: stealFromChestSkill },
		{ skill: craftToolSkill },
		{ skill: craftWeaponSkill },
		{ skill: craftTorchSkill },
		{ skill: craftSmeltingSkill },
		{ skill: buildingBaseSkill },
	];

	const targets = ONLY.length > 0 ? cases.filter((c) => ONLY.includes(c.skill.name)) : cases;
	if (ONLY.length > 0) {
		console.log(`[skillcheck] 対象を ${targets.length} 件に絞り込み: ${ONLY.join(", ")}`);
	}

	const results: Outcome[] = [];

	for (const { skill, args } of targets) {
		const controller = new AbortController();
		const t0 = Date.now();
		let outcome: Outcome;

		try {
			const timer = setTimeout(() => controller.abort(), PER_SKILL_TIMEOUT_MS);
			const res = await Promise.race([
				skill.handler({ agent, signal: controller.signal, args: args ?? {} }),
				new Promise((_, rej) =>
					setTimeout(() => rej(new Error("__TIMEOUT__")), PER_SKILL_TIMEOUT_MS + 5000),
				),
			]);
			clearTimeout(timer);
			outcome = {
				name: skill.name,
				verdict: res.success ? "ok" : "skill-fail",
				detail: res.success ? res.summary : (res.error ?? res.summary),
				ms: Date.now() - t0,
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			outcome = {
				name: skill.name,
				verdict:
					msg === "__TIMEOUT__" ? "timeout" : looksLikeDriverBug(msg) ? "crash" : "skill-fail",
				detail: msg,
				ms: Date.now() - t0,
			};
		}

		results.push(outcome);
		const mark = { ok: "✅", "skill-fail": "⚠️ ", crash: "❌", timeout: "⏱ " }[outcome.verdict];
		console.log(
			`  ${mark} ${outcome.name.padEnd(28)} ${String(outcome.ms).padStart(6)}ms  ${outcome.detail.slice(0, 90)}`,
		);

		// 次のスキルへ影響しないよう停止させる
		agent.cancelAllTasks();
		await new Promise((r) => setTimeout(r, 1200));
	}

	console.log("\n================ 結果 ================");
	const crashes = results.filter((r) => r.verdict === "crash");
	const oks = results.filter((r) => r.verdict === "ok");
	const fails = results.filter((r) => r.verdict === "skill-fail");
	const timeouts = results.filter((r) => r.verdict === "timeout");

	console.log(`成功         : ${oks.length}`);
	console.log(`スキル失敗   : ${fails.length}  (材料不足など。Driver層の問題ではない)`);
	console.log(`タイムアウト : ${timeouts.length}`);
	console.log(`クラッシュ   : ${crashes.length}  <- Driver層の実装漏れ`);

	if (crashes.length > 0) {
		console.log("\n--- クラッシュ詳細 ---");
		for (const c of crashes) console.log(`  ${c.name}: ${c.detail}`);
	}

	agent.bot.quit();
	process.exit(crashes.length === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("[skillcheck] 起動に失敗:", e);
	process.exit(2);
});
