import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import { createTool, type ToolResponse, toolResult } from "../types";

/**
 * Exploring Domain: Surface exploration.
 * 探索ドメイン（地表）：村や動物を探して、地表を広く探索します。
 */
export const exploreLandTool = createTool<void, { found: string[] }>({
	name: "exploring.explore_land",
	description:
		"Explores the surface to find villages, animals, or structures. Best used in daylight.",
	inputSchema: {} as any,
	handler: async (): Promise<ToolResponse<{ found: string[] }>> => {
		const bot = (global as any).bot as Bot;
		if (!bot) return toolResult.fail("Bot instance not available.");

		// 1. Randomly pick a distant surface location
		// 遠くの地表の座標をランダムに決定
		const angle = Math.random() * Math.PI * 2;
		const x = Math.round(bot.entity.position.x + Math.cos(angle) * 40);
		const z = Math.round(bot.entity.position.z + Math.sin(angle) * 40);

		try {
			// 2. Move using GoalXZ (pathfinder handles Y)
			// GoalXZ で移動（高さはパスファインダーが解決）
			await bot.pathfinder.goto(new goals.GoalXZ(x, z));

			// 3. Scan for interesting things on the surface
			// 地表にある興味深いものをスキャン
			const entities = Object.values(bot.entities)
				.filter((e) => e.position.distanceTo(bot.entity.position) < 20)
				.map((e) => e.name || "unknown");

			const uniqueEntities = Array.from(new Set(entities));

			return toolResult.ok(`Explored surface area. Noticed: ${uniqueEntities.join(", ")}`, {
				found: uniqueEntities,
			});
		} catch {
			return toolResult.fail("Could not find a safe path across the surface.");
		}
	},
});
