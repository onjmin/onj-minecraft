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
import { profiles } from "../../profiles";
import { collectWoodSkill } from "../../skills/collecting/wood";
import { MinecraftAgent } from "../agent";
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

	// 伐採は実際のスキルに任せる。ここで自前に掘ると、幹の上の方を選んで
	// 「水平には着いたが採掘が届かない」ような、本番では起きない失敗を作る。
	// collecting.wood は目線の高さに近い順に掘るのでその問題が無い。
	const agent = new MinecraftAgent(Object.values(profiles)[0], [], driver);

	console.log("[chain] 接続中...");
	await driver.connect();
	await sleep(6000);

	const count = (name: string) => driver.inventory.items().find((i) => i.name === name)?.count ?? 0;
	const anyLog = () => driver.inventory.items().find((i) => i.name.endsWith("_log"));
	const anyPlanks = () => driver.inventory.items().find((i) => i.name.endsWith("_planks"));

	// 体力と位置も出す。持ち物が突然空になるのは死亡が原因のことがあり、
	// 持ち物だけ見ていると「回収に失敗した」と読み違える。
	const show = () => {
		const s2 = driver.getState();
		console.log(
			`  持ち物: ${
				driver.inventory
					.items()
					.map((i) => `${i.name}x${i.count}`)
					.join(", ") || "空"
			}  [HP ${s2.health} 満腹 ${s2.food} 位置 ${s2.position.x.toFixed(0)},${s2.position.y.toFixed(0)},${s2.position.z.toFixed(0)}]`,
		);
	};
	show();

	// 1. 原木。無ければ collecting.wood に採りに行かせる。
	// 板が足りないなら採りに行く。少しでも持っていれば飛ばす作りだと、
	// 板2枚で止まったまま何度回しても先へ進まない。
	if (!anyLog() && (anyPlanks()?.count ?? 0) < 12) {
		console.log("[chain] collecting.wood で原木を採る...");
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 120_000);
		try {
			const r = await collectWoodSkill.handler({
				agent,
				signal: ac.signal,
				args: undefined as any,
			});
			console.log(`  ${r.success ? "成功" : "失敗"}: ${r.summary}`);
		} catch (e) {
			console.log(`  伐採で例外: ${e}`);
		}
		clearTimeout(timer);
		show();
	}
	step(
		"原木か板を持っている",
		!!anyLog() || !!anyPlanks(),
		anyLog()?.name ?? anyPlanks()?.name ?? "",
	);

	// 2. 板。2x2 のレシピ。作業台(4)と道具(3+棒)に要るので多めに作る。
	if (anyLog()) {
		const log = anyLog()!;
		const planksName = log.name.replace("_log", "_planks");
		const want = 12;
		while (count(planksName) < want && anyLog()) {
			try {
				await driver.craft(planksName, 1);
				await sleep(400);
			} catch (e) {
				step(`${planksName} を作れる`, false, String(e));
				break;
			}
		}
		step(`${planksName} を ${want} 枚そろえる`, count(planksName) >= 4, `${count(planksName)}枚`);
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
	if (count("crafting_table") === 0) {
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
		// 置ける場所を探す。足元と同じ高さが空いていて、その下が固いところ。
		// 適当に隣を狙うと、既に何か建っている場所を選んで失敗する。
		const spot = [
			{ x: 1, z: 0 },
			{ x: -1, z: 0 },
			{ x: 0, z: 1 },
			{ x: 0, z: -1 },
		]
			.map((d) => ({ x: foot.x + d.x, y: foot.y, z: foot.z + d.z }))
			.find((cand) => {
				const here = driver.world.blockAt(cand);
				const under = driver.world.blockAt({ ...cand, y: cand.y - 1 });
				return here?.name === "air" && !!under && under.name !== "air";
			});
		if (spot) {
			const ref = { ...spot, y: spot.y - 1 };
			try {
				await driver.equip("crafting_table", "hand");
				await driver.placeBlock(new AbortController().signal, ref, { x: 0, y: 1, z: 0 });
				await sleep(800);
				const placed = driver.world.blockAt(spot);
				tablePos = placed?.name === "crafting_table" ? spot : null;
				step("作業台を置ける", tablePos !== null, placed?.name ?? "不明");
			} catch (e) {
				step("作業台を置ける", false, String(e));
			}
		} else {
			step("作業台を置ける", false, "置ける場所が見つからない");
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

	// 6. ツルハシで石を掘り、かまどを作って精錬まで通す。
	//    ここが通れば「木しか無い」状態から鉄まで手が届く。
	if (count("wooden_pickaxe") > 0 || count("stone_pickaxe") > 0) {
		const stones = driver.world.findBlocksMatching(
			(n) => n === "stone" || n === "cobblestone" || n === "deepslate",
			8,
			10,
		);
		for (const b of stones) {
			if (count("cobblestone") >= 8) break;
			try {
				await driver.equipBestTool(b.position);
				await driver.dig(new AbortController().signal, b.position);
				await driver.pickupNearbyItems(new AbortController().signal);
			} catch {
				// 届かない石は飛ばす。
			}
		}
		step("丸石を8個そろえる", count("cobblestone") >= 8, `${count("cobblestone")}個`);
		show();
	}

	if (count("furnace") === 0 && count("cobblestone") >= 8 && tablePos) {
		try {
			await driver.craft("furnace", 1, tablePos);
			await sleep(800);
			step("かまどを作れる", count("furnace") > 0);
		} catch (e) {
			step("かまどを作れる", false, String(e));
		}
		show();
	}

	if (count("furnace") > 0) {
		const st2 = driver.getState();
		const ref = {
			x: Math.floor(st2.position.x) - 1,
			y: Math.floor(st2.position.y) - 1,
			z: Math.floor(st2.position.z),
		};
		let furnacePos: { x: number; y: number; z: number } | null = null;
		if (driver.world.blockAt(ref)?.solid) {
			try {
				await driver.equip("furnace", "hand");
				await driver.placeBlock(new AbortController().signal, ref, { x: 0, y: 1, z: 0 });
				await sleep(800);
				const placed = driver.world.blockAt({ ...ref, y: ref.y + 1 });
				furnacePos = placed?.name === "furnace" ? { ...ref, y: ref.y + 1 } : null;
				step("かまどを置ける", furnacePos !== null, placed?.name ?? "不明");
			} catch (e) {
				step("かまどを置ける", false, String(e));
			}
		}
		if (furnacePos) {
			const fuel = driver.inventory
				.items()
				.find((i) => i.name.endsWith("_planks") || i.name.endsWith("_log") || i.name === "coal");
			if (!fuel || count("cobblestone") === 0) {
				step(
					"精錬の材料がある",
					false,
					`燃料 ${fuel?.name ?? "なし"} / 丸石 ${count("cobblestone")}`,
				);
			} else {
				try {
					await driver.smelt(furnacePos, "cobblestone", 1, fuel.name, 1);
					step("かまどに投入できる", true, `${fuel.name} で丸石を焼く`);
				} catch (e) {
					step("かまどに投入できる", false, String(e));
				}
				show();
			}
		}
	}

	await driver.disconnect();
	console.log(failures === 0 ? "\n連鎖は最後まで通りました" : `\n${failures}件で止まりました`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("[chain] 失敗:", e);
	process.exit(1);
});
