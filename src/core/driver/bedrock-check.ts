/**
 * BedrockDriver を実 Realm に繋いで検証する。
 *
 * 実行(本番 Realms):
 *   REALM_INVITE=https://realms.gg/xxxx npx tsx src/core/driver/bedrock-check.ts
 * 実行(ローカル開発サーバー):
 *   docker compose -f docker-compose.bedrock-dev.yml up -d
 *   BEDROCK_ADDRESS=127.0.0.1:19132 npx tsx src/core/driver/bedrock-check.ts
 *
 * LLM を介さず直接ドライバを叩く。思考ループ越しに待つと時間がかかるうえ、
 * 失敗が「LLM が選ばなかった」のか「実装が壊れている」のか切り分けられない。
 *
 * 意図的にチャットは送らない。Realm の他プレイヤーに見えてしまうため、
 * 送信を試すときは SEND_CHAT に文言を入れて明示的に指定する。
 */
import { BedrockDriver } from "./bedrock";

const INVITE = process.env.REALM_INVITE ?? "";
/** 開発用。指定するとローカルサーバーへ直に繋ぐ。 */
const ADDRESS = process.env.BEDROCK_ADDRESS ?? "";
// Windows から WSL の Docker へは UDP が転送されないため、既定で WSL 経由にする。
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
const SEND_CHAT = process.env.SEND_CHAT ?? "";
/** 移動検証で進みたい距離（ブロック）。0 なら移動を試さない。 */
const WALK = Number(process.env.WALK_DISTANCE ?? 6);

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "  OK  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
	Math.hypot(a.x - b.x, a.z - b.z);

async function main() {
	if (!INVITE && !ADDRESS) {
		throw new Error("REALM_INVITE か BEDROCK_ADDRESS を指定してください");
	}

	const driver = new BedrockDriver({
		realmInvite: INVITE || undefined,
		address: ADDRESS || undefined,
		name: ADDRESS ? "kusabot" : undefined,
		viaWsl: ADDRESS ? VIA_WSL : false,
		onMsaCode: (m) => console.log("要サインイン:", m),
	});

	driver.on("end", (reason: string) => {
		console.log(`[bedrock-check] 切断: ${reason}`);
	});

	console.log("[bedrock-check] 接続中...");
	const startedAt = Date.now();
	await driver.connect();
	console.log(`[bedrock-check] スポーン完了 (${Math.round((Date.now() - startedAt) / 1000)}秒)`);

	const st = driver.getState();
	check("スポーンしている", st.isReady);
	check("名前が取れる", st.username.length > 0, st.username);
	check(
		"座標が取れる",
		Number.isFinite(st.position.x) && Number.isFinite(st.position.z),
		`${st.position.x.toFixed(1)}, ${st.position.y.toFixed(1)}, ${st.position.z.toFixed(1)}`,
	);
	check("体力が取れる", st.health > 0, `HP ${st.health} / 満腹度 ${st.food}`);

	const items = driver.inventory.items();
	console.log(
		`  持ち物 ${items.length} 種: ${items.map((i) => `${i.name}x${i.count}`).join(", ") || "なし"}`,
	);

	const ents = driver.nearbyEntities(64);
	console.log(
		`  周囲 ${ents.length} 体: ${
			ents
				.slice(0, 8)
				.map((e) => e.name)
				.join(", ") || "なし"
		}`,
	);

	// 視点は世界の状態に依存しないので必ず通るはず。
	try {
		await driver.lookAt({ x: st.position.x, y: st.position.y, z: st.position.z + 10 });
		check("視点を向けられる", true);
	} catch (e) {
		check("視点を向けられる", false, String(e));
	}

	if (WALK > 0) {
		// 塞がれている方向を引くと失敗するので、四方向を順に試す。
		const dirs: [string, number, number][] = [
			["南(+Z)", 0, WALK],
			["北(-Z)", 0, -WALK],
			["東(+X)", WALK, 0],
			["西(-X)", -WALK, 0],
		];
		let moved = false;
		for (const [name, dx, dz] of dirs) {
			const from = driver.getState().position;
			const goal = { x: from.x + dx, z: from.z + dz };
			try {
				await driver.goto(new AbortController().signal, {
					kind: "xz",
					x: goal.x,
					z: goal.z,
					distance: 1.5,
				});
				moved = true;
				check(`移動できる (${name})`, true);
				break;
			} catch (e) {
				const to = driver.getState().position;
				const progress = dist(from, to);
				console.log(`  ${name} は届かず（${progress.toFixed(1)}ブロック進んだ）: ${e}`);
				// 少しでも進んでいれば入力自体は通っている。
				if (progress > 1) {
					moved = true;
					check(`移動できる (${name}・目標には未到達)`, true);
					break;
				}
			}
		}
		check("いずれかの方向へ移動できる", moved);
	}

	if (SEND_CHAT) {
		try {
			await driver.chat(SEND_CHAT);
			check("発言を送れる", true, "※他プレイヤーに表示されるかは別問題");
		} catch (e) {
			check("発言を送れる", false, String(e));
		}
	}

	// ワールド読み取り。足元は必ず何かあるはず。
	const foot = driver.getState().position;
	const below = driver.world.blockAt({ x: foot.x, y: foot.y - 1, z: foot.z });
	check(
		"足元のブロックが読める",
		below !== null,
		below ? `${below.name} (solid=${below.solid})` : "",
	);

	const above = driver.world.blockAt({ x: foot.x, y: foot.y + 3, z: foot.z });
	check("頭上のブロックが読める", above !== null, above ? above.name : "");

	// 未取得の領域を「空気」と答えないこと。空気と答えると skills/ が
	// そこに何も無いと解釈して空中に足場を作ろうとする。
	const faraway = driver.world.blockAt({ x: foot.x + 5000, y: foot.y, z: foot.z });
	check("未取得の領域は null を返す", faraway === null);

	const solids = driver.world.findBlocksMatching((n) => n !== "air", 8, 5);
	check("ブロックを探索できる", solids.length > 0, solids.map((b) => b.name).join(", "));

	// 採掘。足元の地面を掘って空気になるかを見る。
	// DIG=0 を渡せば飛ばせる（世界を壊したくないとき用）。
	if (process.env.DIG !== "0") {
		const target = driver.world.findBlocksMatching(
			(n) => n === "grass_block" || n === "dirt" || n === "stone",
			6,
			1,
		)[0];
		if (!target) {
			check("掘る対象が見つかる", false);
		} else {
			try {
				await driver.dig(new AbortController().signal, target.position);
				const after = driver.world.blockAt(target.position);
				check(
					`${target.name} を掘れる`,
					after?.name === "air",
					`掘ったあと: ${after?.name ?? "不明"}`,
				);
			} catch (e) {
				check(`${target.name} を掘れる`, false, String(e));
			}
		}
	}

	// レシピ表が読めているか。canCraft は接続時に取った一覧で答える。
	check(
		"レシピ表が読めている",
		driver.canCraft("stick") && driver.canCraft("crafting_table"),
		"棒と作業台のレシピを引ける",
	);
	check("知らない物は作れないと答える", !driver.canCraft("not_a_real_item"));

	await driver.disconnect();
	console.log(failures === 0 ? "\nすべて通りました" : `\n${failures}件失敗しました`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("[bedrock-check] 失敗:", e);
	process.exit(1);
});
