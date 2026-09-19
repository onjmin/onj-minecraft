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
	/**
	 * 指定座標に distance ブロック以内まで近づく（GoalNear 相当）。
	 *
	 * dig を true にすると、経路が無いときに掘って進んでよい。既定は掘らない。
	 * 落ちている物を拾いに行くのに地形を壊すのは無駄で、他人の世界も荒れる。
	 * ただし地上へ戻るときのように、掘らないと成立しない移動もある。
	 * 実測 2026-09-13、地下27メートルからの復帰が「経路 0手」で止まり続けた。
	 * 頭上が岩なので、掘る手を外した経路探索では一手も選べない。
	 */
	| { kind: "near"; position: Position; distance: number; dig?: boolean }
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

/**
 * 移動の共通の指定。
 *
 * timeoutMs は「ここまで待つ」上限。既定は長め(30秒)で、着くまで粘る移動に
 * 合っている。動く相手へ寄るときは短く刻むこと。1回の goto が30秒粘ると、
 * 狩りの持ち時間(20秒)を1回で使い切り、攻撃が一度も入らない。
 * 実測 2026-09-18 12:22、牛への接近に40秒かけて攻撃は1回だった。
 */
export type MoveOptions = { timeoutMs?: number };

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
	/**
	 * 名前指定で、同期版より遠くまで探す。
	 *
	 * 同期の find* 系は「自分中心の立方体を丸ごと受け取って展開したもの」を
	 * 見ている。統合版ではその立方体が半径16しかなく、それより遠くを指定しても
	 * 黙って16に切り詰められる（BlockView.findMatching のクランプ）。
	 * BED_SEARCH_RADIUS=48 のような指定が効いていないのはこれが理由で、
	 * 半径48のつもりで書いた探索が実際には16しか見ていなかった。
	 *
	 * こちらはサイドカーが保持しているチャンクを直接引くので、要求済みの
	 * 範囲(水平±128・垂直±80)まで届く。往復が要るので非同期。
	 * 毎tick呼ぶものではない。間隔を空けて使うこと。
	 */
	findBlocksFar(names: string[], maxDistance: number, count: number): Promise<BlockInfo[]>;
	/**
	 * 周りの列ごとの地表(空が見えている一番上の固いブロック)を返す。
	 *
	 * blockAt は自分中心の半径16しか答えられない。48ブロック掘り抜かれた穴の
	 * 底に落ちると本物の地表が範囲外になり、穴の途中の棚を地表と誤認して
	 * 抜け出せなくなる。列を上へ辿るだけの計算なので、チャンクを持っている
	 * サイドカー側にやらせる。往復が要るので非同期。
	 *
	 * open は「その地表の上に何マスの空きを読めたか」。天井の下か空の下かの
	 * 目安になる。読めていない列は返らない。
	 */
	surfaceScan(
		radius: number,
	): Promise<{ x: number; z: number; y: number; name: string; open: number }[]>;
	getBiome(position: Position): string;
	/**
	 * その場の明るさ 0–15。分からないときは null。
	 *
	 * 統合版はサーバーが明るさを送ってこない。サイドカーが持っている
	 * チャンクから、頭上の遮蔽と近くの光源、それに時刻で推定する。
	 * 読み込めていない場所では推定もできないので null になる。
	 *
	 * null を 0 や 15 に丸めないこと。BedrockDriver は長いあいだ 15 固定を
	 * 返していて、暗い所にいることが上流へ一度も伝わっていなかった。
	 */
	getLightLevel(position: Position): number | null;
}

export interface InventoryReader {
	items(): ItemInfo[];
	heldItem(): ItemInfo | null;
	emptySlotCount(): number;
	/**
	 * 今着ている防具（頭・胴・脚・足の順、空きは null）。
	 *
	 * items() には出てこない。どちらのエディションでも防具は持ち物とは別の
	 * 入れ物にあるため、items() だけを見ると「フル装備なのに丸腰」と判定する。
	 */
	armor(): (ItemInfo | null)[];
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
	goto(signal: AbortSignal, goal: MoveGoal, options?: MoveOptions): Promise<void>;
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

	/**
	 * 柱を積んで登る。跳んで、浮いている間に足元へブロックを置く。
	 * 頭上を掘るだけでは登れない(縦穴が伸びるだけ)ので、上がるにはこれが要る。
	 * 実際に上がれた段数を返す。
	 */
	pillarUp(signal: AbortSignal, count: number): Promise<number>;
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

	/**
	 * 食べ物を食べて満腹度を戻す。食べたら true。
	 *
	 * これが無いまま長く動かしていた。food は知覚まで通っていて思考プロンプトに
	 * 「Hunger: 20」と出るのに、減ったものを戻す手段がどこにも無かった。
	 * 満腹度が 18 を切ると体力が自然回復しなくなるので、狩って焼いた肉を
	 * 持ったまま、回復できずに殴られて死ぬ状態が続いていた。
	 * shelterAtNight の「潜っても満腹度が足りなければ回復しない」という
	 * 但し書きは、この欠落をそのまま言い当てている。
	 *
	 * 何を食べるかは実装側が選ぶ（腐肉やフグのような不利益のあるものは避ける）。
	 */
	eat(signal: AbortSignal): Promise<boolean>;

	/**
	 * 持ち物のアイテムを地面に落とす。
	 *
	 * Java版・統合版とも、プレイヤー同士で直接手渡す操作は存在しない。
	 * バニラで人に物を渡す唯一の方法は、相手のそばで落として拾わせること
	 * （Q キー相当）。呼ぶ前に相手のすぐ近くまで goto しておくこと。
	 * 持っている数より多く指定したら、持っている分だけ落とす。
	 */
	dropItem(itemName: string, count: number): Promise<void>;

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
		event:
			| "spawn"
			| "death"
			| "respawn"
			| "health"
			| "chat"
			// サーバーからの通知(キルログ・死亡ログ・参加退出)
			| "system"
			// プレイヤーに殴られた
			| "attacked_by_player"
			// プレイヤーに倒された。キルログから加害者名が分かる
			| "killed_by_player"
			// サーバーにいる人の一覧が変わった
			| "players"
			// 誰かがベッドに入った。引数は就寝中の人数(自分を含む)。
			// 統合版のみが発火する。Java版(mineflayer)にこの通知は無く、
			// 購読しても呼ばれないだけで害は無い。
			| "sleeping"
			| "kicked"
			| "end",
		listener: (...args: any[]) => void,
	): void;
	off(event: string, listener: (...args: any[]) => void): void;
}
