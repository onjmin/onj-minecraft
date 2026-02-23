import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import type { AgentOrchestrator } from "../../core/agent";
import { createTool, type ToolResponse, toolResult } from "../types";

/**
 * Mining Domain: Autonomous ore extraction.
 * 採掘ドメイン：周囲の鉱石を自動的にスキャンして採掘します。
 */
export const mineOresTool = createTool<void, { minedCount: number }>({
	name: "collecting.mining",
	description:
		"Scans the nearby area for valuable ores and mines them autonomously. No coordinates required.",
	inputSchema: {} as any,
	handler: async (agent: AgentOrchestrator): Promise<ToolResponse<{ minedCount: number }>> => {
		const { bot } = agent;

		// 1. Scan for nearby ores
		// 周囲の鉱石をスキャン
		const orePositions = miningScanner.findNearbyOres(bot);

		if (orePositions.length === 0) {
			return toolResult.fail("No valuable ores found nearby. Try moving to a different location.");
		}

		let minedCount = 0;

		try {
			for (const pos of orePositions) {
				// Ensure we have an appropriate tool equipped (if possible)
				// 適切なツール（ツルハシ等）を装備（簡易実装）
				const pickaxe = bot.inventory.items().find((item) => item.name.includes("pickaxe"));
				if (pickaxe) await bot.equip(pickaxe, "hand");

				// Navigate to the ore position
				// 鉱石の座標まで移動
				await agent.smartGoto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));

				const block = bot.blockAt(pos);
				// Verify the block is still an ore before digging
				// 掘る前に、そのブロックがまだ鉱石であることを再確認
				if (block && (block.name.includes("ore") || block.name.includes("raw"))) {
					await bot.dig(block);
					minedCount++;
				}
			}

			return toolResult.ok(`Successfully extracted ${minedCount} ore blocks from the area.`, {
				minedCount,
			});
		} catch (err) {
			return toolResult.fail(
				`Mining process failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});

/**
 * Scanner for identifying valuable blocks
 * 価値のあるブロックを特定するためのスキャナー
 */
export const miningScanner = {
	findNearbyOres: (bot: Bot, radius = 16): Vec3[] => {
		// List of target ores including deepslate variants
		// 深層岩バリアントを含む対象鉱石のリスト
		const targetOres = [
			"coal_ore",
			"iron_ore",
			"gold_ore",
			"diamond_ore",
			"lapis_ore",
			"redstone_ore",
			"copper_ore",
			"emerald_ore",
			"deepslate_coal_ore",
			"deepslate_iron_ore",
			"deepslate_gold_ore",
			"deepslate_diamond_ore",
			"deepslate_lapis_ore",
			"deepslate_redstone_ore",
		];

		return bot.findBlocks({
			matching: (block: any) => targetOres.includes(block.name),
			maxDistance: radius,
			count: 10,
		});
	},
};
