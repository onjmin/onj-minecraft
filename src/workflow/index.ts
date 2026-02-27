import { AgentOrchestrator } from "../core/agent";
import { profiles } from "../profiles";
import { farmTendCropsSkill } from "../skills/collecting/farming";
import { fellTreesSkill } from "../skills/collecting/felling";
import { huntAnimalsSkill } from "../skills/collecting/hunting";
import { mineOresSkill } from "../skills/collecting/mining";
import { stealFromChestSkill } from "../skills/collecting/stealing";
import { craftSmeltingSkill } from "../skills/crafting/smelting";
import { craftStorageSkill } from "../skills/crafting/storage";
import { craftToolSkill } from "../skills/crafting/tool";
import { craftWeaponSkill } from "../skills/crafting/weapon";
import { exploreLandSkill } from "../skills/exploring/land";
import { exploreSeaSkill } from "../skills/exploring/sea";
import { exploreUndergroundSkill } from "../skills/exploring/underground";

const allSkills = [
	// --- Collecting Domain (With integrated Eat/Equip routine) ---
	farmTendCropsSkill, // 収穫 + 再植え付け + 食事
	huntAnimalsSkill, // 狩猟 + 回収 + 食事
	mineOresSkill, // 採掘
	fellTreesSkill, // 伐採
	stealFromChestSkill, // 略奪 + 装備更新 + 食事

	// --- Exploring Domain ---
	exploreLandSkill, // 陸上探索
	exploreSeaSkill, // 海上探索
	exploreUndergroundSkill, // 地下探索

	// --- Crafting Domain (The "One-at-a-time" Iterative skills) ---
	craftToolSkill, // 道具作成
	craftWeaponSkill, // 武器作成
	craftStorageSkill, // チェスト作成
	craftSmeltingSkill, // 精錬開始
];
/**
 * Initialize and start all agents
 * 全てのエージェントを初期化して起動
 */
(async () => {
	for (const profile of Object.values(profiles)) {
		new AgentOrchestrator(profile, allSkills);
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
})();

console.log(`Started ${Object.values(profiles).length} agents.`);
