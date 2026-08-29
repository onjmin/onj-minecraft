/**
 * BedrockDriver を実 Realm に繋いで検証する。
 *
 * 実行:
 *   REALM_INVITE=https://realms.gg/xxxx npx tsx src/core/driver/bedrock-check.ts
 *
 * 意図的にチャットは送らない。Realm の他プレイヤーに見えてしまうため、
 * 送信を試すときは SEND_CHAT に文言を入れて明示的に指定する。
 */
import { BedrockDriver } from "./bedrock";

const INVITE = process.env.REALM_INVITE ?? "";
const SEND_CHAT = process.env.SEND_CHAT ?? "";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "  OK  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};

async function main() {
	if (!INVITE) throw new Error("REALM_INVITE を指定してください");

	const driver = new BedrockDriver({
		realmInvite: INVITE,
		onMsaCode: (m) => console.log("要サインイン:", m),
	});

	console.log("[bedrock-check] 接続中...");
	await driver.connect();
	console.log("[bedrock-check] スポーン確定\n");

	// パケットが行き渡るまで少し待つ
	await new Promise((r) => setTimeout(r, 8000));

	console.log("--- getState ---");
	const s = driver.getState();
	console.log(JSON.stringify(s, null, 1));
	check("isReady", s.isReady);
	check(
		"position が原点でない",
		s.position.x !== 0 || s.position.z !== 0,
		JSON.stringify(s.position),
	);
	check("health が 0-20", s.health > 0 && s.health <= 20, String(s.health));
	check("dimension を取得", Boolean(s.dimension), s.dimension);
	check("timeOfDay が 0-24000", s.timeOfDay >= 0 && s.timeOfDay < 24000, String(s.timeOfDay));
	check("username を取得", s.username.length > 0, s.username);

	console.log("\n--- registry（item_registry 由来） ---");
	check("registry.hasItem('oak_log')", driver.registry.hasItem("oak_log"));
	check("registry.hasItem('diamond_pickaxe')", driver.registry.hasItem("diamond_pickaxe"));
	check("registry.hasItem('存在しない物')", !driver.registry.hasItem("definitely_not_an_item"));

	console.log("\n--- inventory ---");
	const items = driver.inventory.items();
	console.log(`  items: ${items.length}件`, JSON.stringify(items.slice(0, 8)));
	console.log(`  emptySlotCount: ${driver.inventory.emptySlotCount()}`);
	check("インベントリのスロットを読めている", driver.inventory.emptySlotCount() > 0);
	check(
		"アイテム名が network_id のままになっていない",
		items.every((i) => !i.name.startsWith("unknown_")),
		items
			.filter((i) => i.name.startsWith("unknown_"))
			.map((i) => i.name)
			.join(",") || "全て解決済み",
	);

	console.log("\n--- nearbyEntities ---");
	const ents = driver.nearbyEntities(64);
	console.log(`  ${ents.length}件`, JSON.stringify(ents.slice(0, 5)));

	console.log("--- 移動 ---");
	const before = { ...driver.getState().position };
	// 現在地から水平に8ブロック先を目標にする（Yは据え置き）
	const target = { x: before.x + 8, y: before.y, z: before.z };
	console.log(`  出発 (${before.x.toFixed(1)}, ${before.y.toFixed(1)}, ${before.z.toFixed(1)})`);
	let moveError = "";
	try {
		await driver.goto(new AbortController().signal, {
			kind: "xz",
			x: target.x,
			z: target.z,
			distance: 1.5,
		});
	} catch (e) {
		moveError = e instanceof Error ? e.message : String(e);
	}
	const after = driver.getState().position;
	const travelled = Math.hypot(after.x - before.x, after.z - before.z);
	console.log(`  到達 (${after.x.toFixed(1)}, ${after.y.toFixed(1)}, ${after.z.toFixed(1)})`);
	console.log(`  移動距離: ${travelled.toFixed(2)}m`);
	console.log(
		`  サーバー補正: ${driver.corrections.count}回 (直近 ${driver.corrections.lastDistance.toFixed(2)}m)`,
	);
	if (moveError) console.log(`  goto の結果: ${moveError}`);
	check("実際に移動した(1m以上)", travelled > 1, `${travelled.toFixed(2)}m`);
	check("接続が維持されている", driver.getState().isReady);

	console.log("\n--- 未実装が明示的に落ちるか ---");
	for (const [label, fn] of [
		["world.blockAt", () => driver.world.blockAt({ x: 0, y: 0, z: 0 })],
		["dig", () => driver.dig(new AbortController().signal, s.position)],
	] as [string, () => unknown][]) {
		try {
			const r = fn();
			if (r instanceof Promise) await r;
			check(`${label} が未実装エラーを投げる`, false, "例外が出なかった");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			check(
				`${label} が未実装エラーを投げる`,
				msg.includes("まだ実装されていません"),
				msg.slice(0, 60),
			);
		}
	}

	if (SEND_CHAT) {
		console.log("\n--- chat 送信（明示指定時のみ） ---");
		await driver.chat(SEND_CHAT);
		check("chat を送信", true, SEND_CHAT);
		// 送信後のエコーが返るかを見る。返るなら「送信元への確認応答」であり、
		// 他プレイヤーへ配信された証拠にはならない（誰もいなくても返るため）。
		console.log("  エコーを20秒待機...");
		await new Promise((r) => setTimeout(r, 20000));
	} else {
		console.log("\n（chat は SEND_CHAT 未指定のため送信していない）");
	}

	console.log(`\n=== ${failures === 0 ? "すべて通過 ✅" : `${failures}件の失敗 ❌`} ===`);
	await driver.disconnect();
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("[bedrock-check] 失敗:", e);
	process.exit(2);
});
