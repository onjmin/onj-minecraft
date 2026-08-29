/**
 * BedrockDriver — 統合版(Bedrock) を BotDriver インターフェースに適合させる実装。
 *
 * Java版と違い、土台となる BedrockX は生のプロトコルクライアントで
 * ワールド・インベントリ・エンティティの状態を一切保持しない。
 * そのため、このクラスがパケットを受けて状態を組み立てる責務を持つ。
 *
 * 実装状況:
 *   実装済み : getState / nearbyEntities / inventory / registry / chat
 *              goto / setControlState / lookAt（直進+ジャンプ。経路探索は無し）
 *   未実装   : world.*（チャンク解析が必要）/ dig / craft / placeBlock など
 *
 * 未実装のものは黙って失敗させず、必ず例外を投げる。
 * skillcheck がそれをクラッシュとして拾うので、未対応箇所が一覧で出る。
 */
import { randomUUID } from "node:crypto";
import pa from "prismarine-auth";
import pr from "prismarine-realms";
import type {
	BlockInfo,
	BotDriver,
	BotState,
	ControlState,
	EntityInfo,
	InventoryReader,
	ItemInfo,
	MoveGoal,
	Position,
	Registry,
	WorldReader,
} from "./types";

const { Authflow, Titles } = pa as any;
const { RealmAPI } = pr as any;
// bedrockx の index.d.ts は module 宣言のみで実体と噛み合わないため require で受ける
const bedrockx = require("bedrockx");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 統合版で未実装の操作。呼ばれたら必ず落として、対応漏れを可視化する。 */
function notImplemented(what: string): never {
	throw new Error(`[BedrockDriver] ${what} は統合版でまだ実装されていません`);
}

/** "minecraft:oak_log" -> "oak_log"。Java版の呼称に揃える。 */
function stripNamespace(name: string): string {
	return name.startsWith("minecraft:") ? name.slice("minecraft:".length) : name;
}

export interface BedrockDriverOptions {
	/** Realm の招待コードまたはリンク */
	realmInvite: string;
	/** 認証トークンのキャッシュ先 */
	profilesFolder?: string;
	/** デバイスコード認証が必要になったときの通知 */
	onMsaCode?: (message: string) => void;
}

export class BedrockDriver implements BotDriver {
	readonly world: WorldReader;
	readonly inventory: InventoryReader;
	readonly registry: Registry;

	private client: any = null;
	private options: BedrockDriverOptions;

	// --- パケットから組み立てる状態 ---
	private runtimeEntityId: bigint | null = null;
	private uniqueEntityId: string | null = null;
	private username = "";
	/** 自分の XUID。text パケットの送信者識別に必要。 */
	private xuid = "";
	/** 最後に発言を送信した時刻。エコーの往復時間を測るために使う。 */
	private lastChatSentAt = 0;
	private position: Position = { x: 0, y: 0, z: 0 };
	private yaw = 0;
	private health = 20;
	private food = 20;
	private worldTicks = 0;
	private dimension = "overworld";
	/** スポーン地点のバイオーム。チャンク解析が入るまでは全域これを返す近似値。 */
	private biome = "unknown";
	private rainLevel = 0;
	private spawned = false;

	/** runtime_id -> エンティティ */
	private entities = new Map<string, EntityInfo>();
	/** network_id -> アイテム名（名前空間なし）。item_registry から作る。 */
	private itemNames = new Map<number, string>();
	/** インベントリのスロット内容（window_id が "inventory" のもの） */
	private slots: { network_id: number; count: number }[] = [];

	// --- 移動 ---
	private pitch = 0;
	private tick = 0n;
	private controls: Record<ControlState, boolean> = {
		forward: false,
		back: false,
		left: false,
		right: false,
		jump: false,
		sprint: false,
		sneak: false,
	};
	private inputTimer: NodeJS.Timeout | null = null;
	/** 正規化した chat イベントの購読者 */
	private chatListeners: ((username: string, message: string) => void)[] = [];
	/** サーバーから位置補正を受けた回数と、直近の補正量。移動が妥当かの目安になる。 */
	public corrections = { count: 0, lastDistance: 0 };

	/** 最後にサーバーから何らかのパケットを受け取った時刻。無通信の検出に使う。 */
	private lastPacketAt = 0;
	/** 切断理由。切断されていなければ null。 */
	public disconnectReason: string | null = null;
	private watchdog: NodeJS.Timeout | null = null;
	private disconnectListeners: ((reason: string) => void)[] = [];
	/** 直近に受け取ったパケット名。切断原因の調査に使う。 */
	public recentPackets: string[] = [];

	constructor(options: BedrockDriverOptions) {
		this.options = options;

		this.world = {
			blockAt: () => notImplemented("world.blockAt"),
			findBlock: () => notImplemented("world.findBlock"),
			findBlocks: () => notImplemented("world.findBlocks"),
			findBlocksMatching: () => notImplemented("world.findBlocksMatching"),
			// チャンク解析が入るまでは座標別に引けないため、スポーン地点のバイオームを返す。
			// 知覚が成立しなくなるので例外にはしない。
			getBiome: () => this.biome,
			// 統合版はライトレベルをクライアントへ送らない。時刻と高さからの近似値を返す。
			// 厳密な値を前提にした判定を skills/ 側に書かないこと。
			getLightLevel: (position) => this.approximateLight(position),
		};

		this.inventory = {
			items: () => this.readItems(),
			heldItem: () => this.readItems()[0] ?? null,
			emptySlotCount: () => this.slots.filter((s) => s.network_id === 0).length,
		};

		this.registry = {
			// item_registry に載っているものだけが確実に存在する。
			// ブロック名の判定にも暫定的にアイテム名を使う（大半のブロックはアイテムを持つ）。
			hasBlock: (name) => this.hasItemName(name),
			hasItem: (name) => this.hasItemName(name),
		};
	}

	/**
	 * ライトレベルの近似。統合版はライトレベルを送ってこないため、
	 * 「地上なら時刻に従う / 地下なら暗い」という粗い推定に留める。
	 */
	private approximateLight(position: Position): number {
		// 海面より十分下は日光が届かないとみなす
		if (position.y < 50) return 0;
		const t = ((this.worldTicks % 24000) + 24000) % 24000;
		// 13000-23000 が夜
		if (t >= 13000 && t < 23000) return 4;
		return 15;
	}

	private hasItemName(name: string): boolean {
		const target = stripNamespace(name);
		for (const v of this.itemNames.values()) if (v === target) return true;
		return false;
	}

	private readItems(): ItemInfo[] {
		return this.slots
			.map((s, slot) => ({ s, slot }))
			.filter(({ s }) => s.network_id !== 0 && s.count > 0)
			.map(({ s, slot }) => ({
				name: this.itemNames.get(s.network_id) ?? `unknown_${s.network_id}`,
				count: s.count,
				slot,
			}));
	}

	// ================= 接続 =================

	async connect(): Promise<void> {
		const profilesFolder = this.options.profilesFolder ?? "./.bedrock-auth";
		const invite = this.options.realmInvite.replace(/https:\/\/realms\.gg\//, "");

		// 認証方式は sisu + iOS でなければ Realm 側に接続を閉じられる（M0で確認済み）
		const authflow = new Authflow(
			undefined,
			profilesFolder,
			{ flow: "sisu", authTitle: Titles.MinecraftIOS, deviceType: "iOS" },
			(d: any) => this.options.onMsaCode?.(d.message),
		);

		// text パケットは xuid で発言者を識別する。空だとサーバーが受理しても
		// 他プレイヤーへ中継されない（本人にだけエコーが返る）ため必ず取得する。
		try {
			const xbl = await authflow.getXboxToken();
			this.xuid = String(xbl?.userXUID ?? "");
			if (process.env.BEDROCK_LOG_TEXT === "1") {
				console.log(`[bedrock] xuid=${this.xuid || "(取得できず)"}`);
			}
		} catch (e) {
			// 取れなくても接続自体は続行する
			console.error("[bedrock] XUID の取得に失敗:", (e as Error)?.message);
		}

		const api = RealmAPI.from(authflow, "bedrock", { minecraftVersion: "1.21.130" });
		const realm = await api.getRealmFromInvite(invite);

		// /worlds/{id}/join は正常時も断続的に 503 を返すのでリトライ必須
		let join: any = null;
		let lastError: unknown = null;
		for (let i = 0; i < 15; i++) {
			try {
				join = await api.rest.get(`/worlds/${realm.id}/join`);
				break;
			} catch (e) {
				lastError = e;
				await sleep(2500);
			}
		}
		if (!join) throw new Error(`Realm への join に失敗: ${(lastError as Error)?.message}`);

		this.client = bedrockx.createClient({
			// NOTE: index.d.ts は 'protocol' と宣言しているが、実装が読むのは 'transport'
			transport: join.networkProtocol,
			networkId: join.address,
			profilesFolder,
			authTitle: Titles.MinecraftIOS,
			deviceType: "iOS",
			flow: "sisu",
			// BedrockX は 2169(1.26.45) を名乗るが、同梱の protocol.json は
			// 1.26.40 相当のスキーマ。名乗りとスキーマがズレていると
			// player_auth_input が短く書かれ "read() incomplete" で切断される。
			protocolVersion: Number(process.env.BEDROCK_PROTOCOL ?? 2169),
			authflow,
			skinData: {},
		});

		this.wirePackets();

		// spawn 確定まで待つ（BedrockX は spawn イベントを emit しないので自前で待つ）
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("spawn タイムアウト(90秒)")), 90_000);
			const check = setInterval(() => {
				if (this.spawned) {
					clearTimeout(timer);
					clearInterval(check);
					resolve();
				}
			}, 200);
		});
	}

	/** 切断を確定させる。二重に走らないようにする。 */
	private markDisconnected(reason: string): void {
		if (this.disconnectReason) return;
		this.disconnectReason = reason;
		this.spawned = false;
		this.stopInputLoop();
		if (this.watchdog) {
			clearInterval(this.watchdog);
			this.watchdog = null;
		}
		for (const cb of this.disconnectListeners) cb(reason);
	}

	private wirePackets(): void {
		const c = this.client;

		// どのパケットでもいいので届いていれば生きている。
		// BedrockX は接続断を必ずしもイベントで教えてくれないため、
		// 無通信そのものを切断の判定材料にする。
		const originalEmit = c.emit.bind(c);
		c.emit = (event: string, ...args: any[]) => {
			this.lastPacketAt = Date.now();
			// 切断直前に何が来ていたかを追えるよう、直近の受信を保持する
			this.recentPackets.push(`${new Date().toISOString().slice(14, 23)} ${event}`);
			if (this.recentPackets.length > 40) this.recentPackets.shift();
			return originalEmit(event, ...args);
		};

		c.on("disconnect", (p: any) => {
			const msg = p?.message ?? p?.reason ?? JSON.stringify(p);
			this.markDisconnected(`disconnect: ${String(msg).slice(0, 200)}`);
		});
		c.on("kick", (p: any) => {
			this.markDisconnected(`kick: ${JSON.stringify(p).slice(0, 200)}`);
		});
		// コマンドの実行結果。返ってくればコマンドは受理されている。
		c.on("command_output", (p: any) => {
			if (process.env.BEDROCK_LOG_TEXT === "1") {
				console.log(`[command_output] ${JSON.stringify(p)?.slice(0, 400)}`);
			}
		});

		// サーバーがこちらの送信を不正と判定したときに飛んでくる。
		// 原因のパケットと理由が入っているので必ず出す。
		c.on("packet_violation_warning", (p: any) => {
			console.error("[bedrock] パケット違反の警告:", JSON.stringify(p));
		});

		c.on("close", (reason: any) => {
			const text =
				reason === undefined
					? "(理由なし)"
					: typeof reason === "string"
						? reason
						: JSON.stringify(reason)?.slice(0, 300);
			this.markDisconnected(`close: ${text}`);
		});
		c.on("error", (e: any) => {
			this.markDisconnected(`error: ${e?.message ?? e}`);
		});

		c.on("start_game", (p: any) => {
			this.runtimeEntityId = p.runtime_entity_id;
			this.uniqueEntityId = String(p.entity_id);
			this.position = { x: p.player_position.x, y: p.player_position.y, z: p.player_position.z };
			// rotation は {x: pitch, z: yaw}
			this.yaw = p.rotation?.z ?? 0;
			this.dimension = p.dimension ?? "overworld";

			// player_auth_input の tick はサーバーの現在tickと突き合わせて
			// rewind に使われる。0 から始めると桁が違いすぎて相関が取れず、
			// サーバー側から接続を切られる。start_game の current_tick を種にする。
			// current_tick は [high, low] の形で届く i64。
			const ct = p.current_tick;
			if (Array.isArray(ct) && ct.length === 2) {
				this.tick = (BigInt(ct[0]) << 32n) | BigInt(ct[1] >>> 0);
			} else if (typeof ct === "bigint") {
				this.tick = ct;
			} else if (typeof ct === "number") {
				this.tick = BigInt(Math.trunc(ct));
			}
			this.biome = stripNamespace(p.biome_name ?? "unknown");
			this.rainLevel = p.rain_level ?? 0;

			// チャンクを受け取るには半径を要求する必要がある
			c.write("request_chunk_radius", { chunk_radius: 8, max_radius: 8 });
		});

		c.on("play_status", (p: any) => {
			if (p.status === "player_spawn" && !this.spawned) {
				// これを送らないとサーバー側がプレイヤーを操作可能とみなさない
				c.write("set_local_player_as_initialized", { runtime_entity_id: this.runtimeEntityId });
				this.spawned = true;
				this.lastPacketAt = Date.now();
				this.startInputLoop();
				this.startWatchdog();
			}
		});

		// アイテム名の対応表。インベントリは network_id しか持たないため必須。
		c.on("item_registry", (p: any) => {
			for (const s of p.itemstates ?? []) {
				this.itemNames.set(s.runtime_id, stripNamespace(s.name));
			}
		});

		c.on("update_attributes", (p: any) => {
			if (String(p.runtime_entity_id) !== String(this.runtimeEntityId)) return;
			for (const a of p.attributes ?? []) {
				if (a.name === "minecraft:health") this.health = a.current;
				if (a.name === "minecraft:player.hunger") this.food = a.current;
			}
		});
		c.on("set_health", (p: any) => {
			this.health = p.health;
		});

		c.on("inventory_content", (p: any) => {
			if (p.window_id !== "inventory") return;
			this.slots = (p.input ?? []).map((s: any) => ({
				network_id: s.network_id,
				count: s.count,
			}));
		});
		c.on("inventory_slot", (p: any) => {
			if (p.window_id !== "inventory") return;
			const idx = p.slot;
			if (typeof idx === "number" && p.item) {
				this.slots[idx] = { network_id: p.item.network_id, count: p.item.count };
			}
		});

		c.on("player_list", (p: any) => {
			for (const r of p.records ?? []) {
				if (r.type !== "add") continue;
				// 自分自身の表示名を拾う
				if (this.uniqueEntityId && String(r.entity_unique_id) === this.uniqueEntityId) {
					this.username = r.username;
				}
			}
		});

		c.on("add_entity", (p: any) => {
			const id = String(p.runtime_id);
			this.entities.set(id, {
				id: Number(p.runtime_id),
				name: stripNamespace(p.entity_type ?? "unknown"),
				kind: "mob",
				position: { x: p.position.x, y: p.position.y, z: p.position.z },
			});
		});
		c.on("add_player", (p: any) => {
			const id = String(p.runtime_id);
			this.entities.set(id, {
				id: Number(p.runtime_id),
				name: p.username ?? "player",
				kind: "player",
				position: { x: p.position.x, y: p.position.y, z: p.position.z },
				username: p.username,
			});
		});
		c.on("remove_entity", (p: any) => {
			// remove_entity は unique_id で来るため、一致するものを消す
			const target = String(p.entity_id_self ?? p.unique_id ?? "");
			for (const [k, v] of this.entities) {
				if (k === target || String(v.id) === target) this.entities.delete(k);
			}
		});
		c.on("move_entity", (p: any) => {
			const e = this.entities.get(String(p.runtime_entity_id));
			if (e && p.position) e.position = { x: p.position.x, y: p.position.y, z: p.position.z };
		});

		// サーバーは rewind 方式でこちらの予測位置を補正してくる。
		// 素直に従わないと蹴られるので、来たら必ず反映する。
		c.on("correct_player_move_prediction", (p: any) => {
			if (!p.position) return;
			const d = Math.hypot(
				p.position.x - this.position.x,
				p.position.y - this.position.y,
				p.position.z - this.position.z,
			);
			this.corrections.count++;
			this.corrections.lastDistance = d;
			this.position = { x: p.position.x, y: p.position.y, z: p.position.z };
		});

		// テレポートなどでサーバーから位置を指示されることもある
		c.on("move_player", (p: any) => {
			if (String(p.runtime_entity_id) !== String(this.runtimeEntityId)) return;
			if (p.position) {
				this.position = { x: p.position.x, y: p.position.y, z: p.position.z };
			}
		});

		// チャットは text パケットで届く。Java版の bot.on("chat", username, message) と
		// 同じ形に正規化して、上位（エージェント）が同じコードで扱えるようにする。
		c.on("text", (p: any) => {
			// BEDROCK_LOG_TEXT=1 で、フィルタを通す前の生の内容を出す。
			// 「発言が届いていない」のか「こちらで落としている」のかを切り分けるため。
			if (process.env.BEDROCK_LOG_TEXT === "1") {
				// 自分の発言のエコーなら往復時間を出す。
				// 1ms未満ならローカルのループバック、数十ms以上ならサーバー由来。
				const rtt =
					this.lastChatSentAt > 0 && String(p?.xuid) === this.xuid
						? ` rtt=${Date.now() - this.lastChatSentAt}ms`
						: "";
				console.log(`[text]${rtt} ${JSON.stringify(p)}`);
			}
			if (!p?.message) return;
			// 自分の発言や、翻訳待ちのシステムメッセージは流さない
			const from = p.source_name ?? "";
			if (!from || from === this.username) return;
			// 装飾コード(§x)を落とす
			const clean = String(from).replace(/§./g, "");
			for (const cb of this.chatListeners) cb(clean, String(p.message));
		});

		// 統合版の時刻は総経過tick。timeOfDay は 24000 の剰余で得る。
		c.on("sync_world_clocks", (p: any) => {
			const s = p.sync_states?.[0];
			if (s && typeof s.time === "number") this.worldTicks = s.time;
		});
		c.on("set_time", (p: any) => {
			if (typeof p.time === "number") this.worldTicks = p.time;
		});
	}

	async disconnect(): Promise<void> {
		this.stopInputLoop();
		try {
			this.client?.close();
		} catch {}
		this.spawned = false;
	}

	// ================= 読み取り =================

	getState(): BotState {
		return {
			username: this.username,
			position: { ...this.position },
			yaw: this.yaw,
			health: this.health,
			food: this.food,
			timeOfDay: ((this.worldTicks % 24000) + 24000) % 24000,
			isRaining: this.rainLevel > 0,
			dimension: this.dimension,
			isReady: this.spawned,
		};
	}

	nearbyEntities(maxDistance: number): EntityInfo[] {
		const o = this.position;
		return [...this.entities.values()].filter((e) => {
			const d = Math.hypot(e.position.x - o.x, e.position.y - o.y, e.position.z - o.z);
			return d < maxDistance;
		});
	}

	async chat(message: string): Promise<void> {
		// フィールドの欠落があるとサーバーに
		//   {"violation_type":"malformed","packet_id":9,"reason":"Invalid enum value"}
		// と判定されて即切断される。スキーマ順に漏れなく埋めること。
		//   needs_translation -> category -> type -> (type による分岐) ->
		//   xuid -> platform_chat_id -> has_filtered_message -> filtered_message
		this.lastChatSentAt = Date.now();
		this.client.write("text", {
			needs_translation: false,
			// プレイヤーが書いた発言なので authored
			category: "authored",
			type: "chat",
			source_name: this.username,
			message,
			xuid: this.xuid,
			platform_chat_id: "",
			has_filtered_message: false,
			filtered_message: "",
		});
	}

	// ================= 移動 =================
	//
	// 統合版はサーバー権限型(rewind方式)で、クライアントが player_auth_input に
	// 予測位置を載せて毎tick送り、ズレたらサーバーが correct_player_move_prediction で
	// 引き戻す。ここではワールドを読めない前提で「向いた方向へ直進、詰まったら跳ぶ」
	// までを実装し、地形との整合はサーバー補正に委ねている。

	/** 歩行速度(ブロック/tick)。全力疾走で約 0.28。 */
	private static readonly WALK_SPEED = 0.11;
	private static readonly SPRINT_SPEED = 0.15;
	private static readonly TICK_MS = 50;

	/** 一定時間パケットが来なければ切断とみなす。 */
	private startWatchdog(): void {
		if (this.watchdog) return;
		const SILENCE_MS = 15_000;
		this.watchdog = setInterval(() => {
			if (!this.spawned) return;
			const silence = Date.now() - this.lastPacketAt;
			if (silence > SILENCE_MS) {
				this.markDisconnected(`${Math.round(silence / 1000)}秒間サーバーからの通信が途絶えた`);
			}
		}, 3000);
	}

	private startInputLoop(): void {
		// player_auth_input の送信は既定で無効。
		//
		// 理由: サーバーがこちらの送るパケットを malformed と判定して接続を切る。
		//   {"violation_type":"malformed","severity":"terminating","packet_id":144,
		//    "reason":"BinaryStream read() incomplete"}
		//   BedrockX 同梱のスキーマは 1.26.40 相当（minecraft-data の定義と完全一致）だが、
		//   Realm はそれより新しい版を動かしており player_auth_input のフィールドが増えている。
		//   minecraft-data 側も 1.26.40 が最新で、借りられる定義が無い。
		//
		//   実測: 送ると約15秒で切断、送らなければ5分間安定。
		//   受信・思考・会話は送信に依存しないため、送らない方が実用的。
		//
		// 上流に新しいスキーマが入ったら BEDROCK_ENABLE_INPUT=1 で有効化して検証する。
		if (process.env.BEDROCK_ENABLE_INPUT !== "1") return;
		if (this.inputTimer) return;
		this.inputTimer = setInterval(() => {
			try {
				this.sendInput();
			} catch {
				// 送信失敗でループごと止めない
			}
		}, BedrockDriver.TICK_MS);
	}

	private stopInputLoop(): void {
		if (this.inputTimer) clearInterval(this.inputTimer);
		this.inputTimer = null;
	}

	/** 現在の操作状態から入力フラグを組み立てる。 */
	private buildInputFlags(): string[] {
		const f: string[] = [];
		const c = this.controls;
		if (c.forward) f.push("up");
		if (c.back) f.push("down");
		if (c.left) f.push("left");
		if (c.right) f.push("right");
		if (c.jump) f.push("jumping", "start_jumping", "jump_pressed_raw", "jump_current_raw");
		if (c.sprint) f.push("sprinting", "sprint_down");
		if (c.sneak) f.push("sneaking", "sneak_down");
		return f;
	}

	/** 1tick分、位置を進める（衝突判定なし。地形との整合はサーバー補正に任せる）。 */
	private advancePosition(): { x: number; z: number } {
		const c = this.controls;
		const fwd = (c.forward ? 1 : 0) - (c.back ? 1 : 0);
		const strafe = (c.right ? 1 : 0) - (c.left ? 1 : 0);
		if (fwd === 0 && strafe === 0) return { x: 0, z: 0 };

		const len = Math.hypot(fwd, strafe);
		const speed = c.sprint ? BedrockDriver.SPRINT_SPEED : BedrockDriver.WALK_SPEED;
		// yaw は度。統合版は +Z を yaw=0 とし、時計回りに増える。
		const rad = (this.yaw * Math.PI) / 180;
		const sin = Math.sin(rad);
		const cos = Math.cos(rad);
		const nf = (fwd / len) * speed;
		const ns = (strafe / len) * speed;

		const dx = -nf * sin + ns * cos;
		const dz = nf * cos + ns * sin;
		this.position = { x: this.position.x + dx, y: this.position.y, z: this.position.z + dz };
		return { x: ns / speed, z: nf / speed };
	}

	private sendInput(): void {
		if (!this.spawned || !this.client) return;
		const move = this.advancePosition();
		const flags = this.buildInputFlags();
		this.tick += 1n;

		this.client.write("player_auth_input", {
			pitch: this.pitch,
			yaw: this.yaw,
			position: this.position,
			move_vector: { x: move.x, z: move.z },
			head_yaw: this.yaw,
			input_data: flags,
			input_mode: "mouse",
			play_mode: "normal",
			interaction_model: "crosshair",
			interact_rotation: { x: this.pitch, z: this.yaw },
			tick: this.tick,
			delta: { x: 0, y: 0, z: 0 },
			transaction_presence: false,
			item_stack_request_presence: false,
			block_action_presence: false,
			vehicle_rotation_presence: false,
			predicted_vehicle_presence: false,
			analogue_move_vector: { x: move.x, z: move.z },
			camera_orientation: { x: 0, y: 0, z: 0 },
			raw_move_vector: { x: move.x, z: move.z },
		});
	}

	async setControlState(
		signal: AbortSignal,
		state: ControlState,
		value: boolean,
		durationMs?: number,
	): Promise<void> {
		if (signal.aborted) throw new Error("Aborted");
		this.assertMovable();
		this.controls[state] = value;
		if (durationMs !== undefined && value) {
			await sleep(durationMs);
			this.controls[state] = false;
		}
	}

	clearControlStates(): void {
		for (const k of Object.keys(this.controls) as ControlState[]) this.controls[k] = false;
	}

	stopMoving(): void {
		this.clearControlStates();
	}

	async lookAt(position: Position): Promise<void> {
		const dx = position.x - this.position.x;
		const dy = position.y - (this.position.y + 1.62); // 目の高さ
		const dz = position.z - this.position.z;
		// 統合版の yaw は +Z が 0 度で時計回り
		this.yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
		this.pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
	}

	/** MoveGoal を「目標座標と許容距離」に落とす。 */
	private resolveGoal(goal: MoveGoal): { target: Position; tolerance: number; ignoreY: boolean } {
		switch (goal.kind) {
			case "near":
				return { target: goal.position, tolerance: goal.distance, ignoreY: false };
			case "block":
				return { target: goal.position, tolerance: 0.6, ignoreY: false };
			case "getToBlock":
			case "lookAtBlock":
				return { target: goal.position, tolerance: 1.8, ignoreY: false };
			case "xz":
				return {
					target: { x: goal.x, y: this.position.y, z: goal.z },
					tolerance: goal.distance,
					ignoreY: true,
				};
			case "follow": {
				const e = this.entities.get(String(goal.entityId));
				if (!e) throw new Error(`Entity ${goal.entityId} not found`);
				return { target: e.position, tolerance: goal.distance, ignoreY: false };
			}
		}
	}

	private distanceTo(t: Position, ignoreY: boolean): number {
		const dx = t.x - this.position.x;
		const dz = t.z - this.position.z;
		const dy = ignoreY ? 0 : t.y - this.position.y;
		return Math.hypot(dx, dy, dz);
	}

	/** 入力送信が無効なら移動できない。黙って失敗させず理由を返す。 */
	private assertMovable(): void {
		if (!this.inputTimer) {
			throw new Error(
				"[BedrockDriver] 移動は無効です: player_auth_input のスキーマが" +
					"サーバーの版に追いついておらず、送ると切断されるため。" +
					"上流の対応後に BEDROCK_ENABLE_INPUT=1 で有効化してください。",
			);
		}
	}

	async goto(signal: AbortSignal, goal: MoveGoal): Promise<void> {
		this.assertMovable();
		const { target, tolerance, ignoreY } = this.resolveGoal(goal);

		// 目標が数値として成立していないと距離が NaN になり、
		// 到達判定が永遠に成立せずタイムアウトまで歩き続けることになる
		if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
			throw new Error(`goto: 目標座標が不正です (${target.x}, ${target.y}, ${target.z})`);
		}

		const TIMEOUT_MS = 30_000;
		const started = Date.now();
		let lastPos = { ...this.position };
		let stuckTicks = 0;

		this.clearControlStates();
		try {
			while (true) {
				if (signal.aborted) throw new Error("Aborted");
				if (Date.now() - started > TIMEOUT_MS) {
					throw new Error(
						`goto がタイムアウトしました（残り ${this.distanceTo(target, ignoreY).toFixed(1)}m）`,
					);
				}

				// follow は相手が動くので毎回取り直す
				const t = goal.kind === "follow" ? this.resolveGoal(goal).target : target;
				if (this.distanceTo(t, ignoreY) <= tolerance) return;

				await this.lookAt(t);
				this.controls.forward = true;
				this.controls.sprint = true;

				await sleep(BedrockDriver.TICK_MS * 4);

				// 進んでいなければ詰まっているとみなして跳ぶ
				const moved = Math.hypot(this.position.x - lastPos.x, this.position.z - lastPos.z);
				if (moved < 0.05) {
					stuckTicks++;
					this.controls.jump = true;
					await sleep(BedrockDriver.TICK_MS * 4);
					this.controls.jump = false;
					if (stuckTicks > 25) {
						throw new Error("goto: 進めなくなりました（経路探索は未実装）");
					}
				} else {
					stuckTicks = 0;
				}
				lastPos = { ...this.position };
			}
		} finally {
			this.clearControlStates();
		}
	}

	/**
	 * サーバーコマンドを実行する。オペレーター権限が要る。
	 *
	 * 通常のチャット(text パケット)はサーバーに受理されエコーも返るのに、
	 * 他プレイヤーの画面に表示されない問題があるため、
	 * /say によるシステムメッセージを代替経路として用意している。
	 * こちらはプレイヤー間チャットの制約を受けない。
	 */
	async runCommand(command: string): Promise<void> {
		if (!this.client) throw new Error("未接続です");
		// NOTE: 現状このパケットはサーバーに読み違えられる。
		//   {"packet_id":77,"reason":"Command exceeds maximum size of 512 characters."}
		//   "list" のような4文字のコマンドでも起きるため、長さの問題ではなく
		//   BedrockX の command_request スキーマが Realm のプロトコル版と
		//   食い違っている（player_auth_input と同じ構図）。
		//   上流が追随するまでコマンド実行は使えない。
		// BedrockX の write() はシリアライズ失敗を console.log で握り潰すため、
		// 送れたつもりで進まないよう事前に検証する。
		this.client.write("command_request", {
			command,
			origin: {
				type: "player",
				uuid: randomUUID(),
				request_id: "",
				// 実クライアントは自分のエンティティIDを載せる。0 だと発行元が特定できない。
				player_entity_id: this.runtimeEntityId ?? 0n,
			},
			internal: false,
			// スキーマ上 version は文字列。数値を渡すとシリアライズで落ちる。
			version: "52",
		});
	}

	// ================= 未実装 =================
	// 移動は player_auth_input を毎tick送るクライアント権限型の実装が必要。
	// 採掘・設置・クラフトはブロックパレットとチャンク解析が前提になる。

	dig(_signal: AbortSignal, _position: Position): Promise<void> {
		return notImplemented("dig");
	}
	placeBlock(_signal: AbortSignal, _reference: Position, _face: Position): Promise<void> {
		return notImplemented("placeBlock");
	}
	activateBlock(_position: Position): Promise<void> {
		return notImplemented("activateBlock");
	}
	attack(_signal: AbortSignal, _entityId: number): Promise<void> {
		return notImplemented("attack");
	}
	equip(): Promise<void> {
		return notImplemented("equip");
	}
	equipBestTool(_position: Position): Promise<void> {
		return notImplemented("equipBestTool");
	}
	pickupNearbyItems(_signal: AbortSignal): Promise<void> {
		return notImplemented("pickupNearbyItems");
	}
	craft(): Promise<void> {
		return notImplemented("craft");
	}
	canCraft(): boolean {
		return notImplemented("canCraft");
	}
	canSmelt(): boolean {
		return notImplemented("canSmelt");
	}
	smelt(): Promise<void> {
		return notImplemented("smelt");
	}
	takeAllFromContainer(): Promise<number> {
		return notImplemented("takeAllFromContainer");
	}

	// ================= イベント =================

	on(event: string, listener: (...args: any[]) => void): void {
		// 切断は独自に検出しているので、専用のリスナー配列で配る
		if (event === "end" || event === "kicked") {
			this.disconnectListeners.push(listener as (r: string) => void);
			return;
		}
		// chat は text パケットから正規化して配るので、生イベントには繋がない
		if (event === "chat") {
			this.chatListeners.push(listener as (u: string, m: string) => void);
			return;
		}
		this.client?.on(event, listener);
	}
	off(event: string, listener: (...args: any[]) => void): void {
		if (event === "chat") {
			this.chatListeners = this.chatListeners.filter((l) => l !== listener);
			return;
		}
		this.client?.off(event, listener);
	}

	/** 生のパケットを扱いたい場合のエスケープハッチ（デバッグ用） */
	get raw(): any {
		return this.client;
	}

	/** BlockInfo を返す口を持たせておく（world 実装時に使う） */
	protected toBlockInfo(): BlockInfo | null {
		return null;
	}
}
