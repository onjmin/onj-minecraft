/**
 * 計測そのものを確かめる。
 *
 * ここが狂うと、効いていない変更を「効いた」と読んでしまう。時計は
 * 差し替えられるようにしてあるので、何時間ぶんでも一瞬で回せる。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("LLM が許した籠り(shelter(llm))は内訳に残るが、スキル可の率では idle と数える", () => {
	const clock = fakeClock(0);
	const m = new SurvivalMetrics({ now: clock.now });
	// at:0 は「まだ1回も測っていない」と同じ扱いになるので 1 秒から始める。
	m.noteTick(emptySnapshot({ at: 1_000 }), null);
	m.noteTick(emptySnapshot({ at: 11_000 }), "shelter(llm)");
	m.noteTick(emptySnapshot({ at: 21_000 }), "shelter");
	const sum = m.summary();
	assert.equal(sum.controlMsByRule["shelter(llm)"], 10_000);
	assert.equal(sum.controlMsByRule.shelter, 10_000);
	assert.equal(sum.skillIdleRatio, 0.5);
});

test("死亡はその場で書き出される。定期報告を待たない", () => {
	// 定期報告(reportIfDue)の間隔の途中で死んで落ちると、その区間が丸ごと
	// 消える。しかも消えるのは「死んだ回」に偏るので、死亡数だけが抜けて
	// 稼働時間は残り、死亡率が実際より低く出る。実測 2026-09-21、ログを
	// grep した死亡は 30 件あるのに metrics-*.json の合計は 20 件だった。
	const clock = fakeClock(1_000);
	const savePath = path.join(os.tmpdir(), `metrics-death-save-${process.pid}-${Date.now()}.json`);
	const m = new SurvivalMetrics({ savePath, now: clock.now });
	try {
		assert.equal(fs.existsSync(savePath), false, "まだ何も書かれていないはず");

		m.noteDeath();

		assert.equal(fs.existsSync(savePath), true, "死亡時に書き出されていない");
		const saved = JSON.parse(fs.readFileSync(savePath, "utf8"));
		assert.equal(saved.deaths, 1);
	} finally {
		if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
	}
});

test("腐った肉しか無い時間は、食料保有に入らず腐肉込みには入る", () => {
	const clock = fakeClock();
	const m = new SurvivalMetrics({ now: clock.now });
	// pickFood は腐肉を選ばない(NEVER_EAT)ので edible は null のまま。
	// これを「食料ゼロ」と数えていたため、腐肉で夜を越えた run でも
	// 食料保有 1% と出ていた(実測 2026-09-21 run165)。
	for (let i = 0; i < 60; i++) {
		clock.advance(10_000);
		m.noteTick(
			emptySnapshot({ at: clock.now(), edible: null, cookable: null, lastResortFood: true }),
			null,
		);
	}
	const summary = m.summary();
	assert.equal(summary.haveFoodRatio, 0);
	assert.equal(summary.anyFoodRatio, 1);
});

test("何も持っていなければ、どちらの食料保有も 0", () => {
	const clock = fakeClock();
	const m = new SurvivalMetrics({ now: clock.now });
	for (let i = 0; i < 60; i++) {
		clock.advance(10_000);
		m.noteTick(
			emptySnapshot({ at: clock.now(), edible: null, cookable: null, lastResortFood: false }),
			null,
		);
	}
	const summary = m.summary();
	assert.equal(summary.haveFoodRatio, 0);
	assert.equal(summary.anyFoodRatio, 0);
});
