/**
 * 動物を実際に倒せるかを、ローカルの開発サーバーで確かめる。
 *
 * なぜ要るか。5日ぶんのログ全体で、持ち物に肉・革・羊毛・羽が**一度も**
 * 入っていない(mob 由来は腐肉3回だけ)。狩りスキルは「殴った」ことしか
 * 見ていなかったので、倒せていないのか拾えていないのかも分からないまま
 * 5日が過ぎた。食料 → 自然回復 → 夜を越す、という鎖の1本目がここで
 * 切れている以上、まずここを白黒つける必要がある。
 *
 * LLM を介さず直接ドライバを叩く。思考ループ越しに待つと、失敗が
 * 「LLM が選ばなかった」のか「実装が壊れている」のか切り分けられない。
 *
 * 実行(ローカル専用):
 *   docker compose -f docker-compose.bedrock-dev.yml up -d
 *   npx tsx src/core/driver/bedrock-hunt-check.ts
 *   # 別の端末から、下に出る POS の座標へ牛を湧かせる:
 *   #   docker exec onj-bedrock-dev send-command "summon cow <x> <y> <z>"
 *
 * 本番 Realm には繋がない(接続先はローカル固定)。
 */
import { BedrockDriver } from "./bedrock";

const ADDRESS = process.env.BEDROCK_ADDRESS ?? "127.0.0.1:19132";
const VIA_WSL = (process.env.BEDROCK_WSL ?? (process.platform === "win32" ? "1" : "0")) === "1";
/** 獲物が湧くのを待つ時間。外から summon する猶予。 */
const WAIT_PREY_MS = Number(process.env.WAIT_PREY_MS ?? 45_000);
/** 1匹に粘る時間。 */
const ATTACK_MS = Number(process.env.ATTACK_MS ?? 30_000);

const PREY = ["cow", "pig", "sheep", "chicken", "rabbit"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	if (!ADDRESS.startsWith("127.0.0.1") && !ADDRESS.startsWith("localhost")) {
		throw new Error(`hunt-check はローカル専用です (BEDROCK_ADDRESS=${ADDRESS})`);
	}
	const driver = new BedrockDriver({ address: ADDRESS, name: "huntcheck", viaWsl: VIA_WSL });
	console.log(`[hunt-check] ${ADDRESS} へ接続します`);
	await driver.connect();
	await sleep(3000);

	const pos = driver.getState().position;
	// 足元の座標を出す。統合版の position は目線の高さなので、そのまま
	// summon に渡すと1〜2ブロック浮いた場所に湧く。
	console.log(`POS ${Math.round(pos.x)} ${Math.round(pos.y - 1.62)} ${Math.round(pos.z)}`);

	const findPrey = () => {
		const here = driver.getState().position;
		return driver
			.nearbyEntities(24)
			.filter((e) => PREY.includes(e.name))
			.sort(
				(a, b) =>
					Math.hypot(a.position.x - here.x, a.position.z - here.z) -
					Math.hypot(b.position.x - here.x, b.position.z - here.z),
			)[0];
	};

	const until = Date.now() + WAIT_PREY_MS;
	let target = findPrey();
	while (!target && Date.now() < until) {
		await sleep(2000);
		target = findPrey();
	}
	if (!target) {
		console.log("  獲物が現れませんでした（summon してください）");
		await driver.disconnect();
		process.exit(2);
	}

	const before = new Map<string, number>();
	for (const i of driver.inventory.items()) {
		before.set(i.name, (before.get(i.name) ?? 0) + i.count);
	}

	console.log(`  対象: ${target.name} (id=${target.id})`);
	const signal = new AbortController().signal;
	let hits = 0;
	let errors = 0;
	let lastError = "";
	let killed = false;
	const stop = Date.now() + ATTACK_MS;
	while (Date.now() < stop) {
		const current = driver.nearbyEntities(24).find((e) => e.id === target.id);
		if (!current) {
			killed = true;
			break;
		}
		try {
			await driver.goto(signal, { kind: "follow", entityId: target.id, distance: 1.5 });
			await driver.attack(signal, target.id);
			hits++;
		} catch (err) {
			errors++;
			lastError = err instanceof Error ? err.message : String(err);
		}
		await sleep(350);
	}

	await sleep(1500);
	try {
		await driver.pickupNearbyItems(signal);
	} catch {}
	await sleep(500);

	const gained: string[] = [];
	for (const i of driver.inventory.items()) {
		const diff = i.count - (before.get(i.name) ?? 0);
		if (diff > 0) gained.push(`${i.name} x${diff}`);
	}

	console.log("");
	console.log(`  攻撃を送った回数: ${hits}`);
	console.log(`  送れなかった回数: ${errors}${lastError ? ` (最後の理由: ${lastError})` : ""}`);
	console.log(`  倒せたか: ${killed ? "はい" : "いいえ（まだ生きている）"}`);
	console.log(`  得た物: ${gained.length > 0 ? gained.join(", ") : "なし"}`);
	console.log("");
	if (killed && gained.length > 0) console.log("狩りは通っている");
	else if (killed) console.log("倒せたが拾えていない（拾う処理の問題）");
	else console.log("倒せていない（攻撃が当たっていない）");

	await driver.disconnect();
	process.exit(killed && gained.length > 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("[hunt-check] 失敗:", err);
	process.exit(1);
});
