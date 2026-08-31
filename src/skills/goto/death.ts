import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * 死んだ場所へ戻って、落とした物を拾い直す。
 *
 * 統合版は死ぬと持ち物が全部その場に落ちる。放っておくと5分ほどで消える。
 * 集めた材料も作った道具もそこで消えるので、何を積み上げても残らない。
 * 実際、土50個と木のツルハシがこれで失われていた。
 *
 * 復帰した時点でこのスキルが選ばれるよう、ドライバの respawn を受けて
 * agent 側が現在のタスクに設定する。LLM の判断を待つと間に合わない。
 */
export const gotoDeathPointSkill = createSkill<void, { recovered: string }>({
	name: "goto.death_point",
	description:
		"Returns to the place where you died and picks up the items you dropped. Dropped items disappear after about five minutes, so do this before anything else after respawning.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ recovered: string }>> => {
		const { driver } = agent;
		const point = agent.getDeathPoint();
		if (!point) {
			return skillResult.fail("No death point to return to (or the drops have already despawned).");
		}

		const before = new Map<string, number>();
		for (const item of driver.inventory.items()) {
			before.set(item.name, (before.get(item.name) ?? 0) + item.count);
		}

		agent.log(
			`[goto.death_point] (${point.x.toFixed(0)}, ${point.y.toFixed(0)}, ${point.z.toFixed(0)}) へ落とし物を取りに行く`,
		);

		try {
			await driver.goto(signal, { kind: "near", position: point, distance: 2 });
		} catch (err) {
			// 届かなくても、近くまで来ていれば拾える見込みはある。
			if (signal.aborted) throw err;
			agent.log(`[goto.death_point] 詰め切れず: ${err}`);
		}

		// 落とし物は散らばる。何度か拾いに回る。
		for (let i = 0; i < 3; i++) {
			if (signal.aborted) break;
			await driver.pickupNearbyItems(signal);
		}

		const gained: string[] = [];
		for (const item of driver.inventory.items()) {
			const diff = item.count - (before.get(item.name) ?? 0);
			if (diff > 0) gained.push(`${item.name} x${diff}`);
		}

		if (gained.length === 0) {
			// 一度行って拾えないなら、もう落ちていない。追い続けても仕方がない。
			agent.clearDeathPoint();
			return skillResult.fail("Reached the death point but found nothing left to pick up.");
		}

		agent.clearDeathPoint();
		return skillResult.ok(`Recovered ${gained.join(", ")} from the death point.`, {
			recovered: gained.join(", "),
		});
	},
});
