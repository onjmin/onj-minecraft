/**
 * 危険域の計算を、サーバー無しで確かめる。
 *
 * 実行: pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FALL_ZONE_RADIUS,
	HAZARD_EXIT_MARGIN,
	type HazardZone,
	hazardAt,
	hazardExit,
	noteFallDeath,
	parseHazardFile,
} from "./hazard";

const crater: HazardZone = { x: 6, z: 66, radius: 48, reason: "初期リスのクレーター" };

test("区域の中にいれば区域が返り、外なら null", () => {
	assert.equal(hazardAt([crater], { x: 10, z: 70 }), crater);
	assert.equal(hazardAt([crater], { x: 6 + 48, z: 66 }), crater);
	assert.equal(hazardAt([crater], { x: 6 + 49, z: 66 }), null);
	assert.equal(hazardAt([], { x: 6, z: 66 }), null);
});

test("出口は中心から自分を通る向きで、縁より外にある", () => {
	const exit = hazardExit([crater], crater, { x: 16, z: 66 });
	assert.equal(exit.z, 66);
	assert.equal(exit.x, 6 + 48 + HAZARD_EXIT_MARGIN);
	assert.equal(hazardAt([crater], exit), null);
});

test("中心に立っているときも出口が決まる", () => {
	const exit = hazardExit([crater], crater, { x: 6, z: 66 });
	assert.equal(hazardAt([crater], exit), null);
});

test("出た先が別の区域なら、そちらの外まで押し出す", () => {
	const next: HazardZone = { x: 6 + 48 + 20, z: 66, radius: 30, reason: "隣" };
	const exit = hazardExit([crater, next], crater, { x: 16, z: 66 });
	assert.equal(hazardAt([crater, next], exit), null);
});

test("落下死1回では区域にしない。2回固まったら区域になる", () => {
	const first = noteFallDeath([], [], { x: 100, z: 100, at: 1_000 });
	assert.equal(first.zones.length, 0);
	assert.equal(first.deaths.length, 1);

	const second = noteFallDeath(first.zones, first.deaths, { x: 110, z: 104, at: 2_000 });
	assert.equal(second.zones.length, 1);
	assert.ok(second.added);
	assert.equal(second.added?.radius, FALL_ZONE_RADIUS);
	assert.equal(second.added?.x, 105);
	assert.equal(second.added?.z, 102);
});

test("離れた落下死は固まっていないので区域にしない", () => {
	const first = noteFallDeath([], [], { x: 0, z: 0, at: 1_000 });
	const second = noteFallDeath(first.zones, first.deaths, { x: 200, z: 0, at: 2_000 });
	assert.equal(second.zones.length, 0);
});

test("区域の縁の近くで落ちたら、区域をそこまで広げる", () => {
	const r = noteFallDeath([crater], [], { x: 6 + 45, z: 66, at: 1_000 });
	assert.equal(r.zones.length, 1);
	assert.ok(r.zones[0].radius > crater.radius);
	assert.equal(r.added, null);
});

test("保存ファイルは壊れていても落ちない", () => {
	assert.deepEqual(parseHazardFile(null), { zones: [], fallDeaths: [] });
	assert.deepEqual(parseHazardFile({ zones: "x" }), { zones: [], fallDeaths: [] });
	const ok = parseHazardFile({
		zones: [{ x: 1, z: 2, radius: 3, reason: "r" }, { x: "bad" }],
		fallDeaths: [{ x: 1, z: 2, at: 3 }, { x: 1 }],
	});
	assert.equal(ok.zones.length, 1);
	assert.equal(ok.fallDeaths.length, 1);
});
