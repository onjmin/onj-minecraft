/**
 * BotDriver — Minecraft のエディション差を吸収する抽象層。
 *
 * 目的:
 *   skills/ が mineflayer に直接依存しないようにし、Java版(mineflayer)と
 *   統合版(bedrock-protocol系)の両方を同じスキル実装で動かせるようにする。
 *
 * 設計方針:
 *   - 既存の src/skills/ が実際に使っている API のみを定義する（憶測で広げない）。
 *   - Vec3 クラスへの依存を切り、プレーンな {x,y,z} を境界に置く。
 *   - 座標系・ブロック名は Java 版の呼称を正とし、統合版側の Driver が変換責務を負う。
 */

/** エディション非依存の座標。Vec3 の代わりに境界で使う。 */
export interface Position {
	x: number;
	y: number;
	z: number;
}

/** ブロックの最小表現。skills/ が参照しているのは name / position / 硬さ判定のみ。 */
export interface BlockInfo {
	name: string;
	position: Position;
	/** 現在の装備で採掘可能か。統合版では自前計算になる。 */
	diggable: boolean;
	/**
	 * 当たり判定を持つ（通り抜けられない）か。Java版の boundingBox === "block" 相当。
	 * 空気・水・草などは false。足場判定に使う。
	 */
	solid: boolean;
}

/** インベントリ内アイテム。 */
export interface ItemInfo {
	name: string;
	count: number;
	/** スロット番号。統合版とJava版でスロット体系が異なるため、Driver が正規化する。 */
	slot: number;
}

export interface EntityInfo {
	id: number;
	name: string;
	/** "player" | "mob" | "object" など。Java版の entity.type に準拠。 */
	kind: string;
	position: Position;
	username?: string;
}

/**
 * 移動目標。mineflayer-pathfinder の goals.* を直接使わず、
 * この記述子を Driver 側で各エディションの経路探索に変換する。
 */
export type MoveGoal =
	/** 指定座標に distance ブロック以内まで近づく（GoalNear 相当） */
	| { kind: "near"; position: Position; distance: number }
	/** 指定ブロックにぴったり乗る（GoalBlock 相当） */
	| { kind: "block"; position: Position }
	/** 指定ブロックを操作できる隣接位置まで行く（GoalGetToBlock 相当） */
	| { kind: "getToBlock"; position: Position }
	/** Y を無視して XZ 平面で到達する（GoalNearXZ 相当） */
	| { kind: "xz"; x: number; z: number; distance: number }
	/** 指定ブロックを視認・操作できる位置まで行く（GoalLookAtBlock 相当） */
	| { kind: "lookAtBlock"; position: Position }
	/** エンティティを追従する（GoalFollow 相当） */
	| { kind: "follow"; entityId: number; distance: number };

export type ControlState = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";

/** ワールド読み取り。統合版では実装が最も重くなる部分。 */
export interface WorldReader {
	blockAt(position: Position): BlockInfo | null;
	/** 半径 maxDistance 内で names のいずれかに一致するブロックを1つ探す。 */
	findBlock(names: string[], maxDistance: number): BlockInfo | null;
	/** 同上を最大 count 個。 */
	findBlocks(names: string[], maxDistance: number, count: number): BlockInfo[];
	/**
	 * ブロック名の述語で探す（"_log" で終わる、のような接尾辞マッチ用）。
	 * 述語は名前だけを見る。Block オブジェクト全体を渡さないのは、
	 * エディション固有のフィールドに skills/ が依存するのを防ぐため。
	 */
	findBlocksMatching(
		predicate: (name: string) => boolean,
		maxDistance: number,
		count: number,
	): BlockInfo[];
	getBiome(position: Position): string;
	/**
	 * 体感的な明るさ 0–15。
	 * 注意: 統合版はライトレベルをクライアントへ送らないため、
	 *       BedrockDriver では時刻・Y座標・遮蔽からの近似値を返す。
	 *       厳密な値を前提にした判定を skills/ 側に書かないこと。
	 */
	getLightLevel(position: Position): number;
}

export interface InventoryReader {
	items(): ItemInfo[];
	heldItem(): ItemInfo | null;
	emptySlotCount(): number;
}

/** ブロック名・アイテム名の存在確認。Java版の bot.registry 相当。 */
export interface Registry {
	hasBlock(name: string): boolean;
	hasItem(name: string): boolean;
}

export interface BotState {
	username: string;
	position: Position;
	yaw: number;
	health: number;
	food: number;
	/** 0–24000 のワールド内時刻。 */
	timeOfDay: number;
	isRaining: boolean;
	dimension: string;
	/** スポーン済みでワールドを操作可能か。Java版の bot.entity 有無に相当。 */
	isReady: boolean;
}

/**
 * すべてのスキルはこのインターフェース越しにボットを操作する。
 * 中断は AbortSignal で統一し、実装側が確実に停止させる責務を持つ。
 */
export interface BotDriver {
	readonly world: WorldReader;
	readonly inventory: InventoryReader;
	readonly registry: Registry;

	getState(): BotState;
	nearbyEntities(maxDistance: number): EntityInfo[];

	// --- 行動（すべて中断可能） ---
	goto(signal: AbortSignal, goal: MoveGoal): Promise<void>;
	stopMoving(): void;
	setControlState(
		signal: AbortSignal,
		state: ControlState,
		value: boolean,
		durationMs?: number,
	): Promise<void>;
	clearControlStates(): void;
	lookAt(position: Position): Promise<void>;

	/**
	 * 位置で指定する。BlockInfo ではなく Position を受けるのは、
	 * エディション固有の Block オブジェクトを skills/ 側に持ち回らせないため。
	 */
	dig(signal: AbortSignal, position: Position): Promise<void>;
	/** reference ブロックの face 方向の面にブロックを設置する。 */
	placeBlock(signal: AbortSignal, reference: Position, face: Position): Promise<void>;
	activateBlock(position: Position): Promise<void>;

	attack(signal: AbortSignal, entityId: number): Promise<void>;
	equip(
		itemName: string,
		destination: "hand" | "head" | "torso" | "legs" | "feet" | "off-hand",
	): Promise<void>;
	/**
	 * 指定ブロックの採掘に最適なツールを手に持つ。
	 * Java版は mineflayer-tool に委譲。統合版は自前実装が必要。
	 * 「ダイヤを斧で叩く」を防ぐための中核。
	 */
	equipBestTool(position: Position): Promise<void>;
	pickupNearbyItems(signal: AbortSignal): Promise<void>;

	/** 作業台が必要な場合は craftingTable にその位置を渡す。 */
	craft(itemName: string, count: number, craftingTable?: Position): Promise<void>;
	/** 指定アイテムを今のインベントリで作れるか。 */
	canCraft(itemName: string, craftingTable?: Position): boolean;
	/** かまどで焼けるアイテムか（レシピ表に精錬先が存在するか）。 */
	canSmelt(itemName: string): boolean;
	/** かまどに燃料と素材を投入する。完了までは待たない。 */
	smelt(
		furnace: Position,
		input: string,
		inputCount: number,
		fuel: string,
		fuelCount: number,
	): Promise<void>;

	/**
	 * チェスト等のコンテナを開き、入っているアイテムを可能な限り回収して閉じる。
	 * 回収したアイテム数を返す。開閉のプロトコルはエディション差が大きいため、
	 * ループごと Driver 側に閉じ込めている。
	 */
	takeAllFromContainer(signal: AbortSignal, position: Position): Promise<number>;

	chat(message: string): Promise<void>;

	// --- ライフサイクル ---
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	on(
		event: "spawn" | "death" | "respawn" | "health" | "chat" | "kicked" | "end",
		listener: (...args: any[]) => void,
	): void;
	off(event: string, listener: (...args: any[]) => void): void;
}
