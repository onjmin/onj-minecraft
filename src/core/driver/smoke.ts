/**
 * サーバー接続なしで実施できる範囲の健全性チェック。
 *
 * 確認すること:
 *   1. skills/ と driver/ がすべて読み込めるか（循環importの検出）
 *   2. JavaDriver が BotDriver の全メソッドを実行時に持っているか
 *   3. スキル定義が壊れていないか（name / handler の存在）
 *
 * mineflayer の Bot を実際には作らないため、JavaDriver には
 * ダミーの agent を渡している。メソッドの「存在」だけを見る。
 */
import { buildingBaseSkill } from "../../skills/building/base";
import { collectDirtSkill } from "../../skills/collecting/dirt";
import { huntAnimalsSkill } from "../../skills/collecting/hunting";
import { mineOresSkill } from "../../skills/collecting/mining";
import { stealFromChestSkill } from "../../skills/collecting/stealing";
import { collectStoneSkill } from "../../skills/collecting/stone";
import { collectWoodSkill } from "../../skills/collecting/wood";
import { craftSmeltingSkill } from "../../skills/crafting/smelting";
import { craftToolSkill } from "../../skills/crafting/tool";
import { craftTorchSkill } from "../../skills/crafting/torch";
import { craftWeaponSkill } from "../../skills/crafting/weapon";
import { exploreLandSkill } from "../../skills/exploring/land";
import { gotoBaseSkill } from "../../skills/goto/base";
import { gotoCoordsSkill } from "../../skills/goto/coords";
import { gotoPlayerSkill } from "../../skills/goto/player";
import { gotoSurfaceSkill } from "../../skills/goto/surface";
import { JavaDriver } from "./java";
import type { BotDriver } from "./types";

const allSkills = [
	huntAnimalsSkill,
	mineOresSkill,
	collectWoodSkill,
	stealFromChestSkill,
	collectStoneSkill,
	collectDirtSkill,
	exploreLandSkill,
	craftToolSkill,
	craftWeaponSkill,
	craftSmeltingSkill,
	craftTorchSkill,
	buildingBaseSkill,
	gotoCoordsSkill,
	gotoBaseSkill,
	gotoPlayerSkill,
	gotoSurfaceSkill,
];

/** BotDriver が備えるべきメンバー。インターフェースの実装漏れを実行時に検出する。 */
const REQUIRED_MEMBERS: (keyof BotDriver)[] = [
	"world",
	"inventory",
	"registry",
	"getState",
	"nearbyEntities",
	"goto",
	"stopMoving",
	"setControlState",
	"clearControlStates",
	"lookAt",
	"dig",
	"placeBlock",
	"activateBlock",
	"attack",
	"equip",
	"equipBestTool",
	"pickupNearbyItems",
	"craft",
	"canCraft",
	"canSmelt",
	"smelt",
	"takeAllFromContainer",
	"chat",
	"connect",
	"disconnect",
	"on",
	"off",
];

const REQUIRED_WORLD = [
	"blockAt",
	"findBlock",
	"findBlocks",
	"findBlocksMatching",
	"findBlocksFar",
	"getBiome",
	"getLightLevel",
];
const REQUIRED_INVENTORY = ["items", "heldItem", "emptySlotCount"];
const REQUIRED_REGISTRY = ["hasBlock", "hasItem"];

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "  OK  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};

console.log("--- 1. スキル定義 ---");
check("スキル数が16本", allSkills.length === 16, `${allSkills.length}本`);
const names = new Set<string>();
for (const skill of allSkills) {
	const ok = typeof skill?.name === "string" && typeof skill?.handler === "function";
	if (!ok) check(`スキル定義が不正: ${skill?.name ?? "(不明)"}`, false);
	names.add(skill.name);
}
check("全スキルが name と handler を持つ", names.size === allSkills.length, `${names.size}種`);

console.log("\n--- 2. JavaDriver が BotDriver を実装しているか ---");
// bot に触れずメンバーの有無だけを見るため、最小限のダミーを渡す
const driver = new JavaDriver({ bot: {} } as never) as unknown as Record<string, unknown>;

for (const member of REQUIRED_MEMBERS) {
	check(`driver.${member}`, driver[member] !== undefined);
}
const sub = (name: string, keys: string[]) => {
	const obj = driver[name] as Record<string, unknown> | undefined;
	for (const k of keys) check(`driver.${name}.${k}`, typeof obj?.[k] === "function");
};
sub("world", REQUIRED_WORLD);
sub("inventory", REQUIRED_INVENTORY);
sub("registry", REQUIRED_REGISTRY);

console.log(`\n=== ${failures === 0 ? "すべて通過 ✅" : `${failures} 件の失敗 ❌`} ===`);
process.exit(failures === 0 ? 0 : 1);
