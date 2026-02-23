import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

type Block = NonNullable<ReturnType<Bot["blockAt"]>>;

/**
 * 共通ロジック：作業台を確保する（周辺スキャン -> 作成 -> 設置）
 * @returns 確保された作業台のBlockオブジェクト、確保失敗時は null
 */
export async function ensureCraftingTable(bot: Bot): Promise<Block | null> {
	// 1. 周辺スキャン
	const tableBlock = bot.findBlock({
		matching: bot.registry.blocksByName.crafting_table.id,
		maxDistance: 4,
	});

	if (tableBlock) return tableBlock;

	// 2. インベントリ確認
	let tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");

	// 3. なければ作る（原木 -> 板材 -> 作業台）
	if (!tableItem) {
		let planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));

		if (!planks || planks.count < 4) {
			const logItem = bot.inventory
				.items()
				.find(
					(i) => i.name.endsWith("_log") || i.name.endsWith("_stem") || i.name.endsWith("_wood"),
				);

			if (!logItem) return null;

			const recipes = bot.recipesAll(logItem.type, null, null);
			const plankRecipe = recipes.find((r) => {
				const output = bot.registry.items[r.result.id];
				return output.name.endsWith("_planks");
			});

			if (!plankRecipe) return null;
			await bot.craft(plankRecipe, 1);
			planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
		}

		if (planks && planks.count >= 4) {
			const tableRecipe = bot.recipesFor(
				bot.registry.itemsByName.crafting_table.id,
				null,
				1,
				null,
			)[0];
			await bot.craft(tableRecipe, 1);
			tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
		}
	}

	// 4. 設置する
	if (tableItem) {
		const referenceBlock = bot.blockAt(bot.entity.position.offset(1, -1, 0));
		if (referenceBlock) {
			await bot.equip(tableItem, "hand");
			await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
			return bot.findBlock({
				matching: bot.registry.blocksByName.crafting_table.id,
				maxDistance: 4,
			});
		}
	}

	return null;
}

/**
 * 共通ロジック：かまどを確保する（周辺スキャン -> 作成 -> 設置）
 * @returns 確保されたかまどのBlockオブジェクト、確保失敗時は null
 */
export async function ensureFurnace(bot: Bot): Promise<Block | null> {
	// 1. 周辺スキャン
	const furnaceBlock = bot.findBlock({
		matching: bot.registry.blocksByName.furnace.id,
		maxDistance: 4,
	});

	if (furnaceBlock) return furnaceBlock;

	// 2. インベントリ確認
	let furnaceItem = bot.inventory.items().find((i) => i.name === "furnace");

	// 3. なければ作る（丸石 x 8 -> かまど）
	if (!furnaceItem) {
		const cobble = bot.inventory.items().find((i) => i.name === "cobblestone");

		// 丸石が8個以上必要
		if (!cobble || cobble.count < 8) return null;

		// かまど作成には作業台が必要
		const table = await ensureCraftingTable(bot);
		if (!table) return null;

		const furnaceRecipe = bot.recipesFor(bot.registry.itemsByName.furnace.id, null, 1, table)[0];

		if (!furnaceRecipe) return null;

		await bot.craft(furnaceRecipe, 1, table);
		furnaceItem = bot.inventory.items().find((i) => i.name === "furnace");
	}

	// 4. 設置する
	if (furnaceItem) {
		// 作業台と重ならないよう、少しずらした位置（例: Z軸に+1）に設置
		const referenceBlock = bot.blockAt(bot.entity.position.offset(1, -1, 1));
		if (referenceBlock) {
			await bot.equip(furnaceItem, "hand");
			await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
			return bot.findBlock({
				matching: bot.registry.blocksByName.furnace.id,
				maxDistance: 4,
			});
		}
	}

	return null;
}
