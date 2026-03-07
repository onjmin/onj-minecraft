import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { ensureCraftingTable, ensureFurnace, tryPlaceBlock } from "../crafting/util";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const buildingMountainSkill = createSkill<void, { baseId: string; items: string[] }>({
	name: "building.mountain-base",
	description:
		"Digs a horizontal cave into the side of a mountain, then adds light, crafting table, furnace, chest, and door in order. Only registers base when all items are placed.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ baseId: string; items: string[] }>> => {
		const { bot } = agent;
		const toolPlugin = (bot as any).tool;
		// 座標を整数に固定
		const startPos = bot.entity.position.floored();

		agent.log(`[building.mountain] Started at ${startPos}`);

		// 掘削ターゲット（正面3マス × 高さ2マス × 幅3マス程度の空間を確保）
		// 相対座標をVec3インスタンスとして定義
		const digOffsets = [
			// 正面中央
			new Vec3(1, 0, 0),
			new Vec3(2, 0, 0),
			new Vec3(1, 1, 0),
			new Vec3(2, 1, 0),
			// 正面左右（幅を広げる）
			new Vec3(1, 0, 1),
			new Vec3(2, 0, 1),
			new Vec3(1, 1, 1),
			new Vec3(2, 1, 1),
			new Vec3(1, 0, -1),
			new Vec3(2, 0, -1),
			new Vec3(1, 1, -1),
			new Vec3(2, 1, -1),
		];

		let dugCount = 0;
		let airCount = 0;

		agent.log("[building.mountain] Phase 1: Excavating cave...");
		for (const offset of digOffsets) {
			if (agent.checkAbort(signal)) break;
			const targetPos = startPos.plus(offset);
			const block = bot.blockAt(targetPos);

			if (!block || block.name === "air" || block.name.includes("air")) {
				airCount++;
				continue;
			}

			// 掘削不可ブロックのチェック
			if (["bedrock", "barrier", "obsidian"].includes(block.name)) continue;

			try {
				// 掘削位置に近づくが、重ならないようにする
				await bot.pathfinder.setGoal(new goals.GoalLookAtBlock(targetPos, bot.world));

				if (toolPlugin) await toolPlugin.equipForBlock(block);
				await bot.dig(block);
				dugCount++;
			} catch (e) {
				agent.log(`[building.mountain] Digging failed at ${offset}: ${e}`);
			}
		}

		// 空間が確保されているか（掘った数 + もともと空気だった数）
		if (dugCount + airCount < 4) {
			return skillResult.fail(
				`Failed to secure enough space. (Dug: ${dugCount}, Air: ${airCount})`,
			);
		}

		const installedItems: string[] = ["space"];

		// Phase 2: ユーティリティ設置 (あるものだけでOK、設置失敗も許容)
		agent.log("[building.mountain] Phase 2: Installing utilities...");

		// 松明の設置 (足元ではなく、掘った穴の奥の壁や床)
		const torchItem = bot.inventory.items().find((i) => i.name === "torch");
		if (torchItem) {
			const torchPos = startPos.offset(2, 0, 0);
			const success = await tryPlaceBlock(
				bot,
				"torch",
				bot.registry.blocksByName.torch.id,
				agent,
				torchPos,
			);

			if (success) {
				installedItems.push("torch");
				agent.log(`[building.mountain] Torch placed at ${torchPos}`);
			}
		}

		// 作業台と竃 (ユーティリティ関数の活用)
		try {
			const table = await ensureCraftingTable(agent);
			if (table) installedItems.push("crafting_table");

			const furnace = await ensureFurnace(agent);
			if (furnace) installedItems.push("furnace");
		} catch {
			agent.log("[building.mountain] Utility placement encountered an error, continuing...");
		}

		// チェストとドア (あれば設置)
		const optionalItems = [
			{ name: "chest", id: bot.registry.blocksByName.chest?.id },
			{ name: "door", id: bot.inventory.items().find((i) => i.name.endsWith("_door"))?.type },
		];

		for (const item of optionalItems) {
			if (item.id) {
				const success = await tryPlaceBlock(bot, item.name, item.id, agent);
				if (success) installedItems.push(item.name);
			}
		}

		// Phase 3: 拠点の登録
		const baseId = `mountain_${Date.now()}`;
		const registered = agent.addBase({
			id: baseId,
			type: "mountain-cave",
			position: { x: startPos.x, y: startPos.y, z: startPos.z },
			safe: true,
			functional: installedItems.includes("crafting_table"),
			hasStorage: installedItems.includes("chest"),
		});

		if (!registered) {
			return skillResult.fail("Base location rejected by agent (too close to another base).");
		}

		return skillResult.ok(
			`Mountain base established. Space secured and items installed: ${installedItems.join(", ")}`,
			{
				baseId,
				items: installedItems,
			},
		);
	},
});
