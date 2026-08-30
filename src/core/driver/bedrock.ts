/**
 * 統合版(Bedrock)の BotDriver。
 *
 * 接続とプロトコルは Go サイドカー(sidecar/bedrock)が持つ。JS 側のライブラリは
 * player_auth_input の定義が実プロトコルと食い違っており送信が成立しないため、
 * そちらへ委譲している。Realm には同時に1接続しか張れないので、読み取りも含めて
 * 全てサイドカー越しになる。
 *
 * 現時点で通っているのは接続・状態・エンティティ・持ち物・移動・発言まで。
 * ワールド(ブロック)の読み取りはサイドカー側のチャンク解析が未実装で、
 * それに依存する採掘・設置・クラフトも同様に未実装。
 * 未実装のものは黙って何もせず成功を装うのではなく、必ず例外にする。
 */
import { BlockView } from "./blockview";
import { BedrockSidecar } from "./sidecar";
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

export interface BedrockDriverOptions {
	/** Realm の招待コードまたはリンク */
	realmInvite?: string;
	/**
	 * 開発用。ローカルの統合版サーバーへ直に繋ぐ (例: 127.0.0.1:19132)。
	 * 指定すると Realms 経由ではなく RakNet で接続し、認証もしない。
	 */
	address?: string;
	/** 開発用の表示名。online-mode=false のサーバーで複数体を繋ぎ分けるのに使う。 */
	name?: string;
	/** 認証トークンのキャッシュ先 */
	tokenCache?: string;
	/** デバイスコード認証が必要になったときの通知 */
	onMsaCode?: (message: string) => void;
	/** サイドカー実行ファイルの場所を明示したい場合 */
	binaryPath?: string;
	/** WSL 経由で起動する。ローカル開発サーバーへ繋ぐときに必要。 */
	viaWsl?: boolean;
	/** WSL のディストリビューション名。 */
	wslDistro?: string;
}

function notImplemented(what: string): never {
	throw new Error(`統合版では${what}がまだ使えません`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 周辺ブロックを受け取る半径。33立方で約36000マス、base64 で約95KB。
 * サイドカーが要求しているサブチャンクは上下2区画(±32ブロック)なので、
 * これ以上広げても縦方向は埋まらない。
 */
const SNAPSHOT_RADIUS = 16;

/** "minecraft:stone" のような名前空間付きでも引けるようにする。 */
function stripNamespace(name: string): string {
	return name.startsWith("minecraft:") ? name.slice("minecraft:".length) : name;
}

export class BedrockDriver implements BotDriver {
	readonly world: WorldReader;
	readonly inventory: InventoryReader;
	readonly registry: Registry;

	private sidecar: BedrockSidecar;
	private options: BedrockDriverOptions;

	private username = "";
	private spawned = false;
	private state = {
		position: { x: 0, y: 0, z: 0 } as Position,
		yaw: 0,
		pitch: 0,
		health: 20,
		food: 20,
	};
	/** サイドカーから引いた持ち物の写し。items() が同期メソッドなので保持する。 */
	private items: ItemInfo[] = [];
	private entities: EntityInfo[] = [];
	private pollTimer: NodeJS.Timeout | null = null;
	/** 周辺ブロックの写し。world.* はここから答える。 */
	private blocks = new BlockView();
	/** 最後にスナップショットを取った位置。動いたら取り直す。 */
	private lastSnapshotAt: Position | null = null;

	private chatListeners: ((username: string, message: string) => void)[] = [];
	private endListeners: ((reason: string) => void)[] = [];
	public disconnectReason: string | null = null;

	constructor(options: BedrockDriverOptions) {
		this.options = options;
		this.sidecar = new BedrockSidecar({
			realmInvite: options.realmInvite,
			address: options.address,
			name: options.name,
			tokenCache: options.tokenCache,
			onMsaCode: options.onMsaCode,
			binaryPath: options.binaryPath,
			viaWsl: options.viaWsl,
			wslDistro: options.wslDistro,
		});

		// ブロックはサイドカーから立方体でまとめて受け取り、こちらで展開して
		// 同期的に答える。都度問い合わせると WorldReader の同期APIに合わない。
		this.world = {
			blockAt: (p) => this.blocks.blockAt(p),
			findBlock: (names, maxDistance) => {
				const want = new Set(names.map(stripNamespace));
				const found = this.blocks.findMatching(
					this.state.position,
					(n) => want.has(n),
					maxDistance,
					1,
				);
				return found[0] ?? null;
			},
			findBlocks: (names, maxDistance, count) => {
				const want = new Set(names.map(stripNamespace));
				return this.blocks.findMatching(
					this.state.position,
					(n) => want.has(n),
					maxDistance,
					count,
				);
			},
			findBlocksMatching: (predicate, maxDistance, count) =>
				this.blocks.findMatching(this.state.position, predicate, maxDistance, count),
			// 統合版はバイオームもライトレベルもクライアントへ素直に送ってこない。
			// 近似を返すと skills/ がそれを前提に判断してしまうため、
			// 判断材料にならない値であることが分かる形で返す。
			getBiome: () => "unknown",
			getLightLevel: () => 15,
		};

		this.inventory = {
			items: () => this.items.slice(),
			// 統合版の選択スロットはサイドカーがまだ扱っていない。
			heldItem: () => null,
			emptySlotCount: () => Math.max(0, 36 - this.items.length),
		};

		// アイテム表はサイドカーが StartGame から取っているが、こちら側には
		// 名前一覧を持っていない。持ち物にあるかどうかだけで答える。
		this.registry = {
			hasBlock: (name) => this.items.some((i) => i.name === name),
			hasItem: (name) => this.items.some((i) => i.name === name),
		};
	}

	/** 切断時の追跡用。workflow 側が参照する。 */
	get recentPackets(): string[] {
		return this.sidecar.recentEvents;
	}

	/**
	 * 移動がどれだけサーバーに棄却されているかの診断値。
	 * 補正が多く引き戻し量が大きいほど、こちらの予測が実際の物理と合っていない。
	 */
	public lastDiagnostics: {
		corrections: number;
		driftTotal: number;
		ticksSent: number;
		histHits: number;
		histMisses: number;
		maxDrift: number;
	} | null = null;

	// --- ライフサイクル ---

	async connect(): Promise<void> {
		this.sidecar.on("spawn", (d: any) => {
			if (d?.position) this.state.position = toPos(d.position);
		});
		this.sidecar.on("chat", (d: any) => {
			// 自分の発言もサーバーから返ってくる。自問自答させない。
			if (!d || d.self) return;
			const source = String(d.source ?? "").trim();
			const message = String(d.message ?? "").trim();
			if (!source || !message) return;
			for (const l of this.chatListeners) l(source, message);
		});
		this.sidecar.on("end", (reason: any) => {
			this.spawned = false;
			this.disconnectReason = String(reason ?? "理由不明");
			this.stopPolling();
			for (const l of this.endListeners) l(this.disconnectReason);
		});

		await this.sidecar.start();
		this.spawned = true;

		// 状態と持ち物は同期メソッドで読まれるので、定期的に引いて写しを更新する。
		await this.refresh();
		this.pollTimer = setInterval(() => {
			this.refresh().catch(() => {
				// 切断時はここが失敗するが、end イベント側で処理する。
			});
		}, 1000);

		const st = await this.sidecar.send("state");
		this.username = String(st.username ?? this.username);

		// サブチャンクは要求してから届くので、スポーン直後は周りが見えていない。
		// ここで待たないと、最初のスキルが「何も無い世界」を見て動くことになる。
		await this.waitForBlocks();
	}

	/**
	 * 周辺ブロックが届くまで待つ。
	 * 届かなくても接続自体は使えるので、時間切れでも例外にはしない。
	 */
	private async waitForBlocks(limitMs = 15_000): Promise<void> {
		const deadline = Date.now() + limitMs;
		while (Date.now() < deadline) {
			if (this.blocks.knownCount > 0) return;
			await sleep(300);
			await this.refreshBlocks();
		}
		console.error("[bedrock] 周辺ブロックが届きませんでした。world の参照は null を返します");
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private async refresh(): Promise<void> {
		const [st, inv, ents] = await Promise.all([
			this.sidecar.send("state"),
			this.sidecar.send("inventory"),
			this.sidecar.send("entities", { range: 64 }),
		]);
		this.state.position = toPos(st.position);
		this.state.yaw = Number(st.yaw ?? 0);
		this.state.pitch = Number(st.pitch ?? 0);
		this.state.health = Number(st.health ?? 20);
		this.state.food = Number(st.food ?? 20);
		this.lastDiagnostics = {
			corrections: Number(st.corrections ?? 0),
			driftTotal: Number(st.driftTotal ?? 0),
			ticksSent: Number(st.ticksSent ?? 0),
			histHits: Number(st.histHits ?? 0),
			histMisses: Number(st.histMisses ?? 0),
			maxDrift: Number(st.maxDrift ?? 0),
		};
		this.items = (inv.items ?? []).map((i: any) => ({
			name: String(i.name),
			count: Number(i.count),
			slot: Number(i.slot),
		}));
		this.entities = (ents.entities ?? []).map((e: any) => ({
			id: Number(e.id),
			name: String(e.name),
			kind: e.isItem ? "item" : e.isPlayer ? "player" : "mob",
			position: toPos(e.position),
			username: e.isPlayer ? String(e.name) : undefined,
		}));

		await this.refreshBlocks();
	}

	/**
	 * 周辺ブロックの写しを取り直す。
	 * 33立方ぶんで70KB近くになるので毎回は取らない。動いたときと、
	 * 動かなくても他人が地形を変えている可能性を考えて数秒ごとに取る。
	 */
	private async refreshBlocks(force = false): Promise<void> {
		const here = this.state.position;
		const last = this.lastSnapshotAt;
		const moved = last ? distance(here, last) : Number.POSITIVE_INFINITY;
		const stale = Date.now() - this.blocks.updatedAt > 5000;
		// 接続直後はサブチャンクがまだ届いておらず、取っても空になる。
		// 空のまま待つと world.* が延々 null を返すので、埋まるまで毎周期取り直す。
		const empty = this.blocks.knownCount === 0;
		if (!force && !empty && moved < 4 && !stale) return;

		try {
			const snap = await this.sidecar.send("snapshot", { range: SNAPSHOT_RADIUS }, 20_000);
			this.blocks.load(snap as any);
			this.lastSnapshotAt = { ...here };
		} catch (e) {
			// 取れなくても致命的ではないが、黙らせると world.* が常に null を返す
			// 状態に気づけない。次の周期で取り直す。
			console.error(`[bedrock] 周辺ブロックの取得に失敗: ${e}`);
		}
	}

	async disconnect(): Promise<void> {
		this.stopPolling();
		await this.sidecar.stop();
		this.spawned = false;
	}

	on(event: string, listener: (...args: any[]) => void): void {
		if (event === "chat") this.chatListeners.push(listener as any);
		else if (event === "end" || event === "kicked") this.endListeners.push(listener as any);
		// spawn/death/health は現状 workflow 側で使っていないので受けるだけにしない。
		else this.sidecar.on(event, listener as any);
	}

	off(event: string, listener: (...args: any[]) => void): void {
		if (event === "chat") {
			this.chatListeners = this.chatListeners.filter((l) => l !== listener);
		} else if (event === "end" || event === "kicked") {
			this.endListeners = this.endListeners.filter((l) => l !== listener);
		} else {
			this.sidecar.off(event, listener as any);
		}
	}

	// --- 読み取り ---

	getState(): BotState {
		return {
			username: this.username,
			position: { ...this.state.position },
			yaw: this.state.yaw,
			health: this.state.health,
			food: this.state.food,
			// 統合版の時刻はサイドカーがまだ拾っていない。昼として扱う。
			timeOfDay: 6000,
			isRaining: false,
			dimension: "overworld",
			isReady: this.spawned,
		};
	}

	nearbyEntities(maxDistance: number): EntityInfo[] {
		const me = this.state.position;
		return this.entities.filter((e) => distance(me, e.position) <= maxDistance);
	}

	// --- 行動 ---

	async goto(signal: AbortSignal, goal: MoveGoal): Promise<void> {
		const target = this.resolveGoal(goal);
		if (!target) notImplemented(`この移動目標(${goal.kind})`);

		const onAbort = () => this.sidecar.fire_and_forget("stop");
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await this.sidecar.send(
				"goto",
				{ x: target.x, z: target.z, range: target.distance, timeoutMs: 30_000 },
				35_000,
			);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * MoveGoal を XZ の目標に落とす。ブロックを見ないと決められない目標
	 * (getToBlock / lookAtBlock) は、ワールド読み取りが入るまで扱えない。
	 */
	private resolveGoal(goal: MoveGoal): { x: number; z: number; distance: number } | null {
		switch (goal.kind) {
			case "near":
				return { x: goal.position.x, z: goal.position.z, distance: goal.distance };
			case "block":
				return { x: goal.position.x, z: goal.position.z, distance: 0.7 };
			case "xz":
				return { x: goal.x, z: goal.z, distance: goal.distance };
			case "follow": {
				const e = this.entities.find((x) => x.id === goal.entityId);
				if (!e) throw new Error(`追従対象のエンティティ(${goal.entityId})が見つかりません`);
				return { x: e.position.x, z: e.position.z, distance: goal.distance };
			}
			default:
				return null;
		}
	}

	stopMoving(): void {
		this.sidecar.fire_and_forget("stop");
	}

	async setControlState(
		signal: AbortSignal,
		state: ControlState,
		value: boolean,
		durationMs?: number,
	): Promise<void> {
		await this.sidecar.send("control", { state, value });
		if (!durationMs) return;
		const start = Date.now();
		while (Date.now() - start < durationMs) {
			if (signal.aborted) break;
			await sleep(50);
		}
		await this.sidecar.send("control", { state, value: false });
	}

	clearControlStates(): void {
		this.sidecar.fire_and_forget("stop");
	}

	async lookAt(position: Position): Promise<void> {
		await this.sidecar.send("lookAt", { x: position.x, y: position.y, z: position.z });
	}

	async chat(message: string): Promise<void> {
		const text = message.trim();
		if (!text) return;
		// 統合版のチャットは1行あたりの上限があるので刻む。
		for (const chunk of text.match(/[\s\S]{1,180}/g) ?? []) {
			await this.sidecar.send("chat", { message: chunk });
			await sleep(300);
		}
	}

	// --- ワールド操作（未実装） ---

	async dig(signal: AbortSignal, position: Position): Promise<void> {
		const onAbort = () => this.sidecar.fire_and_forget("stop");
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await this.sidecar.send(
				"dig",
				{ x: position.x, y: position.y, z: position.z, timeoutMs: 25_000 },
				30_000,
			);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
		// 掘った結果を写しに反映させる。次の判断が古い地形を見ないように。
		await this.refreshBlocks(true);
	}

	async placeBlock(_signal: AbortSignal, reference: Position, face: Position): Promise<void> {
		await this.sidecar.send("place", {
			x: reference.x,
			y: reference.y,
			z: reference.z,
			face: faceIndex(face),
		});
		// サーバーが置いた結果が返るのを少し待ってから写しを取り直す。
		await sleep(400);
		await this.refreshBlocks(true);
	}
	async activateBlock(_position: Position): Promise<void> {
		notImplemented("ブロックの操作");
	}
	/**
	 * 相手を殴る。
	 * 届く距離まで自分で寄る。skills/ 側は追従してから呼ぶが、
	 * 相手が動くので呼ばれた時点で離れていることがある。
	 */
	async attack(signal: AbortSignal, entityId: number): Promise<void> {
		// 相手は動く。寄っている間に離れるので、座標を取り直しながら追う。
		for (let i = 0; i < 4; i++) {
			if (signal.aborted) throw new Error("中断された");
			await this.refresh();
			const target = this.entities.find((e) => e.id === entityId);
			if (!target) throw new Error(`攻撃対象(${entityId})が見つかりません`);

			if (distance(this.state.position, target.position) <= 3) {
				await this.sidecar.send("attack", { count: entityId });
				return;
			}
			await this.goto(signal, {
				kind: "xz",
				x: target.position.x,
				z: target.position.z,
				distance: 1.2,
			});
		}
		throw new Error(`攻撃対象(${entityId})に近づけませんでした`);
	}
	async equip(itemName: string, destination: string): Promise<void> {
		if (destination !== "hand") {
			notImplemented(`${destination} への装備`);
		}
		const want = stripNamespace(itemName);
		// ホットバー(スロット0-8)にあるものしか持てない。
		const slot = this.items.find((i) => i.name === want && i.slot >= 0 && i.slot <= 8);
		if (!slot) {
			throw new Error(`${itemName} がホットバーにありません`);
		}
		await this.sidecar.send("hold", { count: slot.slot });
	}

	/**
	 * そのブロックに向いた道具を持つ。
	 * mineflayer-tool のような採掘速度の計算はしておらず、素材の等級で選ぶだけ。
	 * 「ダイヤを斧で叩く」ような取り違えを防ぐのが目的。
	 */
	async equipBestTool(position: Position): Promise<void> {
		const block = this.blocks.blockAt(position);
		if (!block) return;
		const kind = toolKindFor(block.name);
		if (!kind) return;

		const ranked = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];
		const candidates = this.items
			.filter((i) => i.slot >= 0 && i.slot <= 8 && i.name.endsWith(`_${kind}`))
			.sort((a, b) => {
				const ra = ranked.findIndex((m) => a.name.startsWith(m));
				const rb = ranked.findIndex((m) => b.name.startsWith(m));
				return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
			});
		if (candidates.length === 0) return;
		await this.sidecar.send("hold", { count: candidates[0].slot });
	}
	/**
	 * 落ちているアイテムを拾う。
	 * 統合版は近づけば勝手に拾うので、落ちている場所へ順に歩くだけでよい。
	 */
	async pickupNearbyItems(signal: AbortSignal): Promise<void> {
		const deadline = Date.now() + 15_000;
		// 一度に何個も追いかけると時間切れになるので、近いものから数個まで。
		for (let i = 0; i < 6; i++) {
			if (signal.aborted || Date.now() > deadline) return;
			await this.refresh();
			const here = this.state.position;
			const items = this.entities
				.filter((e) => e.kind === "item")
				.sort((a, b) => distance(here, a.position) - distance(here, b.position));
			const target = items[0];
			if (!target || distance(here, target.position) > 24) return;

			try {
				await this.goto(signal, {
					kind: "xz",
					x: target.position.x,
					z: target.position.z,
					distance: 0.8,
				});
			} catch {
				// 届かないものは諦めて次へ。溶岩の上などは取りに行けない。
				return;
			}
			// 拾われるまで少し待つ。判定はサーバー側。
			await sleep(500);
		}
	}
	async craft(_itemName: string, _count: number, _craftingTable?: Position): Promise<void> {
		notImplemented("クラフト");
	}
	canCraft(_itemName: string, _craftingTable?: Position): boolean {
		return false;
	}
	canSmelt(_itemName: string): boolean {
		return false;
	}
	async smelt(): Promise<void> {
		notImplemented("精錬");
	}
	async takeAllFromContainer(_signal: AbortSignal, _position: Position): Promise<number> {
		notImplemented("コンテナからの回収");
	}
}

function toPos(v: any): Position {
	if (Array.isArray(v)) return { x: Number(v[0]), y: Number(v[1]), z: Number(v[2]) };
	return { x: 0, y: 0, z: 0 };
}

/** 面の向きベクトルを統合版の面番号に直す。 */
function faceIndex(face: Position): number {
	if (face.y < 0) return 0;
	if (face.y > 0) return 1;
	if (face.z < 0) return 2;
	if (face.z > 0) return 3;
	if (face.x < 0) return 4;
	if (face.x > 0) return 5;
	// 向きが無い指定は上面として扱う。置けないよりは自然な既定。
	return 1;
}

/** そのブロックを掘るのに向いた道具の種類。分からなければ null。 */
function toolKindFor(blockName: string): string | null {
	if (
		/_ore$|^stone|^cobblestone|^deepslate|^andesite|^diorite|^granite|^obsidian|^furnace|^netherrack|^blackstone|^basalt|^tuff/.test(
			blockName,
		)
	) {
		return "pickaxe";
	}
	if (/_log$|_wood$|^planks$|_planks$|^crafting_table$|^chest$|^barrel$/.test(blockName)) {
		return "axe";
	}
	if (
		/^dirt$|^grass_block$|^sand$|^gravel$|^clay$|^soul_sand$|^podzol$|^mycelium$/.test(blockName)
	) {
		return "shovel";
	}
	return null;
}

function distance(a: Position, b: Position): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// BlockInfo は型として使うだけだが、未実装の world が返す型を明示しておく。
export type { BlockInfo };
