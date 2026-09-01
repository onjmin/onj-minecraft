import type { MinecraftAgent } from "../../core/agent";
import type { Position } from "../../core/driver/types";
import { describeGain, gainedSince, snapshotInventory, totalGain } from "../inventory-delta";
import { createSkill, type SkillResponse, skillResult } from "../types";

/** どれだけ離れるか。相手の追跡が切れる程度。 */
const RETREAT_DISTANCE = 20;

/** 走ってその場から離れる。拾ったあとに留まらないため。 */
async function retreatFrom(
	agent: MinecraftAgent,
	signal: AbortSignal,
	from: Position,
): Promise<void> {
	const here = agent.driver.getState().position;
	const dx = here.x - from.x;
	const dz = here.z - from.z;
	const len = Math.hypot(dx, dz) || 1;
	agent.log("[goto.death_point] 拾ったので離れる");
	try {
		await agent.driver.setControlState(signal, "sprint", true);
		await agent.driver.goto(signal, {
			kind: "xz",
			// 死んだ地点から見て、今いる方向へさらに離れる。
			x: from.x + (dx / len) * RETREAT_DISTANCE,
			z: from.z + (dz / len) * RETREAT_DISTANCE,
			distance: 4,
		});
	} catch {
		// 離れ切れなくても、動いたぶんは稼げている。
	}
}

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

		// 増減はスロットごとではなく品目ごとに数える。同じ物が複数スロットに
		// 散っていることがあるので、スロットの count を品目の合計と引き算すると
		// 数が合わない。拾ってスタックがまとまった場合は差が 0 になり、
		// 全部回収できていても「何も無かった」と報告してしまう。
		const before = snapshotInventory(driver);

		agent.log(
			`[goto.death_point] (${point.x.toFixed(0)}, ${point.y.toFixed(0)}, ${point.z.toFixed(0)}) へ落とし物を取りに行く`,
		);

		// 走って行き、拾って、走って離れる。殺した相手はその場に留まって
		// いることが多い。丸腰で長居すれば同じことになる。
		try {
			await driver.setControlState(signal, "sprint", true);
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

		const gained = gainedSince(driver, before);
		const what = describeGain(gained);

		// 中断されたなら、拾い切れていないだけで落とし物はまだある。
		// ここで下の「何も無かった」枝に落とすと clearDeathPoint() まで走る。
		// 回収中に殺し直された場合、agent 側は死亡地点に retryAfter を付けて
		// わざと残している（後で取りに戻るため）。それを消してしまうと、
		// 1回目の落とし物も2回目の落とし物も二度と回収されない。
		if (signal.aborted) {
			return skillResult.fail(
				totalGain(gained) > 0
					? `Interrupted while recovering (got ${what} so far).`
					: "Interrupted before recovering anything.",
			);
		}

		// 用が済んだらすぐ離れる。ここは自分が殺された場所で、相手はたいてい
		// まだいる。拾った物を抱えて留まるのが一番損をする。
		await retreatFrom(agent, signal, point);

		if (totalGain(gained) === 0) {
			// 一度行って拾えないなら、もう落ちていない。追い続けても仕方がない。
			agent.clearDeathPoint();
			return skillResult.fail("Reached the death point but found nothing left to pick up.");
		}

		agent.clearDeathPoint();
		return skillResult.ok(`Recovered ${what} from the death point.`, {
			recovered: what,
		});
	},
});
