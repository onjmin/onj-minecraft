import { goals } from "mineflayer-pathfinder";
import type { Agent } from "../../core/agent";
import { createTool, type ToolResponse, toolResult } from "../types";

// Dynamic require to avoid namespace issues
// ランタイムでの競合を避けるための動的インポート
const Vec3 = require("vec3");

/**
 * Exploring Domain: Underground/Cave exploration.
 * 探索ドメイン（地下）：洞窟内を探索し、必要に応じて松明を設置して明かりを確保します。
 */
export const exploreUndergroundTool = createTool<void, { torchPlaced: boolean }>({
	name: "exploring.explore_underground",
	description: "Navigates through caves or tunnels. Automatically places torches if it's too dark.",
	inputSchema: {} as any,
	handler: async (agent: Agent): Promise<ToolResponse<{ torchPlaced: boolean }>> => {
		let torchPlaced = false;

		const { bot } = agent;

		try {
			// 1. Check light level and place torch if necessary
			// 明るさを確認し、暗ければ松明を設置（脊髄反射）
			const block = bot.blockAt(bot.entity.position);
			if (block && block.light < 8) {
				const torch = bot.inventory.items().find((item) => item.name.includes("torch"));
				if (torch) {
					// Find a solid block below or beside to place the torch
					// 足元か横の固形ブロックを探して松明を置く
					const ground = bot.blockAt(bot.entity.position.offset(0, -1, 0));
					if (ground && ground.name !== "air" && ground.name !== "water") {
						await bot.equip(torch, "hand");
						await bot.placeBlock(ground, new Vec3(0, 1, 0));
						torchPlaced = true;
					}
				}
			}

			// 2. Find a "cave-like" direction (where there is air at the same level)
			// 洞窟らしい方向（同じ高さに空気がある方向）を探して進む
			const directions = [
				new Vec3(10, 0, 0),
				new Vec3(-10, 0, 0),
				new Vec3(0, 0, 10),
				new Vec3(0, 0, -10),
				new Vec3(0, -5, 0), // 少し下る方向も追加
			];

			// Filter for directions that seem to lead to open spaces
			// 開けた空間（空気）に繋がっていそうな方向を選択
			for (const dir of directions) {
				const targetPos = bot.entity.position.plus(dir);
				const targetBlock = bot.blockAt(targetPos);

				if (targetBlock && targetBlock.name === "air") {
					await agent.smartGoto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2));
					return toolResult.ok(`Moved deeper into the cave.`, { torchPlaced });
				}
			}

			// 3. Fallback: If no clear path, just move a bit to keep searching
			// 進路が見つからない場合は、適当な近場へ移動して再試行
			return toolResult.fail(
				"Reached a dead end or no clear cave path found. LLM should reconsider direction.",
			);
		} catch (err) {
			return toolResult.fail(
				`Underground navigation failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
