/**
 * 計測そのものを確かめる。
 *
 * ここが狂うと、効いていない変更を「効いた」と読んでしまう。時計は
 * 差し替えられるようにしてあるので、何時間ぶんでも一瞬で回せる。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SurvivalMetrics } from "./metrics";
import { emptySnapshot } from "./snapshot";

function fakeClock(start = 0) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

test("スキルが動かない時間の最長が残る", () => {
	const clock = fakeClock();
	const m = new SurvivalMetrics({ now: clock.now });
	// 生存側が担当を握ったまま、スキルが1つも動かない状態を20分続ける。
	for (let i = 0; i < 120; i++) {
		clock.advance(10_000);
		m.noteTick(emptySnapshot({ at: clock.now() }), "shelter");
	}
	const summary = m.summary();
	assert.ok(
		summary.longestStallMs >= 19 * 60_000,
		`最長停滞が短すぎる: ${summary.longestStallMs}ms`,
	);
	assert.equal(summary.skillIdleRatio, 0);
	assert.ok((summary.controlMsByRule.shelter ?? 0) > 0);
});

test("スキルが動いていれば停滞は伸びない", () => {
	const clock = fakeClock();
	const m = new SurvivalMetrics({ now: clock.now });
	for (let i = 0; i < 120; i++) {
		clock.advance(10_000);
		m.noteTick(emptySnapshot({ at: clock.now() }), null);
		m.noteSkill("collecting.wood", true, true, 3, 5_000);
	}
	assert.ok(m.summary().longestStallMs <= 30_000);
	assert.equal(m.summary().skills["collecting.wood"].gained, 360);
});

test("成功しても世界が変わらなければ空振りとして数える", () => {
	const m = new SurvivalMetrics({ now: fakeClock().now });
	for (let i = 0; i < 10; i++) m.noteSkill("crafting.weapon", true, false, 0, 100);
	const st = m.summary().skills["crafting.weapon"];
	assert.equal(st.runs, 10);
	assert.equal(st.ok, 10);
	assert.equal(st.empty, 10);
});

test("死亡の間隔は中央値で出す。平均だと1回の長生きで歪む", () => {
	const clock = fakeClock();
	const m = new SurvivalMetrics({ now: clock.now });
	for (const gap of [60_000, 60_000, 60_000, 3_600_000]) {
		m.noteDeath();
		clock.advance(gap);
	}
	m.noteDeath();
	assert.equal(m.summary().deaths, 5);
	assert.equal(m.summary().medianSurvivalMs, 60_000);
});

test("食料や武器を持っていた時間の割合が出る", () => {
	const clock = fakeClock();
	const m = new SurvivalMetrics({ now: clock.now });
	// 前半は手ぶら、後半は食料と武器を持っている。
	for (let i = 0; i < 60; i++) {
		clock.advance(10_000);
		m.noteTick(
			emptySnapshot({ at: clock.now(), edible: null, cookable: null, armed: false }),
			null,
		);
	}
	for (let i = 0; i < 60; i++) {
		clock.advance(10_000);
		m.noteTick(emptySnapshot({ at: clock.now(), edible: "cooked_beef", armed: true }), null);
	}
	const s = m.summary();
	assert.ok(Math.abs(s.haveFoodRatio - 0.5) < 0.02, `食料保有率 ${s.haveFoodRatio}`);
	assert.ok(Math.abs(s.armedRatio - 0.5) < 0.02, `武器保有率 ${s.armedRatio}`);
});
