/**
 * 統合版で使うスキルの一覧。
 *
 * 本番(bedrock.ts)と、ローカルの採点(scenario.ts)で同じものを使う。
 * 別々に持つと「手元では通ったのに本番では別の一覧だった」が起きる。
 */
import { buildingBaseSkill } from "../skills/building/base";
import { buildBedSkill } from "../skills/building/bed";
import { collectDirtSkill } from "../skills/collecting/dirt";
import { huntAnimalsSkill } from "../skills/collecting/hunting";
import { mineOresSkill } from "../skills/collecting/mining";
import { collectStoneSkill } from "../skills/collecting/stone";
import { collectWoodSkill } from "../skills/collecting/wood";
import { craftSmeltingSkill } from "../skills/crafting/smelting";
import { craftToolSkill } from "../skills/crafting/tool";
import { craftTorchSkill } from "../skills/crafting/torch";
import { craftWeaponSkill } from "../skills/crafting/weapon";
import { exploreLandSkill } from "../skills/exploring/land";
import { gotoBaseSkill } from "../skills/goto/base";
import { gotoCoordsSkill } from "../skills/goto/coords";
import { gotoDeathPointSkill } from "../skills/goto/death";
import { gotoLandmarkSkill } from "../skills/goto/landmark";
import { gotoPlayerSkill } from "../skills/goto/player";
import { gotoSurfaceSkill } from "../skills/goto/surface";
import { giveItemSkill } from "../skills/social/give";
import { survivalEatSkill } from "../skills/survival/eat";
import { secureFoodSkill } from "../skills/survival/food";
import { survivalHideSkill } from "../skills/survival/hide";

// 統合版でもスキルは一通り動く。Driver 層が Java 版との差を吸収しているので
// skills/ 側は共通のものをそのまま使う。
//
// collecting.stealing だけ外している。中身を漁るのは他プレイヤーのチェストで、
// 本番の Realm では壊してよいものの範囲外だから。破壊や設置は許可されている。
export const bedrockSkills = [
	// 死んだあとの回収を最優先で選べるようにしておく。持ち物は全部その場に
	// 落ち、5分ほどで消える。取りに戻らないと何を積んでも残らない。
	gotoDeathPointSkill,
	exploreLandSkill,
	gotoSurfaceSkill,
	gotoCoordsSkill,
	gotoPlayerSkill,
	gotoBaseSkill,
	// 地上に出ても行き先が無いと、その場をランダムに歩くだけで拠点へ着かない。
	// 見かけた人工物へ向かう手を持たせる。
	gotoLandmarkSkill,
	collectWoodSkill,
	collectStoneSkill,
	collectDirtSkill,
	mineOresSkill,
	huntAnimalsSkill,
	// 狩る→焼く→食べるを一続きで行う。満腹度18を切ると体力が自然回復
	// しないので、これが通らない限り他の何をしても積み上がらない。
	secureFoodSkill,
	// 何を食べるかは LLM が決める。反射の eat が外す生の鶏肉も、LLM が選べば食べる。
	survivalEatSkill,
	// 隠れるのも LLM が選べる。反射は既定でしか籠らない。
	survivalHideSkill,
	craftToolSkill,
	craftWeaponSkill,
	craftTorchSkill,
	craftSmeltingSkill,
	buildingBaseSkill,
	// 復帰地点を動かす唯一のチート無しの手段。死亡30回中14回が復帰地点の
	// 真下のクレーターだった(2026-09-20)。
	buildBedSkill,
	giveItemSkill,
];
