import { goals } from "mineflayer-pathfinder";
import type { AgentOrchestrator } from "../../core/agent";
import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * Exploring Domain: Surface exploration.
 * 探索ドメイン（地表）：村や動物を探して、地表を広く探索します。
 */
export const exploreLandSkill = createSkill<void, { x: number; z: number }>({
	name: "exploring.explore_land",
	description:
		"Explores the surface to find villages, animals, or structures. Best used in daylight.",
	inputSchema: {} as any,
	handler: async (agent: AgentOrchestrator): Promise<SkillResponse<{ x: number; z: number }>> => {
		const { bot } = agent;

		const angle = Math.random() * Math.PI * 2;

		// 5〜15ブロックの範囲でランダムに決定
		const distance = 5 + Math.random() * 10;
		const x = Math.round(bot.entity.position.x + Math.cos(angle) * distance);
		const z = Math.round(bot.entity.position.z + Math.sin(angle) * distance);

		try {
			// timeout を設定して、あまりに長い移動は区切る
			// 30秒経っても着かなければ一旦戻る
			await Promise.race([
				agent.smartGoto(new goals.GoalXZ(x, z)),
				new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 30000)),
			]);

			return skillResult.ok("Moving to new area...", { x, z });
		} catch {
			// 4. リカバリ処理の強化
			// 詰まった時は単なるジャンプだけでなく、少し横にずれるなどの動作を加える
			bot.clearControlStates();
			bot.setControlState("jump", true);
			bot.setControlState("forward", true);

			// 左右どちらかにランダムに旋回してスタック脱出を試みる
			const yaw = bot.entity.yaw + (Math.random() > 0.5 ? 0.5 : -0.5);
			await bot.look(yaw, bot.entity.pitch, true);

			await new Promise((r) => setTimeout(r, 800));
			bot.clearControlStates();

			// タイムアウトでも、ある程度進めていれば「一部成功」として扱うのも手
			return skillResult.fail("Stuck or timeout, attempted recovery jump.");
		}
	},
});
