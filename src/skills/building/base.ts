import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { MinecraftAgent } from "../../core/agent";
import { ensureChest, ensureCraftingTable, ensureFurnace, tryPlaceBlock } from "../crafting/util";
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

		// ★重要: 建築開始時の座標を「固定」する。これ以降、この 'baseCenter' を基準にする。
		const baseCenter = bot.entity.position.floored();
		const installedItems: string[] = [];

		// 既存拠点の検索も固定座標で行う
		const existingBase = agent
			.getBases()
			.find(
				(b) =>
					Math.abs(b.position.x - baseCenter.x) < 5 && Math.abs(b.position.z - baseCenter.z) < 5,
			);

		if (existingBase) {
			// メンテナンス時も baseCenter を引き継ぐ
			return await performMaintenance(agent, signal, baseCenter, installedItems, existingBase);
		}

		// --- Phase 0: 居住空間のクリア ---
		agent.log("[building.base] Phase 0: Clearing interior space...");
		const interiorPositions = [baseCenter, baseCenter.offset(0, 1, 0)];
		for (const p of interiorPositions) {
			const block = bot.blockAt(p);
			if (block && block.name !== "air" && !["water", "lava"].includes(block.name)) {
				await bot.dig(block);
			}
		}

		// 1. 壁のオフセットを2段分定義
		const wallOffsets = [
			// 1段目 (y: 0)
			new Vec3(1, 0, 0),
			new Vec3(-1, 0, 0),
			new Vec3(0, 0, 1),
			new Vec3(0, 0, -1),
			new Vec3(1, 0, 1),
			new Vec3(1, 0, -1),
			new Vec3(-1, 0, 1),
			new Vec3(-1, 0, -1),
			// 2段目 (y: 1)
			new Vec3(1, 1, 0),
			new Vec3(-1, 1, 0),
			new Vec3(0, 1, 1),
			new Vec3(0, 1, -1),
			new Vec3(1, 1, 1),
			new Vec3(1, 1, -1),
			new Vec3(-1, 1, 1),
			new Vec3(-1, 1, -1),
		];

		agent.log("[building.house] Phase 1: Securing walls...");

		// --- 修正版：壁の設置ロジック ---

		// 建築に使用可能なブロックのリスト（優先順位順）
		const VALID_BUILD_MATERIALS = ["cobblestone", "stone", "dirt"];

		for (const offset of wallOffsets) {
			if (agent.checkAbort(signal)) break;
			const targetPos = pos.plus(offset);
			const block = bot.blockAt(targetPos);

			// 1. 障害物のチェックと除去
			if (block && block.name !== "air" && !["water", "lava"].includes(block.name)) {
				// 壁として機能しない「柔らかいブロック（草や花など）」は破壊してスペースを確保
				const isReplaceable =
					block.name.includes("grass") ||
					block.name.includes("flower") ||
					block.name === "fern" ||
					block.name.includes("shrub");

				if (isReplaceable) {
					agent.log(`Removing obstacle (${block.name}) at ${targetPos}`);
					// ツール（シャベル等）があれば最適化されますが、素手でも破壊可能
					await bot.dig(block);
				} else {
					// すでに硬いブロックがある場合はスキップ
					continue;
				}
			}

			// 2. インベントリから土・石系の資材を探す
			const inventory = bot.inventory.items();
			const buildMaterial = inventory.find((item) => VALID_BUILD_MATERIALS.includes(item.name));

			if (buildMaterial) {
				// 自分が邪魔にならないよう中心点に移動
				await bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));

				// 設置実行
				const success = await tryPlaceBlock(bot, buildMaterial.name, buildMaterial.type, agent);
				if (success) {
					agent.log(`Placed ${buildMaterial.name} wall at ${targetPos}`);
				}
			} else {
				agent.log("Warning: No dirt or stone blocks available for walls.");
				// 資材が尽きたら中断、あるいは資材収集タスクへ
				break;
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

		if (!installedItems.includes("crafting_table")) {
			return skillResult.fail(
				"Maintenance failed: Base is no longer functional without a crafting table.",
			);
		}

		// チェスト (素材があれば作成して設置まで行う)
		const chest = await ensureChest(agent);
		if (chest) {
			installedItems.push("crafting_chest");
			agent.log("Crafting chest ensured.");
		}

		if (!installedItems.includes("crafting_chest")) {
			return skillResult.fail(
				"Maintenance failed: Base is no longer functional without a crafting chest.",
			);
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

	if (!installedItems.includes("crafting_table")) {
		return skillResult.fail("Failed to establish base: Crafting table could not be placed.");
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
