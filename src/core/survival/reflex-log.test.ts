import assert from "node:assert/strict";
import { test } from "node:test";
import { ReflexLog } from "./reflex-log";

test("同じ報告が続いたら回数にまとめる", () => {
	const log = new ReflexLog();
	log.note("Reflex eat: ate bread.");
	log.note("Reflex eat: ate bread.");
	log.note("Reflex eat: ate bread.");
	assert.deepEqual(log.peek(), ["Reflex eat: ate bread. (x3)"]);
});

test("読んだら消える。次の思考に同じ報告を二度見せない", () => {
	const log = new ReflexLog();
	log.note("a");
	assert.deepEqual(log.flush(), ["a"]);
	assert.deepEqual(log.flush(), []);
});

test("上限を超えたら古いものから落とす", () => {
	const log = new ReflexLog(3);
	for (const t of ["a", "b", "c", "d"]) log.note(t);
	assert.deepEqual(log.peek(), ["b", "c", "d"]);
});
