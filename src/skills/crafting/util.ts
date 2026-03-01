import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { MinecraftAgent } from "../../core/agent";

type Block = NonNullable<ReturnType<Bot["blockAt"]>>;

/**
 * 周囲の設置可能な位置を探す
 */
function findPlaceablePosition(bot: Bot): Block | null {
	const directions = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
		[1, 1],
		[-1, 1],
		[1, -1],
		[-1, -1],
	];

	for (const [dx, dz] of directions) {
		const refBlock = bot.blockAt(bot.entity.position.offset(dx, -1, dz));
		if (refBlock && refBlock.name !== "air") {
			const placePos = refBlock.position.offset(0, 1, 0);
			const blockAbove = bot.blockAt(placePos);
			if (blockAbove && blockAbove.name === "air") {
				return refBlock;
			}
		}
	}
	return null;
}

/**
 * 共通ロジック：作業台を確保する（周辺スキャン -> 作成 -> 設置）
 * @returns 確保された作業台のBlockオブジェクト、確保失敗時は null
 */
export async function ensureCraftingTable(agent: MinecraftAgent): Promise<Block | null> {
	const { bot } = agent;

	// 1. 周辺スキャン
	const tableBlock = bot.findBlock({
		matching: bot.registry.blocksByName.crafting_table.id,
		maxDistance: 4,
	});

	agent.log(`[ensureCraftingTable] Scanning nearby: found=${!!tableBlock}`);
	if (tableBlock) return tableBlock;

	// 2. インベントリ確認
	let tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
	agent.log(`[ensureCraftingTable] In inventory: found=${!!tableItem}`);

	// 3. なければ作る（原木 -> 板材 -> 作業台）
	if (!tableItem) {
		let planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
		agent.log(
			`[ensureCraftingTable] Planks in inventory: found=${!!planks}, count=${planks?.count || 0}`,
		);

		if (!planks || planks.count < 4) {
			const logItem = bot.inventory
				.items()
				.find(
					(i) => i.name.endsWith("_log") || i.name.endsWith("_stem") || i.name.endsWith("_wood"),
				);

			agent.log(
				`[ensureCraftingTable] Logs in inventory: found=${!!logItem}, name=${logItem?.name}`,
			);
			if (!logItem) {
				agent.log(`[ensureCraftingTable] FAIL: No logs`);
				return null;
			}

			const logBaseName = logItem.name.replace(/_log|_stem|_wood$/, "");
			const plankItemName = `${logBaseName}_planks`;
			const plankItem = bot.registry.itemsByName[plankItemName];
			const recipes = bot.recipesFor(plankItem?.id, null, 1, null);
			agent.log(`[ensureCraftingTable] Plank recipes: count=${recipes.length}`);

			const plankRecipe = recipes[0];
			if (!plankRecipe) {
				agent.log(`[ensureCraftingTable] FAIL: No plank recipe`);
				return null;
			}
			await bot.craft(plankRecipe, 1);
			planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
			agent.log(`[ensureCraftingTable] After crafting planks: count=${planks?.count || 0}`);
		}

		if (planks && planks.count >= 4) {
			const tableRecipe = bot.recipesFor(
				bot.registry.itemsByName.crafting_table.id,
				null,
				1,
				null,
			)[0];
			agent.log(`[ensureCraftingTable] Table recipe: found=${!!tableRecipe}`);
			await bot.craft(tableRecipe, 1);
			tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
			agent.log(`[ensureCraftingTable] Crafted table item: found=${!!tableItem}`);
		}
	}

	// 4. 設置する
	if (tableItem) {
		const referenceBlock = findPlaceablePosition(bot);
		if (referenceBlock) {
			await bot.equip(tableItem, "hand");
			await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
			const placed = bot.findBlock({
				matching: bot.registry.blocksByName.crafting_table.id,
				maxDistance: 4,
			});
			agent.log(`[ensureCraftingTable] Placed: found=${!!placed}`);
			return placed;
		}
	}

	agent.log(`[ensureCraftingTable] FAIL: Cannot place table`);
	return null;
}

/**
 * 共通ロジック：かまどを確保する（周辺スキャン -> 作成 -> 設置）
 * @returns 確保されたかまどのBlockオブジェクト、確保失敗時は null
 */
export async function ensureFurnace(agent: MinecraftAgent): Promise<Block | null> {
	const { bot } = agent;

	// 1. 周辺スキャン
	const furnaceBlock = bot.findBlock({
		matching: bot.registry.blocksByName.furnace.id,
		maxDistance: 4,
	});

	agent.log(`[ensureFurnace] Scanning nearby: found=${!!furnaceBlock}`);
	if (furnaceBlock) return furnaceBlock;

	// 2. インベントリ確認
	let furnaceItem = bot.inventory.items().find((i) => i.name === "furnace");
	agent.log(`[ensureFurnace] In inventory: found=${!!furnaceItem}`);

	// 3. なければ作る（丸石 x 8 -> かまど）
	if (!furnaceItem) {
		const cobble = bot.inventory.items().find((i) => i.name === "cobblestone");
		agent.log(
			`[ensureFurnace] Cobble in inventory: found=${!!cobble}, count=${cobble?.count || 0}`,
		);

		// 丸石が8個以上必要
		if (!cobble || cobble.count < 8) {
			agent.log(`[ensureFurnace] FAIL: Not enough cobble (need 8)`);
			return null;
		}

		// かまど作成には作業台が必要
		const table = await ensureCraftingTable(agent);
		if (!table) {
			agent.log(`[ensureFurnace] FAIL: No crafting table`);
			return null;
		}

		const furnaceRecipe = bot.recipesFor(bot.registry.itemsByName.furnace.id, null, 1, table)[0];
		agent.log(`[ensureFurnace] Furnace recipe: found=${!!furnaceRecipe}`);

		if (!furnaceRecipe) return null;

		await bot.craft(furnaceRecipe, 1, table);
		furnaceItem = bot.inventory.items().find((i) => i.name === "furnace");
		agent.log(`[ensureFurnace] Crafted furnace: found=${!!furnaceItem}`);
	}

	// 4. 設置する
	if (furnaceItem) {
		// 作業台と重ならないよう、少しずらした位置（例: Z軸に+1）に設置
		const referenceBlock = findPlaceablePosition(bot);
		if (referenceBlock) {
			await bot.equip(furnaceItem, "hand");
			await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
			const placed = bot.findBlock({
				matching: bot.registry.blocksByName.furnace.id,
				maxDistance: 4,
			});
			agent.log(`[ensureFurnace] Placed: found=${!!placed}`);
			return placed;
		}
	}

	agent.log(`[ensureFurnace] FAIL: Cannot place furnace`);
	return null;
}

/**
 * 共通ロジック：棒を確保する（インベントリ確認 -> 作成）
 * 作業台は不要ですが、材料（板材/原木）がない場合は作成を試みます。
 * @returns 確保成功時は true
 */
export async function ensureSticks(agent: MinecraftAgent, count = 4): Promise<boolean> {
	const { bot } = agent;

	// 1. インベントリ確認
	const sticks = bot.inventory.items().find((i) => i.name === "stick");
	agent.log(
		`[ensureSticks] sticks found=${!!sticks}, count=${sticks?.count || 0}, required=${count}`,
	);
	if (sticks && sticks.count >= count) return true;

	// 2. なければ作る（板材 -> 棒）
	let planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
	agent.log(`[ensureSticks] planks: found=${!!planks}, count=${planks?.count || 0}`);

	// 板材がない場合は原木から作る（再帰的に板材を確保するようなロジック）
	if (!planks || planks.count < 2) {
		const logItem = bot.inventory
			.items()
			.find((i) => i.name.endsWith("_log") || i.name.endsWith("_stem") || i.name.endsWith("_wood"));

		agent.log(
			`[ensureSticks] logs: found=${!!logItem}, name=${logItem?.name}, count=${logItem?.count || 0}`,
		);

		if (!logItem) {
			agent.log(`[ensureSticks] FAIL: No logs in inventory`);
			return false; // 原木もなければ不可
		}

		// 原木の種類に合わせて板材名を作る (birch_log -> birch_planks)
		const logBaseName = logItem.name.replace(/_log|_stem|_wood$/, "");
		const plankItemName = `${logBaseName}_planks`;
		agent.log(`[ensureSticks] Looking for plank: ${plankItemName}`);
		const plankItem = bot.registry.itemsByName[plankItemName];
		agent.log(`[ensureSticks] plankItem: ${plankItem?.name}, id=${plankItem?.id}`);
		const recipes = bot.recipesFor(plankItem?.id, null, 1, null);
		agent.log(`[ensureSticks] Found ${recipes.length} plank recipes, idUsed=${plankItem?.id}`);

		const plankRecipe = recipes[0];

		agent.log(`[ensureSticks] plankRecipe: found=${!!plankRecipe}`);
		if (!plankRecipe) return false;

		await bot.craft(plankRecipe, 1);
		planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
		agent.log(
			`[ensureSticks] After crafting planks: found=${!!planks}, count=${planks?.count || 0}`,
		);
	}

	// 3. 棒をクラフト（2枚の板材から4本の棒）
	if (planks && planks.count >= 2) {
		const stickRecipe = bot.recipesFor(
			bot.registry.itemsByName.stick.id,
			null,
			1,
			null, // 棒は作業台不要
		)[0];

		agent.log(`[ensureSticks] stickRecipe: found=${!!stickRecipe}`);

		if (stickRecipe) {
			await bot.craft(stickRecipe, Math.ceil(count / 4));
			const sticksAfter = bot.inventory.items().find((i) => i.name === "stick");
			agent.log(`[ensureSticks] After crafting sticks: count=${sticksAfter?.count || 0}`);
			agent.log(`[ensureSticks] SUCCESS: Crafted sticks`);
			return true;
		}
	}

	agent.log(`[ensureSticks] FAIL: Cannot craft sticks`);
	return false;
}
