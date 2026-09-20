import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * Collecting Domain: Stealing from containers.
 * 収集ドメイン（窃取）：周囲のチェストや樽をスキャンし、中身をすべて回収します。
 */
export const stealFromChestSkill = createSkill<void, { itemsCount: number; containerType: string }>(
	{
		name: "collecting.stealing",
		description:
			"Finds a nearby chest or barrel within 16 blocks, walks to it, and takes everything inside. Generated chests (the bonus chest at spawn, shipwrecks, villages, mineshafts) already hold tools, food and iron - taking them is far faster than gathering from scratch.",
		inputSchema: {} as any,
		handler: async ({
			agent,
			signal,
		}): Promise<SkillResponse<{ itemsCount: number; containerType: string }>> => {
			const { driver } = agent;

			// 1. 周辺のコンテナ（チェスト、樽、トラップチェスト）をスキャン
			const containerBlock = driver.world.findBlock(["chest", "barrel", "trapped_chest"], 16);

			if (!containerBlock) {
				return skillResult.fail("No chests or barrels found nearby.");
			}

			try {
				// 2. ターゲットへ移動
				await driver.goto(signal, { kind: "getToBlock", position: containerBlock.position });

				// 3-4. コンテナを開いて中身を回収する（開閉はDriverに閉じ込めている）
				const itemsCount = await driver.takeAllFromContainer(signal, containerBlock.position);

				if (itemsCount === 0) {
					return skillResult.ok("The container was empty.", {
						itemsCount: 0,
						containerType: containerBlock.name,
					});
				}

				return skillResult.ok(`Stole ${itemsCount} items from ${containerBlock.name}.`, {
					itemsCount,
					containerType: containerBlock.name,
				});
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
					return skillResult.fail("Stealing cancelled by combat");
				}
				return skillResult.fail(`Stealing failed: ${errorMsg}`);
			}
		},
	},
);
