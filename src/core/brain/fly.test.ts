/**
 * ハエの感覚と運動の対応表を、脳もサーバーも無しで確かめる。
 *
 * 実行: pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntityInfo } from "../driver/types";
import { emptySnapshot } from "../survival/snapshot";
import { motorToDecision, readMotor } from "./fly-motor";
import { relativeBearing, senseWorld } from "./fly-senses";

const at = { x: 0, y: 64, z: 0 };
const mob = (name: string, x: number, z: number, kind = "mob"): EntityInfo => ({
	id: 1,
	name,
	kind,
	position: { x, y: 64, z },
});

test("南(yaw 0)を向いていると、西(-X)は右、東(+X)は左", () => {
	assert.ok(relativeBearing(at, 0, { x: -5, y: 64, z: 0 }) > 80);
	assert.ok(relativeBearing(at, 0, { x: 5, y: 64, z: 0 }) < -80);
	assert.ok(Math.abs(relativeBearing(at, 0, { x: 0, y: 64, z: 5 })) < 1);
});

test("右から迫るゾンビは右の looming を強く、左を弱くする", () => {
	const s = senseWorld({
		snapshot: emptySnapshot(),
		self: at,
		yaw: 0,
		entities: [mob("zombie", -3, 0)],
		hurt: false,
	});
	assert.ok(s.looming_right > 0.5);
	assert.ok(s.looming_left < 0.1);
});

test("腹が減って食べ物を持てば甘い、腐肉しか無ければ苦い、満腹ならどちらも無い", () => {
	const base = { self: at, yaw: 0, entities: [], hurt: false };
	assert.ok(senseWorld({ ...base, snapshot: emptySnapshot({ food: 8 }) }).sugar > 0.9);
	const rotten = senseWorld({
		...base,
		snapshot: emptySnapshot({ food: 8, edible: null, lastResortFood: true }),
	});
	assert.equal(rotten.sugar, 0);
	assert.ok(rotten.bitter > 0.9);
	const full = senseWorld({ ...base, snapshot: emptySnapshot({ food: 20 }) });
	assert.equal(full.sugar, 0);
	assert.equal(full.bitter, 0);
});

test("一番強い出力が勝つ。どれも閾値に届かなければ止まる", () => {
	assert.equal(readMotor({ feed: 30, escape: 5 }).program, "feed");
	assert.equal(readMotor({ escape: 40, feed: 30 }).program, "escape");
	assert.equal(readMotor({ feed: 0.1 }).program, "still");
	assert.equal(readMotor({ turn_right: 10 }).program, "walk");
	assert.ok(readMotor({ walk_forward: 5, turn_right: 9, turn_left: 1 }).turn > 0.5);
	// 旋回の方が身繕いより強ければ歩く。
	assert.equal(readMotor({ turn_left: 45, groom: 13 }).program, "walk");
});

const offered = (...names: string[]) => names.map((name) => ({ name, blocked: null }));

test("逃避は敵の反対側へ走り、構えを flee にする", () => {
	const d = motorToDecision({
		program: "escape",
		turn: 0,
		self: at,
		yaw: 0,
		entities: [mob("zombie", 0, 5)],
		offered: offered("goto.coords"),
		summary: "",
	});
	assert.equal(d.action?.name, "goto.coords");
	assert.ok((d.action?.args?.z as number) < -5, "ゾンビは南(+Z)にいるので北へ");
	assert.equal(d.stance, "flee");
});

test("食べる出力でも、食べられる物が無ければ止まるだけ", () => {
	const d = motorToDecision({
		program: "feed",
		turn: 0,
		self: at,
		yaw: 0,
		entities: [],
		offered: [{ name: "survival.eat", blocked: "nothing edible" }],
		summary: "",
	});
	assert.equal(d.action?.name, "survival.rest");
});

test("歩く出力は、匂いのする落とし物へ寄る", () => {
	const d = motorToDecision({
		program: "walk",
		turn: 0,
		self: at,
		yaw: 0,
		entities: [mob("rotten_flesh", 2, 4, "item")],
		offered: offered("collecting.pickup", "exploring.explore_land"),
		summary: "",
	});
	assert.equal(d.action?.name, "collecting.pickup");
});
