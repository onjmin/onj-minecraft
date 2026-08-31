/**
 * クラフトの連鎖が端から端まで通るかを、本番 Realm で確かめる。
 *
 * skillcheck は各スキルを1回ずつ呼ぶので、「木が無いから棒が無い、棒が無いから
 * 道具が無い」という連鎖の入口で全部止まる。ここでは順序を固定して、
 * 前の段の成果を次の段に渡しながら進む。
 *
 * 見たいのは特に 3x3 のクラフト。サイドカーは作業台が要るレシピを
 * 「持ち物の画面を開く」だけで送っており、作業台の画面を開いていない。
 * 2x2(棒・板)が通ることは確認済みだが、3x3(道具)は未確認。
 *
 * 実行:
 *   REALM_INVITE=https://realms.gg/xxxx npx tsx --env-file=.env \
 *     src/core/driver/bedrock-craft-chain.ts
 */
import { BedrockDriver } from "./bedrock";

const INVITE = process.env.REALM_INVITE ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const step = (label: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "  OK  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
	return ok;
};

async function main() {
	if (!INVITE) throw new Error("REALM_INVITE を指定してください");
	const driver = new BedrockDriver({ realmInvite: INVITE });
	driver.on("end", (r: string) => console.log(`[chain] 切断: ${r}`));

	console.log("[chain] 接続中...");
	await driver.connect();
	await sleep(6000);

	const count = (name: string) => driver.inventory.items().find((i) => i.name === name)?.count ?? 0;
	const anyLog = () => driver.inventory.items().find((i) => i.name.endsWith("_log"));
	const anyPlanks = () => driver.inventory.items().find((i) => i.name.endsWith("_planks"));

	const show = () =>
		console.log(
			`  持ち物: ${
				driver.inventory
					.items()
					.map((i) => `${i.name}x${i.count}`)
					.join(", ") || "空"
			}`,
		);
	show();

	// 1. 原木。無ければ近くの木を1本掘る。
	if (!anyLog() && !anyPlanks()) {
		const logs = driver.world.findBlocksMatching((n) => n.endsWith("_log"), 24, 1);
		if (!step("原木が近くにある", logs.length > 0)) {
			await driver.disconnect();
			process.exit(1);
		}
		const target = logs[0].position;
		console.log(`[chain] 原木 ${logs[0].name} を掘りに行く...`);
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 90_000);
		try {
			await driver.goto(ac.signal, { kind: "near", position: target, distance: 2 });
			await driver.equipBestTool(target);
			await driver.dig(ac.signal, target);
			await driver.pickupNearbyItems(ac.signal);
		} catch (e) {
			console.log(`  掘る途中で: ${e}`);
		}
		clearTimeout(timer);
		show();
	}
	step(
		"原木か板を持っている",
		!!anyLog() || !!anyPlanks(),
		anyLog()?.name ?? anyPlanks()?.name ?? "",
	);

	// 2. 板。2x2 のレシピ。
	if (!anyPlanks() && anyLog()) {
		const log = anyLog()!;
		const planksName = log.name.replace("_log", "_planks");
		try {
			await driver.craft(planksName, 1);
			await sleep(600);
			step(`${planksName} を作れる`, count(planksName) > 0, `${count(planksName)}枚`);
		} catch (e) {
			step(`${planksName} を作れる`, false, String(e));
		}
		show();
	}

	// 3. 棒。2x2。
	const planks = anyPlanks();
	if (planks && count("stick") < 2) {
		try {
			await driver.craft("stick", 1);
			await sleep(600);
			step("棒を作れる", count("stick") > 0, `${count("stick")}本`);
		} catch (e) {
			step("棒を作れる", false, String(e));
		}
		show();
	}

	// 4. 作業台。2x2 だが板が4枚要る。
	if (count("crafting_table") === 0 && (anyPlanks()?.count ?? 0) >= 4) {
		try {
			await driver.craft("crafting_table", 1);
			await sleep(600);
			step("作業台を作れる", count("crafting_table") > 0);
		} catch (e) {
			step("作業台を作れる", false, String(e));
		}
		show();
	}

	// 5. 作業台を置いて 3x3 を試す。ここが本命。
	const st = driver.getState();
	let tablePos: { x: number; y: number; z: number } | null = null;
	if (count("crafting_table") > 0) {
		const foot = {
			x: Math.floor(st.position.x),
			y: Math.floor(st.position.y),
			z: Math.floor(st.position.z),
		};
		const ref = { x: foot.x + 1, y: foot.y - 1, z: foot.z };
		const below = driver.world.blockAt(ref);
		if (below && below.name !== "air") {
			try {
				await driver.equip("crafting_table", "hand");
				await driver.placeBlock(new AbortController().signal, ref, { x: 0, y: 1, z: 0 });
				await sleep(800);
				const placed = driver.world.blockAt({ x: ref.x, y: ref.y + 1, z: ref.z });
				tablePos = placed?.name === "crafting_table" ? { x: ref.x, y: ref.y + 1, z: ref.z } : null;
				step("作業台を置ける", tablePos !== null, placed?.name ?? "不明");
			} catch (e) {
				step("作業台を置ける", false, String(e));
			}
		} else {
			step("作業台を置ける", false, "隣に足場が無い");
		}
	}

	// 既に置いてあるものを使ってもよい。
	if (!tablePos) {
		const found = driver.world.findBlocks(["crafting_table"], 6, 1);
		if (found.length > 0) tablePos = found[0].position;
	}

	if (tablePos) {
		console.log(`[chain] 作業台 (${tablePos.x}, ${tablePos.y}, ${tablePos.z}) で 3x3 を試す`);
		try {
			await driver.activateBlock(tablePos);
			step("作業台を開ける（例外が出ない）", true);
		} catch (e) {
			step("作業台を開ける（例外が出ない）", false, String(e));
		}
		const before = count("wooden_pickaxe");
		try {
			await driver.craft("wooden_pickaxe", 1, tablePos);
			await sleep(1000);
			step(
				"木のツルハシ(3x3)を作れる",
				count("wooden_pickaxe") > before,
				`${count("wooden_pickaxe")}本`,
			);
		} catch (e) {
			step("木のツルハシ(3x3)を作れる", false, String(e));
		}
		show();
	} else {
		step("作業台が用意できた", false, "置けず、近くにも無い");
	}

	await driver.disconnect();
	console.log(failures === 0 ? "\n連鎖は最後まで通りました" : `\n${failures}件で止まりました`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("[chain] 失敗:", e);
	process.exit(1);
});
