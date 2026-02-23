import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import { createTool, type ToolResponse, toolResult } from "../types";

/**
 * Exploring Domain: Surface exploration.
 * 探索ドメイン（地表）：村や動物を探して、地表を広く探索します。
 */
export const exploreLandTool = createTool<void, { x: number; z: number }>({
	name: "exploring.explore_land",
	description:
		"Explores the surface to find villages, animals, or structures. Best used in daylight.",
	inputSchema: {} as any,
	handler: async (bot: Bot): Promise<ToolResponse<{ x: number; z: number }>> => {
		// 1. Randomly pick a distant surface location
		// 遠くの地表の座標をランダムに決定
		const angle = Math.random() * Math.PI * 2;
		const x = Math.round(bot.entity.position.x + Math.cos(angle) * 80);
		const z = Math.round(bot.entity.position.z + Math.sin(angle) * 80);

		try {
			// timeout を設定して、あまりに長い移動は区切る
			// 30秒経っても着かなければ一旦戻る
			await Promise.race([
				bot.pathfinder.goto(new goals.GoalXZ(x, z)),
				new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 30000)),
			]);

			return toolResult.ok("Moving to new area...", { x, z });
		} catch {
			// 詰まった(stuck)時のためのリカバリ：とりあえずジャンプして前に進んでみる
			bot.setControlState("jump", true);
			bot.setControlState("forward", true);
			await new Promise((r) => setTimeout(r, 500));
			bot.clearControlStates();

			return toolResult.fail("Stuck or No path, force jumped.");
		}
	},
});
