/**
 * 統合版で使うスキルの一覧。
 *
 * 本番(bedrock.ts)と、ローカルの採点(scenario.ts)で同じものを使う。
 * 別々に持つと「手元では通ったのに本番では別の一覧だった」が起きる。
 *
 * 2026-09-20 に 22 本から 13 本へ削った。70 時間・69 セッション・死亡 240 回の
 * metrics を集計し、成果ゼロか、成功率 1〜3% で時間だけ食っていたものを外した。
 * 外したもの(実行回数 / 成功 / 取得):
 *   crafting.torch        84 / 0 / 0     石炭を一度も持っていない
 *   goto.base             76 / 0 / 0     拠点が一度も登録されていない
 *   building.base         76 / 0 / 14    拠点が一度も完成していない
 *   crafting.smelting     16 / 0 / 0     かまどを一度も確保できていない
 *   collecting.mining      3 / 0 / 0     縦掘り禁止の方針と矛盾
 *   survival.secure_food 1095 / 1% / 29  213分消費。「生肉はあるがかまどが無い」206回
 *   goto.landmark        1189 / 93% / 34 空振り86%。目印はほぼ自分の残骸
 *   survival.hide         907 / 88% / 1  空振り86%。反射の籠りと同じ動作で、
 *                                        既に籠っている間に選び続けて停滞扱いになり
 *                                        LLM が夜に外へ出る副作用。Hide 欄で足りる
 *   collecting.dirt       221 / 49% / 667 柱積みと埋め戻しが消えて用途が無い
 * 24B のモデルは選択肢が少ないほど選択の質が上がる。復活させるなら実測を添えること。
 */
import { buildBedSkill } from "../skills/building/bed";
import { huntAnimalsSkill } from "../skills/collecting/hunting";
import { pickupItemsSkill } from "../skills/collecting/pickup";
import { collectStoneSkill } from "../skills/collecting/stone";
import { collectWoodSkill } from "../skills/collecting/wood";
import { craftToolSkill } from "../skills/crafting/tool";
import { craftWeaponSkill } from "../skills/crafting/weapon";
import { exploreLandSkill } from "../skills/exploring/land";
import { gotoCoordsSkill } from "../skills/goto/coords";
import { gotoDeathPointSkill } from "../skills/goto/death";
import { gotoPlayerSkill } from "../skills/goto/player";
import { gotoSurfaceSkill } from "../skills/goto/surface";
import { giveItemSkill } from "../skills/social/give";
import { survivalEatSkill } from "../skills/survival/eat";

// 統合版でもスキルは一通り動く。Driver 層が Java 版との差を吸収しているので
// skills/ 側は共通のものをそのまま使う。
//
// collecting.stealing は外している。中身を漁るのは他プレイヤーのチェストで、
// 本番の Realm では壊してよいものの範囲外だから。破壊や設置は許可されている。
export const bedrockSkills = [
	// 死んだ場所へ戻る。統合版は死ぬと持ち物が全部その場に
	// 落ち、5分ほどで消える。取りに戻らないと何を積んでも残らない。
	gotoDeathPointSkill,
	exploreLandSkill,
	gotoSurfaceSkill,
	gotoCoordsSkill,
	gotoPlayerSkill,
	collectWoodSkill,
	collectStoneSkill,
	huntAnimalsSkill,
	// 落ちている物を拾う。夜明けに焼けたゾンビの腐った肉、自分の落とし物(2026-09-20)。
	pickupItemsSkill,
	// 何を食べるかは LLM が決める。反射の eat が外す生の鶏肉も、LLM が選べば食べる。
	survivalEatSkill,
	craftToolSkill,
	craftWeaponSkill,
	// 復帰地点を動かす唯一のチート無しの手段。死亡30回中14回が復帰地点の
	// 真下のクレーターだった(2026-09-20)。
	buildBedSkill,
	giveItemSkill,
];
