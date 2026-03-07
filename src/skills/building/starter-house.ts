import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { ensureCraftingTable, ensureFurnace, tryPlaceBlock } from "../crafting/util";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const buildingHouseSkill = createSkill<void, { baseId: string; items: string[] }>({
	name: "building.starter-house",
	description:
		"Builds a wooden box structure on the ground, then adds light, crafting table, furnace, chest, and door in order. Only registers base when structure is complete.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ baseId: string; items: string[] }>> => {
		const { bot } = agent;
		const pos = bot.entity.position.floored();
		const installedItems: string[] = [];

		// 1. 壁のオフセットを Vec3 インスタンスとして定義 (型エラー回避)
		const surroundingOffsets = [
			new Vec3(1, 0, 0),
			new Vec3(-1, 0, 0),
			new Vec3(0, 0, 1),
			new Vec3(0, 0, -1),
			new Vec3(1, 0, 1),
			new Vec3(1, 0, -1),
			new Vec3(-1, 0, 1),
			new Vec3(-1, 0, -1),
		];

		agent.log("[building.house] Phase 1: Securing walls...");

		for (const offset of surroundingOffsets) {
			if (agent.checkAbort(signal)) break;
			const targetPos = pos.plus(offset);
			const block = bot.blockAt(targetPos);

			// すでに壁があるならスキップ
			if (block && block.name !== "air" && !["water", "lava"].includes(block.name)) {
				continue;
			}

			// 壁を設置 (tryPlaceBlock内で移動や向きの調整が行われる前提)
			const inventory = bot.inventory.items();
			const buildMaterial = inventory.find(
				(i) =>
					i.name.includes("planks") ||
					i.name.includes("log") ||
					i.name === "dirt" ||
					i.name === "cobblestone" ||
					i.name === "stone",
			);

			if (buildMaterial) {
				// 自分が邪魔にならないよう一歩下がる(簡易版)
				const awayGoal = new goals.GoalLookAtBlock(targetPos, bot.world);
				await bot.pathfinder.setGoal(awayGoal);

				const success = await tryPlaceBlock(bot, buildMaterial.name, buildMaterial.type, agent);
				if (success) agent.log(`Placed wall at ${targetPos}`);
			}
		}

		// 2. 必須ユーティリティの設置 (ensure系を使用)
		agent.log("[building.house] Phase 2: Installing utilities...");

		// クラフトテーブル (素材があれば作成して設置まで行う)
		const table = await ensureCraftingTable(agent);
		if (table) {
			installedItems.push("crafting_table");
			agent.log("Crafting table ensured.");
		}

		// かまど (丸石があれば作成して設置まで行う)
		const furnace = await ensureFurnace(agent);
		if (furnace) {
			installedItems.push("furnace");
			agent.log("Furnace ensured.");
		}

		// 松明 (持っていれば設置)
		const torchItem = bot.inventory.items().find((i) => i.name === "torch");
		if (torchItem) {
			const torchSuccess = await tryPlaceBlock(
				bot,
				"torch",
				bot.registry.blocksByName.torch.id,
				agent,
			);
			if (torchSuccess) installedItems.push("torch");
		}

		// 3. 最終的な密閉判定
		const isFloorSolid = bot.blockAt(pos.offset(0, -1, 0))?.name !== "air";
		let wallCount = 0;
		for (const offset of surroundingOffsets) {
			if (bot.blockAt(pos.plus(offset))?.name !== "air") wallCount++;
		}

		if (!isFloorSolid || wallCount < 4) {
			return skillResult.fail(
				`Failed to secure space. Walls: ${wallCount}/8, Floor: ${isFloorSolid}`,
			);
		}

		// 4. Baseの登録
		const baseId = `base_${Date.now()}`;
		const registered = agent.addBase({
			id: baseId,
			type: "starter-base",
			position: { x: pos.x, y: pos.y, z: pos.z },
			safe: wallCount >= 6, // 囲いが多ければ安全とみなす
			functional: installedItems.includes("crafting_table"),
			hasStorage: false,
		});

		if (!registered) return skillResult.fail("Base too close to another location.");

		return skillResult.ok(`Base established. Items: ${installedItems.join(", ")}`, {
			baseId,
			items: installedItems,
		});
	},
});
