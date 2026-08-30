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
	throw new Error(`統合版では${what}がまだ使えません（サイドカーのチャンク解析が未実装）`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

		// ワールド読み取りはサイドカー側が未対応。近似で誤魔化すと skills/ が
		// 存在しないブロックを掘ろうとして静かに失敗するので、明示的に落とす。
		this.world = {
			blockAt: () => notImplemented("ブロックの参照"),
			findBlock: () => notImplemented("ブロックの探索"),
			findBlocks: () => notImplemented("ブロックの探索"),
			findBlocksMatching: () => notImplemented("ブロックの探索"),
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
			kind: e.isPlayer ? "player" : "mob",
			position: toPos(e.position),
			username: e.isPlayer ? String(e.name) : undefined,
		}));
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

	async dig(_signal: AbortSignal, _position: Position): Promise<void> {
		notImplemented("採掘");
	}
	async placeBlock(_signal: AbortSignal, _reference: Position, _face: Position): Promise<void> {
		notImplemented("ブロックの設置");
	}
	async activateBlock(_position: Position): Promise<void> {
		notImplemented("ブロックの操作");
	}
	async attack(_signal: AbortSignal, _entityId: number): Promise<void> {
		notImplemented("攻撃");
	}
	async equip(_itemName: string, _destination: string): Promise<void> {
		notImplemented("装備の変更");
	}
	async equipBestTool(_position: Position): Promise<void> {
		notImplemented("道具の持ち替え");
	}
	async pickupNearbyItems(_signal: AbortSignal): Promise<void> {
		notImplemented("落ちているアイテムの回収");
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

function distance(a: Position, b: Position): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// BlockInfo は型として使うだけだが、未実装の world が返す型を明示しておく。
export type { BlockInfo };
