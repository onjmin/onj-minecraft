/**
 * 裁定者の振る舞いを、サーバーもボットも無しで確かめる。
 *
 * これまで生存の判断を試す方法は「本番 Realm で8時間動かす」しか無かった。
 * 世界も時刻も湧きも毎回違うので、変更が効いたかどうか原理的に判定できず、
 * 5日ぶんのログで死亡率は 5.5〜5.9回/時から動かなかった。判断が世界の
 * コピーだけを見るようになったので、ここでは1ミリ秒もかけずに何時間ぶんでも
 * 回せる。
 *
 * 実行: pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SurvivalArbiter } from "./arbiter";
import { emptySnapshot, type SurvivalSnapshot } from "./snapshot";

/** 5秒ごとに1周する反射ループを、指定した分だけ回す。 */
function simulate(
	arbiter: SurvivalArbiter,
	base: Partial<SurvivalSnapshot>,
	minutes: number,
	stepMs = 5_000,
): string[] {
	const holders: string[] = [];
	const steps = Math.floor((minutes * 60_000) / stepMs);
	for (let i = 0; i < steps; i++) {
		const s = emptySnapshot({ ...base, at: i * stepMs });
		holders.push(arbiter.select(s).rule?.name ?? "idle");
	}
	return holders;
}

test("平時は誰も担当しない。スキル層が動いてよい", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(emptySnapshot());
	assert.equal(decision.kind, "idle");
	assert.equal(decision.rule, null);
});

test("満腹度が足りず、食べ物を持っているなら食べる", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(emptySnapshot({ food: 10, edible: "cooked_beef" }));
	assert.equal(decision.rule?.name, "eat");
});

test("敵が至近にいる間は食べない。食事中は動けない", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({ food: 10, edible: "cooked_beef", hostilesClose: 1, hostilesNear: 1 }),
	);
	assert.notEqual(decision.rule?.name, "eat");
});

test("食べ物が無く、昼で獲物が近いなら狩りに行く", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({ food: 10, edible: null, cookable: null, preyDistance: 12 }),
	);
	assert.equal(decision.rule?.name, "secure_food");
});

test("夜に丸腰なら退く", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({ night: true, armed: false, armored: false, edible: null }),
	);
	assert.equal(decision.rule?.name, "shelter");
});

test("夜でも装備が揃っていて無傷なら退かない", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(emptySnapshot({ night: true, armed: true }));
	assert.notEqual(decision.rule?.name, "shelter");
});

test("地下深くでは潜らない。掘るほど深くなるだけなので地上へ出る", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({
			night: true,
			armed: false,
			armored: false,
			depthBelowSurface: 25,
			edible: null,
			food: 20,
		}),
	);
	assert.equal(decision.rule?.name, "surface");
});

test("担当は常に1つだけ。上位の前提が立っている間は下位が割り込まない", () => {
	const arbiter = new SurvivalArbiter();
	// 満腹度も足りず、埋まってもいて、落とし物もある。
	const s = emptySnapshot({
		food: 4,
		edible: "bread",
		solidAbove: 10,
		deathPoint: { x: 1, y: 2, z: 3 },
	});
	assert.equal(arbiter.select(s).rule?.name, "eat");
	assert.equal(arbiter.holding, "eat");
});

test("回帰: 満腹度が足りないまま「回復を待つ」で止まり続けない", () => {
	// 2026-09-17 07:10〜11:36 の再現。体力8、敵が近い、昼、潜伏済み、
	// そして満腹度が18未満。以前はここで籠りが true を返し続け、
	// 4時間26分スキルが1つも動かなかった。
	const arbiter = new SurvivalArbiter();
	const holders = simulate(
		arbiter,
		{
			health: 8,
			food: 16,
			hostilesNear: 1,
			night: false,
			sheltered: true,
			edible: null,
			cookable: null,
			preyDistance: null,
			armed: false,
			armored: false,
		},
		300, // 5時間
	);
	assert.equal(
		holders.includes("shelter"),
		false,
		"満腹度が足りないときに籠って待つのは待ちぼうけにしかならない",
	);
	const idle = holders.filter((h) => h === "idle").length;
	assert.ok(idle > 0, "生存側が握りっぱなしで、スキルが一度も動けない状態になっている");
});

test("回帰: 昼の保持は上限で必ず取り上げられる", () => {
	const arbiter = new SurvivalArbiter();
	// 満腹度は足りているが体力が戻らない(毒などを想定)状況を、昼に固定する。
	const holders = simulate(
		arbiter,
		{
			health: 8,
			food: 20,
			hostilesNear: 1,
			night: false,
			sheltered: true,
			armed: false,
			armored: false,
			edible: null,
		},
		60,
	);
	assert.equal(holders[0], "shelter");
	assert.ok(
		holders.some((h) => h !== "shelter"),
		"上限があるのに、1時間ずっと同じルールが担当を握っている",
	);
	// 取り上げた直後にすぐ握り直さない。
	const first = holders.indexOf("shelter");
	const released = holders.findIndex((h, i) => i > first && h !== "shelter");
	assert.ok(released > 0);
	assert.notEqual(holders[released + 1], "shelter");
});

test("夜の籠りは上限で取り上げない。夜に穴から出す方が高くつく", () => {
	const arbiter = new SurvivalArbiter();
	const holders = simulate(
		arbiter,
		{ night: true, armed: false, armored: false, edible: null, sheltered: true, food: 20 },
		60,
	);
	assert.ok(
		holders.every((h) => h === "shelter"),
		"夜のあいだは籠りが担当を持ち続けるべき",
	);
});

test("朝になれば籠りは自分から手放す", () => {
	const arbiter = new SurvivalArbiter();
	const night = emptySnapshot({
		at: 0,
		night: true,
		armed: false,
		armored: false,
		edible: null,
		sheltered: true,
	});
	assert.equal(arbiter.select(night).rule?.name, "shelter");
	const morning = emptySnapshot({
		at: 60_000,
		night: false,
		armed: false,
		armored: false,
		edible: null,
		sheltered: true,
		craftableWeapon: false,
	});
	const decision = arbiter.select(morning);
	assert.notEqual(decision.rule?.name, "shelter");
});

test("四方を塞がれたら掘って出る。ただし籠りが担当している間は掘り返さない", () => {
	const arbiter = new SurvivalArbiter();
	// 昼に塞がれている → 出る
	assert.equal(arbiter.select(emptySnapshot({ boxedIn: true })).rule?.name, "escape_boxed_in");

	// 夜、自分で潜って塞がっている → 籠りが担当していて掘り返さない
	const night = new SurvivalArbiter();
	const first = night.select(
		emptySnapshot({ night: true, armed: false, armored: false, edible: null }),
	);
	assert.equal(first.rule?.name, "shelter");
	const sealed = night.select(
		emptySnapshot({
			at: 10_000,
			night: true,
			armed: false,
			armored: false,
			edible: null,
			boxedIn: true,
			sheltered: true,
		}),
	);
	assert.equal(sealed.rule?.name, "shelter");
});

test("夜に自分で潜って塞がっている状態を、閉じ込められと読み違えない", () => {
	// 再接続や死亡の直後は担当が空になる。そこで escape が先に取れると、
	// 自分で塞いだ蓋を掘り返して夜の地上へ出ることになる。
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({
			night: true,
			boxedIn: true,
			sheltered: true,
			armed: false,
			armored: false,
			edible: null,
		}),
	);
	assert.notEqual(decision.rule?.name, "escape_boxed_in");
	assert.equal(decision.rule?.name, "shelter");
});

test("素手で狩りに行かない。武器を作れるなら先に作る", () => {
	// 素手の攻撃力は1、牛の体力は10。木の剣なら3発で済む。
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({
			food: 12,
			edible: null,
			cookable: null,
			preyDistance: 8,
			armed: false,
			armored: false,
			craftableWeapon: true,
		}),
	);
	assert.equal(decision.rule?.name, "arm");
});

test("素手で、武器も作れないなら狩りに行かない（飢えていない限り）", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({
			food: 12,
			edible: null,
			cookable: null,
			preyDistance: 8,
			armed: false,
			armored: false,
			craftableWeapon: false,
		}),
	);
	assert.notEqual(decision.rule?.name, "secure_food");
});

test("本当に飢えているなら、素手でも獲物へ行く", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({
			food: 4,
			edible: null,
			cookable: null,
			preyDistance: 8,
			armed: false,
			armored: false,
			craftableWeapon: false,
		}),
	);
	assert.equal(decision.rule?.name, "secure_food");
});

test("武器があるなら、食料の確保が武器作りより先", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({
			food: 12,
			edible: null,
			cookable: null,
			preyDistance: 8,
			armed: true,
			craftableWeapon: true,
		}),
	);
	assert.equal(decision.rule?.name, "secure_food");
});

test("死んだら担当は持ち越さない", () => {
	const arbiter = new SurvivalArbiter();
	arbiter.select(emptySnapshot({ night: true, armed: false, armored: false, edible: null }));
	assert.equal(arbiter.holding, "shelter");
	arbiter.reset();
	assert.equal(arbiter.holding, null);
});

test("危険域の中で地上にいるなら、歩いて出る", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(emptySnapshot({ insideHazard: true }));
	assert.equal(decision.rule?.name, "leave_hazard");
});

test("危険域の中でも埋まっているなら、先に地上へ出る", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(emptySnapshot({ insideHazard: true, depthBelowSurface: 20 }));
	assert.equal(decision.rule?.name, "surface");
});

test("危険域の中の落とし物より、出る方が先", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({ insideHazard: true, deathPoint: { x: 6, y: 40, z: 70 } }),
	);
	assert.equal(decision.rule?.name, "leave_hazard");
});

test("夜で丸腰なら、危険域の中でも籠りが先", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({ insideHazard: true, night: true, armed: false, armored: false }),
	);
	assert.equal(decision.rule?.name, "shelter");
});

test("区域を出たら手放し、スキル層に戻る", () => {
	const arbiter = new SurvivalArbiter();
	const holders = simulate(arbiter, { insideHazard: true }, 1);
	assert.ok(holders.every((h) => h === "leave_hazard"));
	const out = arbiter.select(emptySnapshot({ insideHazard: false, at: 61_000 }));
	assert.equal(out.kind, "release");
	assert.equal(out.rule, null);
});
