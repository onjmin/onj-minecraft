import { describeGain, gainedSince, snapshotInventory, totalGain } from "../inventory-delta";
import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * 1匹に粘ってよい時間。
 *
 * 素手(攻撃力1)で体力10の牛を倒すには10回要る。逃げる相手を追う移動も
 * 挟まるので、回数ではなく時間で区切る。届かない相手にいつまでも
 * 張り付かない程度に短く。
 */
const HUNT_BUDGET_MS = 20_000;
/** 攻撃の間隔。統合版に厳密なクールダウンは無いが、詰めすぎると弾かれる。 */
const ATTACK_INTERVAL_MS = 350;

/**
 * Collecting Domain: Hunting passive animals.
 * 収集ドメイン（狩猟）：食料や素材を得るために、周囲の動物を狩ります。
 */
export const huntAnimalsSkill = createSkill<void, { hunted: string; success: boolean }>({
	name: "collecting.hunting",
	description:
		"Finds and hunts nearby animals (cows, pigs, sheep, chickens) for food and materials.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ hunted: string; success: boolean }>> => {
		const { driver } = agent;
		const origin = driver.getState().position;
		// 成果は「殴ったか」ではなく「持ち物が増えたか」で見る。
		// 以前は動物に触れれば成功を返していたので、倒せていなくても、
		// 倒しても拾えていなくても成功として記録されていた。実測、
		// 全ログ通算で狩りの起動は34回あるのに食事は23回しかない。
		const before = snapshotInventory(driver);

		// 1. Target animals (passive mobs)
		// 対象とする動物のリスト
		const targetNames = ["cow", "pig", "sheep", "chicken", "rabbit"];
		const distanceTo = (p: { x: number; y: number; z: number }) =>
			Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z);
		const [target] = driver
			.nearbyEntities(32)
			.filter((e) => targetNames.includes(e.name))
			.sort((a, b) => distanceTo(a.position) - distanceTo(b.position));

		if (!target) {
			return skillResult.fail("No animals found nearby to hunt.");
		}

		try {
			// 2. Equip weapon (sword or axe)
			// 武器を装備（剣を優先、なければ斧）
			//
			// includes("axe") で探していたので pickaxe が引っかかっていた。
			// しかも find は持ち物の並び順で最初の1つを返すため、剣を持って
			// いてもツルハシが手前にあればそちらを持って殴りに行っていた。
			// ツルハシの攻撃力は素手と大差ない。順番に探して剣を優先する。
			const items = driver.inventory.items();
			const weapon =
				items.find((item) => item.name.endsWith("_sword")) ??
				items.find((item) => item.name.endsWith("_axe"));
			if (weapon) await driver.equip(weapon.name, "hand");

			// 3. Approach and attack until dead
			//
			// 回数の上限は6回だった。素手の攻撃力は1で、牛・豚・羊の体力は10。
			// つまり**素手では構造的に一度も倒せない**。木の剣(4)でも3回要る
			// ので、剣を持っていない間はここが必ず空振りになる。実測
			// 2026-09-17 16:31〜16:35、持ち物が dirt と gravel だけの状態で
			// 牛を5回殴りに行き、5回とも「何も拾えなかった」で終わっていた。
			// その間ずっと満腹度は7のまま。
			//
			// 倒せるまで殴る。ただし無限には粘らない。相手が消えた(倒した)か、
			// 時間切れで抜ける。逃げる動物を延々と追いかけるのも損なので、
			// 予算は短く取る。
			let lastPos = target.position;
			let attacks = 0;
			let killed = false;
			let lastError = "";
			let blocked = 0;
			const startedAt = Date.now();
			const until = startedAt + HUNT_BUDGET_MS;
			while (Date.now() < until) {
				if (signal.aborted) break;
				const current = driver.nearbyEntities(32).find((e) => e.id === target.id);
				if (!current) {
					killed = true;
					break;
				}
				lastPos = current.position;
				try {
					await driver.goto(signal, { kind: "follow", entityId: target.id, distance: 1.5 });
					await driver.attack(signal, target.id);
					attacks++;
					// 遮られた回数を数える。統合版は壁越しの攻撃を黙って
					// 無視するので、これが立っていれば「当たっていない」
					// 理由がそこにある。
					const d = driver as unknown as { lastAttackBlocked?: boolean };
					if (d.lastAttackBlocked) blocked++;
					await new Promise((r) => setTimeout(r, ATTACK_INTERVAL_MS));
				} catch (err) {
					// 止まった理由を残す。「遠すぎます」「間に障害物があって
					// 当たりません」のように、サイドカーが理由を返している。
					// 捨てると、外からは「殴ったのに減らない」としか見えない。
					lastError = err instanceof Error ? err.message : String(err);
					break;
				}
			}
			const spentSec = Math.round((Date.now() - startedAt) / 1000);
			agent.log(
				`[collecting.hunting] ${target.name} を ${attacks} 回攻撃 (${spentSec}秒) → ${killed ? "倒した" : "生きたまま"}${blocked > 0 ? ` / 遮蔽 ${blocked}回` : ""}${lastError ? ` / 中断: ${lastError}` : ""}`,
			);

			// 4. Wait a moment and collect drops (Reflex)
			// ドロップアイテムを拾うために移動（脊髄反射）
			await new Promise((r) => setTimeout(r, 500));
			try {
				await driver.goto(signal, { kind: "near", position: lastPos, distance: 1 });
				await driver.pickupNearbyItems(signal);
			} catch {}

			const gained = gainedSince(driver, before);
			if (totalGain(gained) === 0) {
				// 倒せていないのか、倒したのに拾えていないのか。同じ文面にすると
				// 次にどこを直すのか分からない。前者は武器と攻撃の届く距離の話、
				// 後者は拾う処理の話で、直す場所がまったく別になる。
				if (killed) {
					agent.noteStall(
						`The ${target.name} is gone but nothing was picked up: it either fled out of range or the drops were not collected.`,
					);
					return skillResult.fail(
						`The ${target.name} disappeared after ${attacks} hits but nothing was picked up.`,
					);
				}
				const why = lastError ? ` (stopped: ${lastError})` : "";
				agent.noteStall(
					`Could not kill a ${target.name} in ${attacks} hits over ${spentSec}s${why}; a better weapon, a clear line of sight, or getting closer is needed.`,
				);
				return skillResult.fail(
					`Could not kill a ${target.name}: ${attacks} hits in ${spentSec}s and it is still alive${why}.`,
				);
			}
			return skillResult.ok(`Hunted a ${target.name} and picked up ${describeGain(gained)}.`, {
				hunted: target.name || "unknown",
				success: true,
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
				return skillResult.fail("Hunting cancelled by combat");
			}
			return skillResult.fail(`Hunting failed: ${errorMsg}`);
		}
	},
});
