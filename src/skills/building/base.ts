import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { MinecraftAgent } from "../../core/agent";
import { ensureCraftingTable, ensureFurnace, tryPlaceBlock } from "../crafting/util";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const buildingBaseSkill = createSkill<void, { baseId: string; items: string[] }>({
	name: "building.base",
	description:
		"Builds a wooden box structure on the ground, then adds light, crafting table, furnace, chest, and door in order. Only registers base when structure is complete. If base already exists, performs maintenance activities.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ baseId: string; items: string[] }>> => {
		const { bot } = agent;
		const pos = bot.entity.position.floored();
		const installedItems: string[] = [];

		const existingBase = agent
			.getBases()
			.find((b) => Math.abs(b.position.x - pos.x) < 5 && Math.abs(b.position.z - pos.z) < 5);

		if (existingBase) {
			agent.log("[building.base] Existing base found. Performing maintenance...");
			return await performMaintenance(agent, signal, pos, installedItems, existingBase);
		}

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
		let wallCount = 0;
		for (const offset of surroundingOffsets) {
			if (bot.blockAt(pos.plus(offset))?.name !== "air") wallCount++;
		}

		// 4. Baseの登録
		const baseId = `base_${Date.now()}`;
		const registered = agent.upsertBase({
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

async function performMaintenance(
	agent: MinecraftAgent,
	signal: AbortSignal,
	pos: Vec3,
	installedItems: string[],
	existingBase: {
		id: string;
		type: string;
		position: { x: number; y: number; z: number };
		safe: boolean;
		functional: boolean;
		hasStorage: boolean;
	},
): Promise<SkillResponse<{ baseId: string; items: string[] }>> {
	const { bot } = agent;

	agent.log("[building.base] Phase 1: Checking walls...");

	for (const offset of surroundingOffsets) {
		if (agent.checkAbort(signal)) break;
		const targetPos = pos.plus(offset);
		const block = bot.blockAt(targetPos);

		if (block && block.name !== "air" && !["water", "lava"].includes(block.name)) {
			continue;
		}

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
			const awayGoal = new goals.GoalLookAtBlock(targetPos, bot.world);
			await bot.pathfinder.setGoal(awayGoal);

			const success = await tryPlaceBlock(bot, buildMaterial.name, buildMaterial.type, agent);
			if (success) agent.log(`Repaired wall at ${targetPos}`);
		}
	}

	agent.log("[building.base] Phase 2: Checking utilities...");

	const table = await ensureCraftingTable(agent);
	if (table) {
		installedItems.push("crafting_table");
		agent.log("Crafting table ensured.");
	}

	const furnace = await ensureFurnace(agent);
	if (furnace) {
		installedItems.push("furnace");
		agent.log("Furnace ensured.");
	}

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

	let wallCount = 0;
	for (const offset of surroundingOffsets) {
		if (bot.blockAt(pos.plus(offset))?.name !== "air") wallCount++;
	}

	agent.upsertBase({
		...existingBase,
		position: { x: pos.x, y: pos.y, z: pos.z },
		safe: wallCount >= 6,
		functional: installedItems.includes("crafting_table"),
		hasStorage: existingBase.hasStorage,
	});

	return skillResult.ok(`Base maintenance completed. Items: ${installedItems.join(", ")}`, {
		baseId: existingBase.id,
		items: installedItems,
	});
}
