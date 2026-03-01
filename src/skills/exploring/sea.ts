import { goals } from "mineflayer-pathfinder";
import { createSkill, type SkillResponse, skillResult } from "../types";

const Vec3 = require("vec3");

/**
 * Exploring Domain: Ocean/Sea exploration.
 * 探索ドメイン（海）：ボートを使用して海を渡り、沈没船や対岸を探します。
 */
export const exploreSeaSkill = createSkill<void, { usedBoat: boolean }>({
	name: "exploring.explore_sea",
	description: "Explores the ocean. Automatically attempts to use a boat for efficient travel.",
	inputSchema: {} as any,
	handler: async ({agent, signal}): Promise<SkillResponse<{ usedBoat: boolean }>> => {
		let usedBoat = false;

		const { bot } = agent;

		try {
			// 1. Check if we are already in a boat
			// すでにボートに乗っているか確認
			const isRiding = !!bot.entity.vehicle;

			// 2. If not in a boat and near water, try to deploy one
			// ボートに乗っておらず、水辺にいる場合はボートを出す
			if (!isRiding) {
				const boatItem = bot.inventory.items().find((item) => item.name.endsWith("_boat"));

				if (boatItem) {
					// Find nearby water block
					// 近くの水ブロックを探す
					const waterBlock = bot.findBlock({
						matching: (block: any) => block.name === "water",
						maxDistance: 4,
					});

					if (waterBlock) {
						await bot.equip(boatItem, "hand");
						// Place boat on water
						// 水上にボートを設置
						await bot.placeBlock(waterBlock, new Vec3(0, 1, 0));

						// Wait for the boat entity to be registered
						// エンティティが登録されるのを待機
						await new Promise((r) => setTimeout(r, 600));
						const boatEntity = bot.nearestEntity(
							(e) =>
								(e.name?.endsWith("_boat") || e.type === "object") &&
								e.position.distanceTo(bot.entity.position) < 5,
						);

						if (boatEntity) {
							await bot.mount(boatEntity);
							usedBoat = true;
						}
					}
				}
			}

			// 3. Set destination across the water
			// 対岸や遠くの海上の座標を決定
			const angle = Math.random() * Math.PI * 2;
			const distance = 20; // 海は広いので少し遠めに設定
			const x = Math.round(bot.entity.position.x + Math.cos(angle) * distance);
			const z = Math.round(bot.entity.position.z + Math.sin(angle) * distance);

			// Using GoalXZ works for boats too (pathfinder handles boat movement in latest versions)
			// ボートに乗った状態でも GoalXZ で移動可能
			await agent.smartGoto(new goals.GoalXZ(x, z));

			return skillResult.ok(
				`Navigating the ocean towards ${x}, ${z}. ${usedBoat ? "Using a boat." : "Swimming."}`,
				{ usedBoat },
			);
		} catch (err) {
			return skillResult.fail(
				`Sea exploration failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
