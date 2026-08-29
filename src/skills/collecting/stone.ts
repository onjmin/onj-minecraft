import type { BlockInfo, BotDriver } from "../../core/driver/types";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const collectStoneSkill = createSkill<void, { minedCount: number }>({
	name: "collecting.stone",
	description: "Collects stone-type blocks. Requires a pickaxe to successfully obtain stone.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ minedCount: number }>> => {
		const { driver } = agent;

		// 石系ブロックを近場からスキャン
		const stonePositions = stoneScanner.findNearbyStone(driver);

		if (stonePositions.length === 0) {
			return skillResult.fail("No stone blocks found nearby. Try moving to a lower altitude.");
		}

		let minedCount = 0;

		try {
			// 石は数が必要なので、上位10個をターゲットにする
			for (const stone of stonePositions) {
				await driver.goto(signal, { kind: "near", position: stone.position, distance: 2 });

				const block = driver.world.blockAt(stone.position);
				// 移動中にブロックが変わっていないかチェック
				if (block && stoneScanner.isStone(block.name)) {
					// 適切なツール（ツルハシ）を装備
					await driver.equipBestTool(block.position);
					await driver.dig(signal, block.position);
					minedCount++;
				}
			}

			return skillResult.ok(`Successfully collected ${minedCount} stone-type blocks.`, {
				minedCount,
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
				return skillResult.fail("Stone collection interrupted by combat or system stop.");
			}
			return skillResult.fail(`Stone collection failed: ${errorMsg}`);
		}
	},
});

export const stoneScanner = {
	// 採集対象とする石系ブロックの定義
	stoneBlocks: ["stone", "cobblestone", "deepslate", "andesite", "diorite", "granite", "tuff"],

	isStone: (name: string): boolean => {
		return stoneScanner.stoneBlocks.includes(name);
	},

	findNearbyStone: (driver: BotDriver, radius = 8): BlockInfo[] => {
		// 鉱石より出現率が高いため、一度の取得数を多めに設定
		return driver.world.findBlocks(stoneScanner.stoneBlocks, radius, 10);
	},
};
