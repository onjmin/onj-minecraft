/**
 * 裁定者の振る舞いを、サーバーもボットも無しで確かめる。
 *
 * これまで生存の判断を試す方法は「本番 Realm で8時間動かす」しか無かった。
 * 世界も時刻も湧きも毎回違うので、変更が効いたかどうか原理的に判定できず、
 * 5日ぶんのログで死亡率は 5.5〜5.9回/時から動かなかった。判断が世界の
 * コピーだけを見るようになったので、ここでは1ミリ秒もかけずに何時間ぶんでも
 * 回せる。
 *
 * 2026-09-19 にルール表を4本(escape_boxed_in / eat / sleep / shelter)に
 * 減らした。地上へ出る・食料・武器・危険域・落とし物は LLM の判断に戻した
 * ので、ここではそれらの状況で「誰も担当しない(idle)」ことを確かめる。
 *
 * 実行: pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SurvivalArbiter } from "./arbiter";
import type { SurvivalActions, SurvivalRule } from "./rules";
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

const noopActions: SurvivalActions = {
	log: () => {},
	eat: async () => true,
	shelter: async () => {},
	escapeBoxedIn: async () => {},
	sleep: async () => true,
};

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

test("食べ物が無く獲物が近くても、狩りに行くかは LLM が決める(反射は出ない)", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({ food: 10, edible: null, cookable: null, preyDistance: 12 }),
	);
	assert.equal(decision.kind, "idle");
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

test("地下深くでは潜らない。地上へ出るかどうかは LLM が決める", () => {
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
	assert.equal(decision.kind, "idle");
});

test("担当は常に1つだけ。上位の前提が立っている間は下位が割り込まない", () => {
	const arbiter = new SurvivalArbiter();
	// 満腹度も足りず、塞がれてもいる。
	const s = emptySnapshot({ food: 4, edible: "bread", boxedIn: true });
	assert.equal(arbiter.select(s).rule?.name, "escape_boxed_in");
	assert.equal(arbiter.holding, "escape_boxed_in");
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

test("武器・食料・危険域・落とし物は反射の仕事ではない。LLM に渡る(idle)", () => {
	const arbiter = new SurvivalArbiter();
	const cases: Partial<SurvivalSnapshot>[] = [
		// 丸腰で材料あり(以前は arm が担当)
		{ armed: false, armored: false, craftableWeapon: true, edible: null, food: 12 },
		// 生肉あり・食べ物なし(以前は secure_food が担当)
		{ edible: null, cookable: "chicken", food: 10 },
		// 飢えていて獲物が近い(以前は secure_food が担当)
		{ edible: null, cookable: null, food: 4, preyDistance: 8, armed: false, armored: false },
		// 危険域の中の地上(以前は leave_hazard が担当)
		{ insideHazard: true },
		// 落とし物がある昼(以前は recover_loot が担当)
		{ deathPoint: { x: 6, y: 40, z: 70 } },
		// 埋まっている(以前は surface が担当)
		{ solidAbove: 10 },
	];
	for (const c of cases) {
		assert.equal(arbiter.select(emptySnapshot(c)).kind, "idle", JSON.stringify(c));
	}
});

test("死んだら担当は持ち越さない", () => {
	const arbiter = new SurvivalArbiter();
	arbiter.select(emptySnapshot({ night: true, armed: false, armored: false, edible: null }));
	assert.equal(arbiter.holding, "shelter");
	arbiter.reset();
	assert.equal(arbiter.holding, null);
});

test("夜で丸腰なら、危険域の中でも籠りが先", () => {
	const arbiter = new SurvivalArbiter();
	const decision = arbiter.select(
		emptySnapshot({ insideHazard: true, night: true, armed: false, armored: false }),
	);
	assert.equal(decision.rule?.name, "shelter");
});

// ---- 失敗の還元 -------------------------------------------------------

/** 必ず失敗する試験用ルール。前提はいつでも立つ。 */
function failingRule(name: string, reason: string, cooldownMs = 60_000): SurvivalRule {
	return {
		name,
		why: () => `${name} を試す`,
		report: () => `Reflex ${name}: tried.`,
		when: () => true,
		holdMs: 3 * 60_000,
		cooldownMs,
		run: async () => {
			throw new Error(reason);
		},
	};
}

test("行動が失敗したら、担当を手放して LLM に理由を渡す(yield)", async () => {
	const reports: string[] = [];
	let clock = 0;
	const arbiter = new SurvivalArbiter({
		rules: [failingRule("cook", "no furnace (needs 8 cobblestone).")],
		report: (l) => reports.push(l),
		now: () => clock,
	});
	const decision = await arbiter.tick(
		emptySnapshot({ at: 0 }),
		noopActions,
		new AbortController().signal,
	);
	assert.equal(decision.kind, "yield");
	assert.equal(decision.rule, null, "失敗した直後に担当を握っていてはいけない");
	assert.equal(arbiter.holding, null);
	assert.ok(
		reports.some((r) => r.includes("FAILED") && r.includes("no furnace")),
		`失敗の理由が LLM への報告に入っていない: ${JSON.stringify(reports)}`,
	);
	assert.ok(
		reports.some((r) => /up to you/.test(r)),
		"判断を LLM に返したことを明示していない",
	);
	// 冷却中は同じルールを取り直さない。前提は変わっていないので、取ればまた同じ失敗になる。
	clock = 30_000;
	assert.equal(arbiter.select(emptySnapshot({ at: 30_000 })).kind, "idle");
	// 冷却が明ければ再挑戦できる。
	clock = 61_000;
	assert.equal(arbiter.select(emptySnapshot({ at: 61_000 })).rule?.name, "cook");
});

test("回帰: 同じ失敗を3秒おきに繰り返さない(43回の再現)", async () => {
	// 2026-09-19 17:59〜18:00、secure_food が「かまどが無い」で44回中43回失敗した。
	// 前提が変わらない限り担当を取り続けていたのが原因。
	let clock = 0;
	const arbiter = new SurvivalArbiter({
		rules: [failingRule("secure_food", "no furnace.", 60_000)],
		now: () => clock,
	});
	let runs = 0;
	const rule = failingRule("secure_food", "no furnace.", 60_000);
	const counting: SurvivalRule = {
		...rule,
		run: async () => {
			runs++;
			throw new Error("no furnace.");
		},
	};
	const a2 = new SurvivalArbiter({ rules: [counting], now: () => clock });
	const signal = new AbortController().signal;
	for (let i = 0; i < 40; i++) {
		clock = i * 3_000;
		await a2.tick(emptySnapshot({ at: clock }), noopActions, signal);
	}
	// 2分で最大でも 1 + 2分/冷却60秒 = 3回。以前は40回。
	assert.ok(runs <= 3, `2分で ${runs} 回試している。冷却が効いていない`);
	void arbiter;
});

test("中断(abort)は失敗ではない。手放さず、報告もしない", async () => {
	const reports: string[] = [];
	const controller = new AbortController();
	const arbiter = new SurvivalArbiter({
		rules: [
			{
				...failingRule("shelter", "aborted"),
				run: async () => {
					controller.abort();
					throw new Error("Aborted");
				},
			},
		],
		report: (l) => reports.push(l),
	});
	const decision = await arbiter.tick(emptySnapshot(), noopActions, controller.signal);
	assert.equal(decision.kind, "take");
	assert.ok(!reports.some((r) => r.includes("FAILED")));
});

test("担当の取得と取り上げも LLM に報告する", () => {
	const reports: string[] = [];
	const arbiter = new SurvivalArbiter({ report: (l) => reports.push(l) });
	// 昼、体力が低く敵が近い → shelter が取る。10分の上限で取り上げ。
	const base = {
		health: 8,
		food: 20,
		hostilesNear: 1,
		night: false,
		sheltered: true,
		armed: false,
		armored: false,
		edible: null,
	};
	simulate(arbiter, base, 12);
	assert.ok(reports.some((r) => r.startsWith("Reflex shelter")));
	assert.ok(reports.some((r) => r.includes("forced to stop")));
});

test("LLM が籠りを断っても、防具の無い夜は shelter が担当する。剣と防具が揃えば従う", () => {
	const arbiter = new SurvivalArbiter();
	const night = { night: true, armed: false, armored: false, edible: null as string | null };
	assert.equal(arbiter.select(emptySnapshot(night)).rule?.name, "shelter");
	// 防具の無い夜に断っても籠る(2026-09-20、夜の死12件中10件が no の直後)。
	const declinedBare = arbiter.select(
		emptySnapshot({ ...night, at: 5_000, shelterDeclined: true }),
	);
	assert.equal(declinedBare.rule?.name, "shelter");
	// 剣だけでは足りない。
	const swordOnly = new SurvivalArbiter().select(
		emptySnapshot({ ...night, armed: true, shelterDeclined: true }),
	);
	assert.equal(swordOnly.rule?.name, "shelter");
	// 剣と防具が揃っていれば、断りに従って手放す(装備があれば元から担当しない)。
	const declined = new SurvivalArbiter().select(
		emptySnapshot({ ...night, armed: true, armored: true, shelterDeclined: true }),
	);
	assert.equal(declined.rule, null);
	// 昼の断りは従来どおり従う(傷・死に続けは別)。
	const dayDeclined = new SurvivalArbiter().select(
		emptySnapshot({ night: false, health: 6, hostilesNear: 1, food: 20, shelterDeclined: true }),
	);
	assert.equal(dayDeclined.rule?.name, "shelter");
	// 瀕死なら断っていても籠る。
	const dying = new SurvivalArbiter();
	assert.equal(
		dying.select(emptySnapshot({ ...night, shelterDeclined: true, recentDeaths: 3 })).rule?.name,
		"shelter",
	);
});

test("夜に籠って保持中なら、潜った先が深くても shelter は手放さない", () => {
	const night = { night: true, armed: false, armored: false, edible: null as string | null };
	// 保持していないなら、地下深くでは担当しない(従来どおり)。
	const loose = new SurvivalArbiter().select(
		emptySnapshot({ ...night, depthBelowSurface: 12, shelterHeld: false }),
	);
	assert.notEqual(loose.rule?.name, "shelter");
	// 保持中は深くても持ち続ける(2026-09-20 21:21、潜った先が洞窟に抜けて手放し、探索して死亡)。
	const held = new SurvivalArbiter().select(
		emptySnapshot({ ...night, depthBelowSurface: 12, shelterHeld: true }),
	);
	assert.equal(held.rule?.name, "shelter");
	// 昼になれば保持中でも手放す。
	const day = new SurvivalArbiter().select(
		emptySnapshot({ ...night, night: false, depthBelowSurface: 12, shelterHeld: true }),
	);
	assert.notEqual(day.rule?.name, "shelter");
});

test("頼まれごとがあっても、防具の無い夜は shelter が担当し続ける", () => {
	const night = { night: true, armed: false, armored: false, edible: null as string | null };
	const asked = new SurvivalArbiter().select(emptySnapshot({ ...night, humanRequestFresh: true }));
	assert.equal(asked.rule?.name, "shelter");
	// 昼の頼まれごとは従来どおり譲る(傷は別)。
	const day = new SurvivalArbiter().select(
		emptySnapshot({ night: false, health: 6, hostilesNear: 1, food: 20, humanRequestFresh: true }),
	);
	assert.notEqual(day.rule?.name, undefined);
	const dayFine = new SurvivalArbiter().select(
		emptySnapshot({ ...night, night: false, humanRequestFresh: true }),
	);
	assert.notEqual(dayFine.rule?.name, "shelter");
});
