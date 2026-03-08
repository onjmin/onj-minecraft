import { MinecraftAgent } from "../core/agent";
import { profiles } from "../profiles";
import { buildingBaseSkill } from "../skills/building/base";
import { collectDirtSkill } from "../skills/collecting/dirt";
import { huntAnimalsSkill } from "../skills/collecting/hunting";
import { mineOresSkill } from "../skills/collecting/mining";
import { stealFromChestSkill } from "../skills/collecting/stealing";
import { collectStoneSkill } from "../skills/collecting/stone";
import { collectWoodSkill } from "../skills/collecting/wood";
import { craftSmeltingSkill } from "../skills/crafting/smelting";
import { craftToolSkill } from "../skills/crafting/tool";
import { craftTorchSkill } from "../skills/crafting/torch";
import { craftWeaponSkill } from "../skills/crafting/weapon";
import { exploreLandSkill } from "../skills/exploring/land";
import { gotoBaseSkill } from "../skills/goto/base";
import { gotoCoordsSkill } from "../skills/goto/coords";
import { gotoPlayerSkill } from "../skills/goto/player";
import { gotoSurfaceSkill } from "../skills/goto/surface";

const allSkills = [
	// --- Collecting Domain (With integrated Eat/Equip routine) ---
	huntAnimalsSkill, // 狩猟 + 回収 + 食事
	mineOresSkill, // 採掘
	collectWoodSkill, // 伐採
	stealFromChestSkill, // 略奪 + 装備更新 + 食事
	collectStoneSkill,
	collectDirtSkill, // 土収集

	// --- Exploring Domain ---
	exploreLandSkill, // 陸上探索

	// --- Crafting Domain (The "One-at-a-time" Iterative skills) ---
	craftToolSkill, // 道具作成
	craftWeaponSkill, // 武器作成
	craftSmeltingSkill, // 精錬開始
	craftTorchSkill, // トーチ作成

	// --- Building Domain ---
	buildingBaseSkill,

	// --- Goto Domain ---
	gotoCoordsSkill, // 座標へ移動
	gotoBaseSkill, // 拠点帰還
	gotoPlayerSkill, // プレイヤーへ移動
	gotoSurfaceSkill, // 地上へ移動
];
/**
 * Initialize and start all agents
 * 全てのエージェントを初期化して起動
 */
(async () => {
	for (const profile of Object.values(profiles)) {
		new MinecraftAgent(profile, allSkills);
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
})();

console.log(`Started ${Object.values(profiles).length} agents.`);
