/**
 * 統合版(Bedrock)のパケット構造を採取する使い捨てプローブ。
 *
 * BedrockX は生のプロトコルクライアントで状態管理を持たないため、
 * BedrockDriver は各パケットから状態を自前で組み立てる必要がある。
 * 推測で実装しないよう、実際に流れてくるフィールドをここで確認する。
 *
 * 実行:
 *   REALM_INVITE=https://realms.gg/xxxx npx tsx src/core/driver/bedrock-probe.ts
 */
import pa from "prismarine-auth";
import pr from "prismarine-realms";

const { Authflow, Titles } = pa as any;
const { RealmAPI } = pr as any;
// bedrockx は型定義が 'bedrockx' モジュール宣言のみで実体と噛み合わないため any で受ける
const bedrock = require("bedrockx");

const INVITE = (process.env.REALM_INVITE ?? "").replace(/https:\/\/realms\.gg\//, "");
const DURATION_MS = Number(process.env.PROBE_DURATION_MS ?? 30_000);
const PROFILES = process.env.BEDROCK_PROFILES_FOLDER ?? "./.bedrock-auth";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 最初の1件だけ構造をダンプしたいパケット */
const DUMP_ONCE = new Set([
	"start_game",
	"update_attributes",
	"inventory_content",
	"inventory_slot",
	"add_player",
	"add_entity",
	"set_time",
	"set_health",
	"player_list",
	"move_player",
	"set_actor_data",
	"text",
	"item_registry",
	"sync_world_clocks",
	"player_auth_input",
]);

/** 値を読みやすい形に縮める（巨大な配列やバッファを潰す） */
function shrink(v: unknown, depth = 0): unknown {
	if (v === null || v === undefined) return v;
	if (Buffer.isBuffer(v)) return `<Buffer ${v.length}B>`;
	if (typeof v === "bigint") return `${v}n`;
	if (Array.isArray(v)) {
		if (v.length > 3)
			return [...v.slice(0, 3).map((x) => shrink(x, depth + 1)), `...(${v.length}件)`];
		return v.map((x) => shrink(x, depth + 1));
	}
	if (typeof v === "object") {
		if (depth > 3) return "{...}";
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as object)) out[k] = shrink(val, depth + 1);
		return out;
	}
	return v;
}

async function main() {
	if (!INVITE) throw new Error("REALM_INVITE を指定してください");

	const authflow = new Authflow(
		undefined,
		PROFILES,
		{ flow: "sisu", authTitle: Titles.MinecraftIOS, deviceType: "iOS" },
		(d: any) => console.log("要サインイン:", d.message),
	);
	const api = RealmAPI.from(authflow, "bedrock", { minecraftVersion: "1.21.130" });

	const realm = await api.getRealmFromInvite(INVITE);
	console.log(`[probe] realm=${realm.name} id=${realm.id} state=${realm.state}`);

	// /join は正常時も断続的に 503 を返すので粘る
	let join: any = null;
	for (let i = 1; i <= 15; i++) {
		try {
			join = await api.rest.get(`/worlds/${realm.id}/join`);
			break;
		} catch (e) {
			console.log(`[probe] /join 試行 ${i}/15: ${(e as Error).message}`);
			await sleep(2500);
		}
	}
	if (!join) throw new Error("/join を取得できなかった");
	console.log("[probe] join:", JSON.stringify(join));

	const client = bedrock.createClient({
		// NOTE: index.d.ts は 'protocol' と宣言しているが、実装が読むのは 'transport'。
		//       型定義が実装とズレているので実装側に合わせる。
		transport: join.networkProtocol,
		networkId: join.address,
		profilesFolder: PROFILES,
		authTitle: Titles.MinecraftIOS,
		deviceType: "iOS",
		flow: "sisu",
		protocolVersion: 2169,
		authflow,
		skinData: {},
	});

	const seen = new Map<string, number>();
	const dumped = new Set<string>();

	// 個別に on() を張ると取りこぼしに気づけないため、emit を包んで全イベントを数える
	const originalEmit = client.emit.bind(client);
	client.emit = (event: string, ...args: any[]) => {
		seen.set(event, (seen.get(event) ?? 0) + 1);
		if (DUMP_ONCE.has(event) && !dumped.has(event)) {
			dumped.add(event);
			console.log(`
--- ${event} ---`);
			console.log(JSON.stringify(shrink(args[0]), null, 1)?.slice(0, 1500));
		}
		return originalEmit(event, ...args);
	};

	const onAny = (name: string, params: any) => {
		seen.set(name, (seen.get(name) ?? 0) + 1);
		if (DUMP_ONCE.has(name) && !dumped.has(name)) {
			dumped.add(name);
			console.log(`\n--- ${name} ---`);
			console.log(JSON.stringify(shrink(params), null, 1)?.slice(0, 1800));
		}
	};

	// spawn 確定に必要なハンドシェイクは自前で行う（BedrockX は spawn を emit しない）
	let runtimeEntityId: any = null;
	client.on("start_game", (p: any) => {
		runtimeEntityId = p.runtime_entity_id;
		client.write("request_chunk_radius", { chunk_radius: 8, max_radius: 8 });
	});
	client.on("play_status", (p: any) => {
		if (p.status === "player_spawn") {
			client.write("set_local_player_as_initialized", { runtime_entity_id: runtimeEntityId });
			console.log("[probe] スポーン確定");
		}
	});
	// 全体の出現頻度も取りたいので代表的なものを追加で拾う
	for (const name of [
		"level_chunk",
		"play_status",
		"respawn",
		"mob_equipment",
		"set_entity_motion",
		"remove_entity",
		"crafting_data",
		"available_commands",
	]) {
		client.on(name, (p: any) => onAny(name, p));
	}

	client.on("disconnect", (p: any) =>
		console.log("[probe] disconnect", JSON.stringify(p)?.slice(0, 200)),
	);
	client.on("error", (e: any) => console.log("[probe] error", e?.message ?? e));

	await sleep(DURATION_MS);

	console.log("\n=========== 受信パケット頻度 ===========");
	for (const [k, v] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${String(v).padStart(5)}  ${k}`);
	}

	try {
		client.close();
	} catch {}
	process.exit(0);
}

main().catch((e) => {
	console.error("[probe] 失敗:", e);
	process.exit(1);
});
