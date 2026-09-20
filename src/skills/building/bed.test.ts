/**
 * ベッドの材料判定。色ごとに3枚そろっているかを見る。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickBedWool, totalWool, woolByColor } from "./bed";

test("同じ色が3枚そろった色を返す。ばらばらなら null", () => {
	assert.equal(pickBedWool([{ name: "white_wool", count: 3 }]), "white_wool");
	assert.equal(
		pickBedWool([
			{ name: "white_wool", count: 2 },
			{ name: "black_wool", count: 1 },
		]),
		null,
	);
	assert.equal(
		pickBedWool([
			{ name: "brown_wool", count: 2 },
			{ name: "brown_wool", count: 1 },
		]),
		"brown_wool",
	);
	assert.equal(pickBedWool([{ name: "wool", count: 3 }]), "wool");
});

test("合計と色別", () => {
	const items = [
		{ name: "white_wool", count: 2 },
		{ name: "black_wool", count: 1 },
		{ name: "oak_log", count: 5 },
	];
	assert.equal(totalWool(items), 3);
	assert.deepEqual(
		[...woolByColor(items)],
		[
			["white_wool", 2],
			["black_wool", 1],
		],
	);
});
