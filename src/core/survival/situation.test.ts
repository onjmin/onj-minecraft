/**
 * 状況の言語化を確かめる。
 *
 * ここが LLM に渡す唯一の「解釈済みの事実」なので、抜けがあると LLM は
 * その事実を知らないまま選ぶ。2026-09-19 に反射から外した5つの判断
 * (地上へ出る・食料・武器・危険域・落とし物)の材料が全部載ることを見る。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSituation, ticksUntilNightChange } from "./situation";
import { emptySnapshot } from "./snapshot";

const joined = (lines: string[]) => lines.join("\n");

test("地下にいるなら、地表までの高さと「ここには何も無い」を言う", () => {
	const text = joined(describeSituation(emptySnapshot({ depthBelowSurface: 20 })));
	assert.match(text, /UNDERGROUND/);
	assert.match(text, /20 blocks above you/);
	assert.match(text, /no wood or animals/);
});

test("生肉はあるなら、焼けないこと(精錬は外した)と生で食べる道を言う", () => {
	const text = joined(
		describeSituation(emptySnapshot({ edible: null, cookable: "chicken", food: 10 })),
	);
	assert.match(text, /You carry raw chicken\. You have no way to cook it/);
	assert.match(text, /eaten as-is via survival\.eat/);
	assert.doesNotMatch(text, /furnace needs/);
});

test("丸腰でも材料があるなら、剣を作れると言う", () => {
	const text = joined(
		describeSituation(emptySnapshot({ armed: false, armored: false, craftableWeapon: true })),
	);
	assert.match(text, /UNARMED but carry enough wood/);
});

test("危険域の中なら、出口の座標を添える", () => {
	const text = joined(
		describeSituation(emptySnapshot({ insideHazard: true }), { hazardExit: { x: 60, z: 70 } }),
	);
	assert.match(text, /INSIDE a dug-out hazard zone/);
	// 出口は x,z の2値。"(60, 70)" と書くと LLM が x,y と読む(実測 2026-09-20)。
	assert.match(text, /x=60, z=70/);
	assert.match(text, /goto\.coords\(x: 60, z: 70\)/);
});

test("落とし物は位置・水平距離・高さの差・消える時間を言う", () => {
	const text = joined(
		describeSituation(
			emptySnapshot({ foot: { x: 0, y: 70, z: 0 }, deathPoint: { x: 10, y: 50, z: 0 } }),
			{ lootNearRecentDeath: true },
		),
	);
	assert.match(text, /\(10, 50, 0\)/);
	assert.match(text, /10 blocks away horizontally, 20 blocks below you/);
	assert.match(text, /vanish/);
	assert.match(text, /killed near there/);
});

test("夜なら夜明けまで、昼なら日没までの残りを言う", () => {
	assert.match(
		joined(describeSituation(emptySnapshot({ night: true, timeOfDay: 18000 }))),
		/NIGHT/,
	);
	assert.match(
		joined(describeSituation(emptySnapshot({ night: true, timeOfDay: 18000 }))),
		/Dawn in/,
	);
	assert.match(joined(describeSituation(emptySnapshot({ timeOfDay: 1000 }))), /Night falls in/);
});

test("夜明け・日没までの tick", () => {
	assert.equal(ticksUntilNightChange(18000), 5000);
	assert.equal(ticksUntilNightChange(1000), 12000);
	assert.equal(ticksUntilNightChange(23500), 13500);
});

test("満腹度が18未満なら、自然回復が止まっていることを言う", () => {
	const text = joined(describeSituation(emptySnapshot({ food: 12 })));
	assert.match(text, /does NOT regenerate below 18/);
});

test("深さが読めなくても、頭上が厚ければ地下だと言う", () => {
	const text = joined(describeSituation(emptySnapshot({ depthBelowSurface: null, solidAbove: 5 })));
	assert.match(text, /UNDERGROUND/);
	assert.match(text, /dig up/);
});

test("生肉を持っているなら、生のまま食べる選択肢と回復量を言う", () => {
	const chicken = joined(describeSituation(emptySnapshot({ edible: null, cookable: "chicken" })));
	assert.match(chicken, /eaten as-is via survival.eat/);
	assert.match(chicken, /30% chance/);
	const beef = joined(describeSituation(emptySnapshot({ edible: null, cookable: "beef" })));
	assert.match(beef, /Raw beef can be eaten as-is/);
});

test("復帰地点が危険域の中なら、そう言い、ベッドで動かせることも言う", () => {
	const text = joined(describeSituation(emptySnapshot(), { respawnInHazard: true, wool: 2 }));
	assert.match(text, /RESPAWN POINT is inside the dug-out hazard zone/);
	assert.match(text, /building\.bed/);
	assert.match(text, /You carry 2 wool; a bed needs 3 of one color/);
	const ready = joined(
		describeSituation(emptySnapshot(), { respawnInHazard: true, wool: 3, bedWoolReady: true }),
	);
	assert.match(ready, /enough wool for a bed/);
	const fine = joined(describeSituation(emptySnapshot(), { respawnInHazard: false }));
	assert.doesNotMatch(fine, /RESPAWN POINT/);
});

test("食料も動物も無いなら「動物はいない」と言う", () => {
	const text = joined(
		describeSituation(emptySnapshot({ edible: null, cookable: null, preyDistance: null })),
	);
	assert.match(text, /No huntable animal is in sight/);
});

test("夜に地上で死んだ回数を言う。剣を持っていても言う", () => {
	const text = joined(
		describeSituation(emptySnapshot({ night: true, timeOfDay: 15000, armed: true }), {
			nightSurfaceDeaths: { night: 4, total: 5 },
		}),
	);
	assert.match(text, /Of your last 5 death\(s\), 4 happened at NIGHT on the SURFACE/);
	assert.match(text, /it is night now/);
	assert.match(text, /wooden sword has not changed that/);
	const none = joined(
		describeSituation(emptySnapshot(), { nightSurfaceDeaths: { night: 0, total: 3 } }),
	);
	assert.doesNotMatch(none, /at NIGHT on the SURFACE/);
});

test("腐った肉しか無いなら、食べられることと回復量・リスクを言う", () => {
	const text = joined(
		describeSituation(emptySnapshot({ edible: null, cookable: null, preyDistance: null }), {
			rottenFlesh: 3,
		}),
	);
	assert.match(text, /3 rotten flesh/);
	assert.match(text, /\+4 hunger/);
	assert.doesNotMatch(text, /You have no food and nothing to cook/);
});

test("落ちている物と、夜明け直後のゾンビの燃焼を言う", () => {
	const text = joined(
		describeSituation(emptySnapshot({ night: false, timeOfDay: 600, depthBelowSurface: 0 }), {
			droppedItems: ["rotten_flesh(3m)", "spruce_log(12m)"],
		}),
	);
	assert.match(text, /Items lying on the ground nearby: rotten_flesh\(3m\), spruce_log\(12m\)/);
	assert.match(text, /collecting\.pickup/);
	assert.match(text, /just after dawn/);
	const noon = joined(describeSituation(emptySnapshot({ night: false, timeOfDay: 6000 })));
	assert.doesNotMatch(noon, /just after dawn/);
});

test("地下では高さの推移を言う。往復しているだけかが読める", () => {
	const text = joined(
		describeSituation(emptySnapshot({ depthBelowSurface: 40 }), {
			heightTrend: { minutes: 12, from: 18, to: 23, low: 18, high: 24 },
		}),
	);
	assert.match(
		text,
		/Over the last 12 minutes your height went from Y=18 to Y=23 \(net \+5, ranging Y=18\.\.24\)/,
	);
	const surface = joined(
		describeSituation(emptySnapshot({ depthBelowSurface: 0 }), {
			heightTrend: { minutes: 12, from: 60, to: 62, low: 60, high: 62 },
		}),
	);
	assert.doesNotMatch(surface, /your height went from/);
});
