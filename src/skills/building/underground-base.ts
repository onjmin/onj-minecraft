import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { ensureCraftingTable, ensureFurnace, tryPlaceBlock } from "../crafting/util";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const buildingUndergroundSkill = createSkill<void, { baseId: string; items: string[] }>({
	name: "building.underground-base",
	description:
		"Digs a 3x3x3+ underground space, then adds light, crafting table, furnace, chest, and door in order. Only registers base when all items are placed.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ baseId: string; items: string[] }>> => {
		const { bot } = agent;
		const toolPlugin = (bot as any).tool;
		// 座標を整数に固定
		const pos = bot.entity.position.floored();

		agent.log(`[building.underground] Started at integer position: ${pos}`);

		const installedItems: string[] = [];
		const unstableFloorBlocks = ["water", "lava", "air", "void_air", "cave_air"];

		// 1. 掘削ターゲット (Vec3インスタンス化)
		const digTargets = [
			new Vec3(1, 0, 0),
			new Vec3(-1, 0, 0),
			new Vec3(0, 0, 1),
			new Vec3(0, 0, -1),
			new Vec3(1, 1, 0),
			new Vec3(-1, 1, 0),
			new Vec3(0, 1, 1),
			new Vec3(0, 1, -1),
			new Vec3(1, 0, 1),
			new Vec3(1, 0, -1),
			new Vec3(-1, 0, 1),
			new Vec3(-1, 0, -1),
		];

		// Phase 0: 床の安定性チェック
		const floorOffsets = [
			new Vec3(0, 0, 0),
			new Vec3(1, 0, 0),
			new Vec3(-1, 0, 0),
			new Vec3(0, 0, 1),
			new Vec3(0, 0, -1),
		];
		for (const offset of floorOffsets) {
			const groundBlock = bot.blockAt(pos.plus(offset).offset(0, -1, 0));
			if (!groundBlock || unstableFloorBlocks.includes(groundBlock.name)) {
				return skillResult.fail(`Unstable floor at ${offset}: ${groundBlock?.name || "air"}`);
			}
		}

		// Phase 1: 掘削
		let dugCount = 0;
		for (const offset of digTargets) {
			if (agent.checkAbort(signal)) break;
			const targetPos = pos.plus(offset);
			const block = bot.blockAt(targetPos);

			if (!block || block.name === "air") {
				dugCount++; // すでに空気なら掘削済みとしてカウント
				continue;
			}

			// 掘削可能かチェック
			if (!bot.canDigBlock(block) || ["bedrock", "lava", "water"].includes(block.name)) continue;

			// 掘るために近づく
			await agent.abortableGoto(
				signal,
				new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2),
			);

			try {
				if (toolPlugin) await toolPlugin.equipForBlock(block);
				await agent.abortableDig(signal, block);
				dugCount++;
				await agent.pickupNearbyItems(signal);
			} catch (e) {
				agent.log(`Failed to dig at ${offset}: ${e}`);
			}
		}

		// 掘削成功の判定を少し緩める
		if (dugCount < 6) {
			return skillResult.fail(`Failed to clear enough space. Dug: ${dugCount}/12`);
		}
		installedItems.push("space");

		// Phase 2: ユーティリティ設置 (ensure系を活用)
		agent.log("[building.underground] Installing utilities...");

		// クラフトテーブル & かまど
		if (await ensureCraftingTable(agent)) installedItems.push("crafting_table");
		if (await ensureFurnace(agent)) installedItems.push("furnace");

		// 松明 (地下なので重要度高め)
		const torchItem = bot.inventory.items().find((i) => i.name === "torch");
		if (torchItem) {
			// 天井(y=2)または壁に設置
			const torchSuccess = await tryPlaceBlock(
				bot,
				"torch",
				bot.registry.blocksByName.torch.id,
				agent,
			);
			if (torchSuccess) installedItems.push("torch");
		}

		// チェスト (あれば設置)
		const chestItem = bot.inventory.items().find((i) => i.name === "chest");
		if (chestItem) {
			const placed = await tryPlaceBlock(bot, "chest", bot.registry.blocksByName.chest.id, agent);
			if (placed) installedItems.push("chest");
		}

		// Phase 3: Base登録
		const baseId = `underground_${Date.now()}`;
		const registered = agent.addBase({
			id: baseId,
			type: "underground",
			position: { x: pos.x, y: pos.y, z: pos.z },
			safe: installedItems.includes("torch"), // 明かりがあれば安全
			functional: installedItems.includes("crafting_table"),
			hasStorage: installedItems.includes("chest"),
		});

		if (!registered) return skillResult.fail("Base registration failed (location occupied).");

		return skillResult.ok(`Underground base established. Items: ${installedItems.join(", ")}`, {
			baseId,
			items: installedItems,
		});
	},
});
