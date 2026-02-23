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
			// 明るさを確認し、暗ければ松明を設置
			const block = bot.blockAt(bot.entity.position);
			if (block && block.light < 8) {
				const torch = bot.inventory.items().find((item) => item.name.includes("torch"));
				if (torch) {
					const ground = bot.blockAt(bot.entity.position.offset(0, -1, 0));
					if (ground && ground.name !== "air" && ground.name !== "water") {
						await bot.equip(torch, "hand");
						// Vec3をインスタンス化して設置
						await bot.placeBlock(ground, new Vec3(0, 1, 0));
						torchPlaced = true;
					}
				}
			}

			// 2. Find a "cave-like" direction
			// 洞窟らしい方向（周囲の空気）を探す
			const directions = [
				new Vec3(10, 0, 0),
				new Vec3(-10, 0, 0),
				new Vec3(0, 0, 10),
				new Vec3(0, 0, -10),
				new Vec3(0, -5, 0), // 下方向
			];

			for (const dir of directions) {
				const targetPos = bot.entity.position.plus(dir);
				const targetBlock = bot.blockAt(targetPos);

				if (targetBlock && targetBlock.name === "air") {
					const goal = new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2);

					// Orchestrator側で bot.smartMove などを生やしている場合はそれを使う
					if ((bot as any).smartMove) {
						await (bot as any).smartMove(goal);
					} else {
						// 直接 pathfinder を呼ぶ（await を忘れずに）
						await agent.smartGoto(goal);
					}

					return toolResult.ok(
						`Moved deeper into the cave at ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`,
						{ torchPlaced },
					);
				}
			}

			// 3. Fallback: もし周囲に空気ブロックが見つからない場合、少し下を掘るかランダム移動
			return toolResult.fail(
				"No clear cave path found nearby. Try moving to a different Y level manually.",
			);
		} catch (err) {
			return toolResult.fail(
				`Underground navigation failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
