/**
 * 統合版(Bedrock)の BotDriver。
 *
 * 接続とプロトコルは Go サイドカー(sidecar/bedrock)が持つ。JS 側のライブラリは
 * player_auth_input の定義が実プロトコルと食い違っており送信が成立しないため、
 * そちらへ委譲している。Realm には同時に1接続しか張れないので、読み取りも含めて
 * 全てサイドカー越しになる。
 *
 * 通っているのは接続・状態・エンティティ・持ち物・移動・発言・ワールド読み取り・
 * 採掘・設置・クラフト・攻撃。本番 Realm で確認済み。
 *
 * 未実装は無くなった。
 * 黙って何もせず成功を装うと、スキル側が「やった」と誤解して先へ進むため。
 *   - smelt / canSmelt: 精錬
 */
import { BlockView } from "./blockview";
import { pickFood } from "./food";
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

/**
 * かまどで焼けるもの。
 *
 * かまどのレシピはブロック別のレシピ表で来るが、そこは取り込んでいないので
 * 名前で判断する。序盤の連鎖に要るものだけあればよい。
 */
const SMELTABLE = new Set([
	"raw_iron",
	"raw_gold",
	"raw_copper",
	"iron_ore",
	"gold_ore",
	"copper_ore",
	"deepslate_iron_ore",
	"deepslate_gold_ore",
	"deepslate_copper_ore",
	"sand",
	"cobblestone",
	"cobbled_deepslate",
	"clay_ball",
	"beef",
	"porkchop",
	"chicken",
	"mutton",
	"rabbit",
	"cod",
	"salmon",
	"potato",
	"kelp",
]);

/**
 * サーバーからの通知を人が読める形にする。
 *
 * 統合版は翻訳キーと差し込み語で送ってくる(例: death.attack.player に
 * ["kusabot2361", "SliestYard48532"])。そのままでは誰が誰にやられたか
 * 分からない。よく出るものだけ日本語にし、他はキーと語を並べて出す。
 * 全部を訳す必要はない。読めれば判断の材料になる。
 */
function describeSystemMessage(key: string, params: unknown): string {
	const args = Array.isArray(params) ? params.map((p) => String(p)) : [];
	const who = args[0] ?? "誰か";
	const by = args[1] ?? "何か";
	switch (key) {
		case "death.attack.player":
			return `${who} が ${by} に倒された`;
		case "death.attack.mob":
		case "death.attack.arrow":
			return `${who} が ${by} にやられた`;
		case "death.attack.drown":
			return `${who} が溺れた`;
		case "death.attack.fall":
			return `${who} が落下して死んだ`;
		case "death.attack.inFire":
		case "death.attack.onFire":
			return `${who} が焼け死んだ`;
		case "death.attack.lava":
			return `${who} が溶岩で死んだ`;
		case "death.attack.explosion":
		case "death.attack.explosion.player":
			return `${who} が爆発で死んだ`;
		case "multiplayer.player.joined":
			return `${who} が入ってきた`;
		case "multiplayer.player.left":
			return `${who} が出ていった`;
		case "chat.type.sleeping":
			return `${who} がベッドに入った（就寝中${by}人）`;
		default:
			return args.length > 0 ? `${key} (${args.join(", ")})` : key;
	}
}

/**
 * その死亡ログが「プレイヤーに殺された」ものか。
 *
 * 統合版の翻訳キーは加害者の種類まで含む。プレイヤーが手を下した経路は
 * 素手・武器(death.attack.player)だけでなく、爆発(TNT・ベッド・
 * リスポーンアンカー)や矢もある。末尾が .player のものは加害者が
 * プレイヤーなので、そこで見る。
 */
function isPlayerKill(key: string): boolean {
	return key.startsWith("death.attack.") && key.endsWith(".player");
}

/** 防具コンテナのスロット番号。Java版の destination 名に合わせる。 */
const ARMOR_SLOTS: Record<string, number> = {
	head: 0,
	torso: 1,
	legs: 2,
	feet: 3,
};

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
/**
 * findBlocksFar で許す最大の半径。
 *
 * サイドカーは要求済みのチャンク(水平±128・垂直±80)を持っている。
 * 探索は立方体の全走査ではなく、サブチャンクのパレットで先に絞ってから
 * 中身を引く方式(world.findWide)なので、半径を上げても走査量は
 * 「人工物のあるサブチャンクの数」でしか増えない。取得している範囲まで
 * 見せてよい。
 */
const FAR_SEARCH_RADIUS = 128;
/** findBlocksFar の応答待ち。全走査に振れても落ちない程度に取る。 */
const FAR_SEARCH_TIMEOUT_MS = 8_000;

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
		// 0〜23999 のゲーム内時刻。サイドカーが SetTime から拾う。
		// 届く前は昼として扱う。夜だと誤認して拠点に籠るより害が小さい。
		timeOfDay: 6000,
	};
	/** サイドカーから引いた持ち物の写し。items() が同期メソッドなので保持する。 */
	private items: ItemInfo[] = [];
	/**
	 * 今着ている防具（頭・胴・脚・足）。
	 *
	 * サイドカーは防具コンテナへ物を入れる側しか実装しておらず、中身を
	 * 読み返す口が無い。着せたのはこちらなので、こちらで控えておく。
	 * 拾った防具を自分で着た場合など、サーバー側の実態とずれる余地はあるが、
	 * 「装備しているのに丸腰と判定する」より実態に近い。
	 */
	private worn: (ItemInfo | null)[] = [null, null, null, null];
	private entities: EntityInfo[] = [];
	private pollTimer: NodeJS.Timeout | null = null;
	/** 状態の取り直しを止めたか。次の周を組まないための印。 */
	private polling = false;
	/** 周辺ブロックの写し。world.* はここから答える。 */
	private blocks = new BlockView();
	/** 最後にスナップショットを取った位置。動いたら取り直す。 */
	private lastSnapshotAt: Position | null = null;
	/** 作れる物の名前。canCraft が同期なので接続時に取っておく。 */
	private craftable = new Set<string>();

	private chatListeners: ((username: string, message: string) => void)[] = [];
	/** サーバーからの通知(キルログ・死亡ログ・参加退出)の受け手。 */
	private systemListeners: ((message: string) => void)[] = [];
	/** 自分を倒したプレイヤーの名前の受け手。 */
	private attackerListeners: ((name: string) => void)[] = [];
	/** ベッドで就寝中の人数(自分を含む)の受け手。chat.type.sleeping から拾う。 */
	private sleepingListeners: ((count: number) => void)[] = [];
	/** 今サーバーにいる人の名前。 */
	private online: string[] = [];
	private playersListeners: ((names: string[]) => void)[] = [];
	private endListeners: ((reason: string) => void)[] = [];
	public disconnectReason: string | null = null;

	constructor(options: BedrockDriverOptions) {
		this.options = options;
		this.sidecar = new BedrockSidecar({
			realmInvite: options.realmInvite,
			address: options.address,
			name: options.name,
			// 使うアカウントはトークンキャッシュの置き場所で決まる。環境変数で
			// 差し替えられるようにしておくと、検証を管理者アカウントではなく
			// 一般アカウントで回せる。管理者の権限で世界を壊す事故を避ける。
			tokenCache: options.tokenCache ?? process.env.BEDROCK_TOKEN_CACHE ?? undefined,
			// 受け手を渡していない呼び出し元でも、サインインが要ることは伝わるべき。
			// 黙って待たせると「繋がらない」としか見えない。
			onMsaCode: options.onMsaCode ?? ((m: string) => console.log("要サインイン:", m)),
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
			findBlocksFar: (names, maxDistance, count) => this.findBlocksFar(names, maxDistance, count),
			surfaceScan: (radius) => this.surfaceScan(radius),
			// 統合版はバイオームをクライアントへ素直に送ってこない。
			// 近似を返すと skills/ がそれを前提に判断してしまうため、
			// 判断材料にならない値であることが分かる形で返す。
			getBiome: () => "unknown",
			// 明るさはサイドカーが自前で推定している(sidecar/bedrock/light.go)。
			// 計算しているのは足元ぶんだけなので、離れた座標には答えない。
			// 「分からない」を「明るい」に丸めた 15 固定が、暗い所へ
			// 突っ込み続けていた原因そのものだった。混ぜ直さないこと。
			getLightLevel: (position) => {
				const feet = this.state.position;
				const far =
					Math.abs(position.x - feet.x) > 4 ||
					Math.abs(position.y - feet.y) > 4 ||
					Math.abs(position.z - feet.z) > 4;
				return far ? null : this.light;
			},
		};

		this.inventory = {
			items: () => this.items.slice(),
			// 統合版の選択スロットはサイドカーがまだ扱っていない。
			heldItem: () => null,
			emptySlotCount: () => Math.max(0, 36 - this.items.length),
			armor: () => this.worn.slice(),
		};

		// アイテム表はサイドカーが StartGame から取っているが、こちら側には
		// 名前一覧を持っていない。持ち物にあるかどうかだけで答える。
		this.registry = {
			hasBlock: (name) => this.items.some((i) => i.name === name),
			hasItem: (name) => this.items.some((i) => i.name === name),
		};
	}

	/**
	 * サイドカーが持っているチャンクを直に引いて、名前の合うブロックを探す。
	 *
	 * 同期の find* 系が見ている BlockView は半径16の立方体しかない。16より
	 * 遠くを指定しても黙って切り詰められるため、「半径48でベッドを探す」と
	 * 書いたつもりの探索が実際には16しか見ていなかった。遠くを見たいものは
	 * こちらを使う。
	 *
	 * 名前は完全一致。述語は線を越えられないので、接尾辞で探したいものは
	 * 呼び出し側が候補を並べること。
	 */
	private async findBlocksFar(
		names: string[],
		maxDistance: number,
		count: number,
	): Promise<BlockInfo[]> {
		if (names.length === 0 || count <= 0) return [];
		const range = Math.max(1, Math.min(FAR_SEARCH_RADIUS, Math.floor(maxDistance)));
		try {
			const res = await this.sidecar.send(
				"findBlock",
				{ names: names.map(stripNamespace), range, count },
				FAR_SEARCH_TIMEOUT_MS,
			);
			const found = (res.blocks ?? []) as { name: string; position: number[] }[];
			return found.map((b) =>
				BlockView.describe(b.name, { x: b.position[0], y: b.position[1], z: b.position[2] }),
			);
		} catch {
			// 探索の失敗で呼び出し側を止めない。見つからなかったのと同じに扱う。
			return [];
		}
	}

	/**
	 * 周りの列の地表をサイドカーに数えさせる。
	 *
	 * BlockView(半径16)では、深い穴の底から本物の地表が見えない。列を辿る
	 * だけの計算なので、チャンクを持っている向こう側でやる方が安い。
	 */
	private async surfaceScan(
		radius: number,
	): Promise<{ x: number; z: number; y: number; name: string; open: number }[]> {
		try {
			const res = await this.sidecar.send(
				"surfaceScan",
				{ range: Math.max(1, Math.floor(radius)) },
				FAR_SEARCH_TIMEOUT_MS,
			);
			return (res.columns ?? []) as {
				x: number;
				z: number;
				y: number;
				name: string;
				open: number;
			}[];
		} catch {
			// 失敗しても呼び出し側を止めない。何も見えなかったのと同じに扱う。
			return [];
		}
	}

	/** 切断時の追跡用。workflow 側が参照する。 */
	get recentPackets(): string[] {
		return this.sidecar.recentEvents;
	}

	/**
	 * 足元の明るさ(0〜15)。サイドカーが state のたびに計算して寄越す。
	 * まだチャンクを読めていない場所では null。
	 */
	private light: number | null = null;

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
		// サーバーにいる人数。Realms は10人までなので、混んできたら
		// ボットは席を譲る必要がある。
		this.sidecar.on("players", (d: any) => {
			this.online = Array.isArray(d?.names) ? d.names.map(String) : [];
			for (const l of this.playersListeners) l(this.online);
		});
		this.sidecar.on("chat", (d: any) => {
			// 自分の発言もサーバーから返ってくる。自問自答させない。
			if (!d || d.self) return;
			const source = String(d.source ?? "").trim();
			const message = String(d.message ?? "").trim();
			if (!message) return;
			if (!source) {
				// 送信者が無いものはサーバーからの通知。キルログや死亡ログ、
				// 参加/退出がここに来る。捨てていたので、誰が誰にやられたかを
				// 一切知らないままだった。
				const args = Array.isArray(d.parameters) ? d.parameters.map(String) : [];
				// 自分がプレイヤーに倒されたなら、加害者はここに書いてある。
				// 体力の変化から推測するより確実。
				//
				// death.attack.player だけを見ていると取りこぼす。プレイヤーに
				// 殺される経路は殴られるだけではなく、TNT・ベッド・リスポーン
				// アンカーによる爆発も同じくらい多い。それらは
				// death.attack.explosion.player で来るので、素通ししていた。
				// 実際、接続16秒後の初死亡がこれで、加害者を覚えないまま
				// 相手に近づき直していた。
				if (isPlayerKill(message) && args[0] === this.username && args[1]) {
					for (const l of this.attackerListeners) l(args[1]);
				}
				// 誰かが寝ると届く。夜をスキップできるかは全員(自分含む)が
				// 寝ているかで決まるので、人数を別出しして席を譲る判断に使う。
				if (message === "chat.type.sleeping" && args[1] !== undefined) {
					const count = Number(args[1]);
					if (!Number.isNaN(count)) for (const l of this.sleepingListeners) l(count);
				}
				for (const l of this.systemListeners) l(describeSystemMessage(message, d.parameters));
				return;
			}
			for (const l of this.chatListeners) l(source, message);
		});
		// 死亡は黙って進めない。持ち物が全部落ちるので、以降の判断が
		// 「集めたはずの物がある」前提のままだと全部おかしくなる。
		this.sidecar.on("death", (d: any) => {
			console.log(
				`[bedrock] 死亡しました（${d?.cause ?? "原因不明"}）。持ち物はその場に落ちています`,
			);
			this.items = [];
			// 防具もその場に落ちる。控えを残すと「着ている」ことになってしまう。
			this.worn = [null, null, null, null];
		});
		this.sidecar.on("respawn", (d: any) => {
			if (d?.position) this.state.position = toPos(d.position);
			console.log("[bedrock] リスポーンしました");
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
		this.startPolling();

		const st = await this.sidecar.send("state");
		this.username = String(st.username ?? this.username);

		try {
			const r = await this.sidecar.send("recipeNames", {}, 20_000);
			for (const n of (r.names ?? []) as string[]) this.craftable.add(n);
		} catch {
			// 取れなくても craft を試せば分かる。canCraft が false 寄りになるだけ。
		}

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

	/**
	 * 状態の取り直しを回し続ける。
	 *
	 * setInterval ではなく、1回終わってから次を組む。1周には状態・持ち物・
	 * エンティティの3往復に加えて周辺ブロックのスナップショット(33立方で
	 * base64 95KB前後)が入るので、1秒に収まらないことがある。setInterval だと
	 * 終わっていないのに次が始まり、サイドカーは要求を順番に捌くので、
	 * 積む方が捌く方より速くなって行列が伸び続ける。読める状態はそのぶん
	 * 古くなり、遅いほど古くなるという逆向きの働きになる。
	 */
	private startPolling(): void {
		if (this.polling) return;
		this.polling = true;

		const tick = async () => {
			if (!this.polling) return;
			try {
				await this.refresh();
			} catch {
				// 切断時はここが失敗するが、end イベント側で処理する。
			}
			if (!this.polling) return;
			this.pollTimer = setTimeout(tick, 1000);
		};

		this.pollTimer = setTimeout(tick, 1000);
	}

	private stopPolling(): void {
		this.polling = false;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
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
		// 明るさはサイドカーが推定して state に乗せてくる。読み込めていない
		// 場所では null が来る。ここで 0 や 15 に丸めないこと。
		this.light = typeof st.light === "number" ? st.light : null;
		// 時刻はサイドカーが自前で進めている。サーバーからの SetTime が
		// 届いたときだけ値が飛ぶので、飛んだら残す。誰かが寝た・管理者が
		// 時刻を変えた、あるいはこちらの進み方が間違っている、の判別に要る。
		const nextTime = Number(st.timeOfDay ?? 6000);
		const prevTime = this.state.timeOfDay;
		const elapsedTicks = this.lastStateAt > 0 ? (Date.now() - this.lastStateAt) / 50 : 0;
		const drift = (((nextTime - prevTime - elapsedTicks) % 24000) + 24000) % 24000;
		if (this.lastStateAt === 0) {
			// 最初の1回は生の値を残す。0 のままなら SetTime を受けていない、
			// 変わらないなら世界の時刻が止まっている、の区別がつかなくなる。
			console.log(`[bedrock] 接続時のワールド時刻: ${nextTime}`);
		}
		if (this.lastStateAt > 0 && drift > 600 && drift < 23400) {
			console.log(`[bedrock] 時刻が飛んだ: ${prevTime} -> ${nextTime}`);
		}
		this.lastStateAt = Date.now();
		this.state.timeOfDay = nextTime;
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
		else if (event === "system") this.systemListeners.push(listener as any);
		else if (event === "killed_by_player") this.attackerListeners.push(listener as any);
		else if (event === "sleeping") this.sleepingListeners.push(listener as any);
		else if (event === "players") this.playersListeners.push(listener as any);
		else if (event === "end" || event === "kicked") this.endListeners.push(listener as any);
		// spawn/death/health は現状 workflow 側で使っていないので受けるだけにしない。
		else this.sidecar.on(event, listener as any);
	}

	off(event: string, listener: (...args: any[]) => void): void {
		if (event === "chat") {
			this.chatListeners = this.chatListeners.filter((l) => l !== listener);
		} else if (event === "sleeping") {
			this.sleepingListeners = this.sleepingListeners.filter((l) => l !== listener);
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
			timeOfDay: this.state.timeOfDay,
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

	/** 最後に状態を読んだ時刻。時刻の飛びを見るために持つ。 */
	private lastStateAt = 0;

	async goto(signal: AbortSignal, goal: MoveGoal): Promise<void> {
		const target = this.resolveGoal(goal);
		if (!target) notImplemented(`この移動目標(${goal.kind})`);

		const onAbort = () => this.sidecar.fire_and_forget("stop");
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await this.sidecar.send(
				"goto",
				{
					x: target.x,
					z: target.z,
					range: target.distance,
					// 高さも合わせたいときだけ渡す。水平だけで判定すると、
					// 掘った穴の真上に立った時点で到達扱いになる。
					y: target.y ?? 0,
					value: target.y !== undefined,
					// 掘らずに行きたいときは face に 1 を載せる。専用の欄が
					// 無いので流用している。
					face: target.noDig ? 1 : 0,
					timeoutMs: 30_000,
				},
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
	private resolveGoal(
		goal: MoveGoal,
	): { x: number; z: number; distance: number; y?: number; noDig?: boolean } | null {
		switch (goal.kind) {
			case "near": {
				// 目標が固いブロックなら、その中心には立てない。隣の立てる場所を狙う。
				// 木の幹を距離1で指定されるような場合、そのままでは永久に届かない。
				const at = this.blocks.blockAt(goal.position);
				if (at?.solid) {
					const spot = this.standableNear(goal.position);
					// 高さも渡す。水平だけで見ると、地下にある物の真上に
					// 立った時点で「着いた」ことになる。
					return { x: spot.x, y: spot.y, z: spot.z, distance: Math.max(goal.distance, 1.2) };
				}
				// 固くない目標(落ちているアイテムなど)は高さも合わせる。
				// 水平だけだと、掘った穴の真上で「着いた」ことになる。
				return {
					x: goal.position.x,
					z: goal.position.z,
					y: goal.position.y,
					distance: goal.distance,
					// 固くない目標＝落ちている物などを拾いに行く場面。
					// そのために地形を掘るのは無駄で、他人の世界も壊す。
					// dig:true を渡されたときだけ掘ってよい。
					noDig: goal.dig !== true,
				};
			}
			case "block":
				return { x: goal.position.x, z: goal.position.z, distance: 0.7 };
			case "xz":
				return { x: goal.x, z: goal.z, distance: goal.distance };
			case "follow": {
				const e = this.entities.find((x) => x.id === goal.entityId);
				if (!e) throw new Error(`追従対象のエンティティ(${goal.entityId})が見つかりません`);
				return { x: e.position.x, z: e.position.z, distance: goal.distance };
			}
			case "getToBlock":
			case "lookAtBlock": {
				// そのブロックを操作できる位置まで行く。ブロックの上には立てないので、
				// 隣で立てる場所を探す。見つからなければブロックの真横を狙う。
				//
				// 高さも渡すこと。水平距離だけで到達を判定すると、地下にある
				// ベッドの真上(地表)に立った時点で「着いた」と返ってくる。
				// 実測 02:24:30、8ブロック下のベッドに対して goto は成功を
				// 返し、直後の activateBlock が「遠すぎて届きません（10.5
				// ブロック）」で落ちていた。リスポーン地点の登録が何度も
				// 失敗していたのはこれが原因。
				const spot = this.standableNear(goal.position);
				return { x: spot.x, y: spot.y, z: spot.z, distance: 1.2 };
			}
			default:
				return null;
		}
	}

	/**
	 * そのブロックの隣で立てる場所を探す。
	 * ブロックそのものを目標にすると、上に乗ろうとして届かないことがある。
	 */
	private standableNear(target: Position): Position {
		// 真横だけでなく下も見る。木の幹のように縦に伸びる物は、
		// 隣に立てる場所が無くても真下や斜め下からなら届く。
		const around: Position[] = [];
		for (const dy of [0, -1, -2, 1]) {
			for (const [dx, dz] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
				[0, 0],
			] as const) {
				if (dy === 0 && dx === 0 && dz === 0) continue;
				around.push({ x: dx, y: dy, z: dz });
			}
		}
		for (const off of around) {
			const foot = {
				x: Math.floor(target.x) + off.x,
				y: Math.floor(target.y) + off.y,
				z: Math.floor(target.z) + off.z,
			};
			const at = this.blocks.blockAt(foot);
			const head = this.blocks.blockAt({ ...foot, y: foot.y + 1 });
			const below = this.blocks.blockAt({ ...foot, y: foot.y - 1 });
			if (at && head && below && !at.solid && !head.solid && below.solid) {
				return { x: foot.x + 0.5, y: foot.y, z: foot.z + 0.5 };
			}
		}
		// 立てる場所が分からなければ、せめて隣を狙う。
		return { x: target.x + 1, y: target.y, z: target.z };
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
	/** 今サーバーにいる人の名前。自分も含む。 */
	onlinePlayers(): string[] {
		return [...this.online];
	}

	async pillarUp(_signal: AbortSignal, count: number): Promise<number> {
		const res = await this.sidecar.send("pillar", { count }, 30_000);
		await this.refresh();
		return Number((res as any)?.placed ?? 0);
	}

	async activateBlock(position: Position): Promise<void> {
		// face に -1 を渡すと、サイドカーがプレイヤー側の面を選ぶ。
		await this.sidecar.send("activate", {
			x: position.x,
			y: position.y,
			z: position.z,
			face: -1,
		});
		// サーバーが開くまでの間。すぐ次を送ると取りこぼす。
		await sleep(400);
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
		const want = stripNamespace(itemName);

		if (destination === "hand") {
			// 直前のクラフトや採掘で持ち物が変わっている。写しが古いまま
			// スロットを選ぶと、空になった枠を持って「手に何も持っていません」
			// になる。作業台を作った直後の設置で実際に起きた。
			await this.refresh();
			// ホットバー(スロット0-8)にあるものしか持てない。
			const inHotbar = this.items.find((i) => i.name === want && i.slot >= 0 && i.slot <= 8);
			// ホットバーに無ければ諦めていた。クラフトで増えた物は空いている
			// 枠に入るので、持ち物の奥に入っていることの方が多い。実際、
			// 作った作業台やチェストが奥に入っただけで設置に失敗し、
			// 「作れているのに置けない」で連鎖が止まっていた。
			// 道具の持ち替え(equipBestTool)と同じ手順でホットバーへ移す。
			const slot = inHotbar ? inHotbar.slot : await this.moveToHotbar(want);
			if (slot === null) {
				throw new Error(`${itemName} を持っていません`);
			}
			await this.sidecar.send("hold", { count: slot });
			// サーバーが持ち替えを反映するまでの間。すぐ設置すると取りこぼす。
			await sleep(200);
			return;
		}

		// 防具は持ち替えでは着られない。防具コンテナへ移す必要がある。
		const armorSlot = ARMOR_SLOTS[destination];
		if (armorSlot === undefined) {
			notImplemented(`${destination} への装備`);
		}
		const item = this.items.find((i) => i.name === want && i.slot >= 0);
		if (!item) {
			throw new Error(`${itemName} を持っていません`);
		}
		await this.sidecar.send("wear", { names: [String(item.slot)], count: armorSlot });
		await sleep(300);
		await this.refresh();
		// 着せたものを控える。防具コンテナは読み返せないので、ここが唯一の記録。
		this.worn[armorSlot] = { name: want, count: 1, slot: -1 };
	}

	/**
	 * 持ち物の奥にあるものをホットバーへ移し、移した先のスロットを返す。
	 * 持っていなければ null。
	 */
	private async moveToHotbar(want: string): Promise<number | null> {
		const item = this.items.find((i) => i.name === want && i.slot > 8 && i.slot <= 35);
		if (!item) return null;
		// 空きがあればそこへ、無ければ使っていなさそうな末尾と入れ替える。
		const occupied = new Set(
			this.items.filter((i) => i.slot >= 0 && i.slot <= 8).map((i) => i.slot),
		);
		let target = 8;
		for (let i = 0; i <= 8; i++) {
			if (!occupied.has(i)) {
				target = i;
				break;
			}
		}
		await this.sidecar.send("moveSlot", { names: [String(item.slot)], count: target });
		await sleep(300);
		await this.refresh();
		return target;
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

		// 写しが古いと、作ったばかりの道具を見落とす。
		await this.refresh();

		const ranked = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];
		// ホットバーに限らず持ち物全体から探す。以前はホットバーだけを見ており、
		// 奥に入った道具があっても黙って素手で掘っていた。石も鉱石も素手では
		// 何も落とさないので、掘っただけで何も得られない状態になる。
		const candidates = this.items
			.filter((i) => i.slot >= 0 && i.slot <= 35 && i.name.endsWith(`_${kind}`))
			.sort((a, b) => {
				const ra = ranked.findIndex((m) => a.name.startsWith(m));
				const rb = ranked.findIndex((m) => b.name.startsWith(m));
				return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
			});
		const best = candidates[0];
		if (!best) return;

		let slot = best.slot;
		if (slot > 8) {
			// 手に持てるのはホットバーだけ。奥にあるものは移してから持つ。
			const moved = await this.moveToHotbar(best.name);
			if (moved === null) return;
			slot = moved;
		}
		await this.sidecar.send("hold", { count: slot });
		await sleep(150);
		if (process.env.BEDROCK_TRACE_TOOL === "1") {
			await this.refresh();
			const held = this.items.find((i) => i.slot === slot);
			console.log(
				`[tool] ${block.name} に ${best.name}(slot ${best.slot}) → slot ${slot}。いま持っているのは ${held?.name ?? "なし"}`,
			);
		}
	}
	/**
	 * 落ちているアイテムを拾う。
	 * 統合版は近づけば勝手に拾うので、落ちている場所へ順に歩くだけでよい。
	 */
	async pickupNearbyItems(signal: AbortSignal): Promise<void> {
		const deadline = Date.now() + 15_000;
		// 掘った直後はまだ落下物が現れていない。少し待ってから探す。
		await sleep(700);
		// 取りに行けなかったものを覚えておく。同じものを毎回選び直すと
		// 6回の試行を1個に使い切ってしまい、隣に落ちている他のものを残す。
		const unreachable = new Set<number>();
		const trace = process.env.BEDROCK_TRACE_PICKUP === "1";

		// 一度に何個も追いかけると時間切れになるので、近いものから数個まで。
		for (let i = 0; i < 6; i++) {
			if (signal.aborted || Date.now() > deadline) return;
			await this.refresh();
			const here = this.state.position;
			const items = this.entities
				.filter((e) => e.kind === "item" && !unreachable.has(e.id))
				.sort((a, b) => distance(here, a.position) - distance(here, b.position));
			const target = items[0];
			if (trace) {
				console.log(
					`[pickup] ${i}回目: 落下物 ${items.length} 個` +
						(target
							? ` 最寄り ${target.name} 距離 ${distance(here, target.position).toFixed(1)}`
							: " なし"),
				);
			}
			if (!target || distance(here, target.position) > 24) {
				// 最初の数回は現れるのを待つ。すぐ諦めると掘った物を取り逃す。
				if (i < 3) {
					await sleep(800);
					continue;
				}
				return;
			}

			try {
				// 統合版の自動回収はおよそ1ブロック。ここを緩めると、到達は
				// しやすくなるが回収範囲の外で止まり、いつまでも拾えない。
				// 実際 1.5 にしたとき、掘った土から1.7ブロック手前で止まって
				// 在庫更新が一度も来なかった。経路探索はマス目の中心にしか
				// 止まれないので、これ以上は詰められない。
				//
				// まず掘らずに行く。地形を壊さずに済むならその方がよい。
				// 駄目なら掘ってでも取りに行く。木の下は葉に囲まれていて
				// 掘らないと寄れず、実測で伐った原木9本が地面に残ったまま
				// 一つも拾えなかった。
				try {
					await this.goto(signal, {
						kind: "near",
						position: target.position,
						distance: 0.9,
					});
				} catch {
					if (signal.aborted) throw new Error("中断された");
					await this.goto(signal, {
						kind: "xz",
						x: target.position.x,
						z: target.position.z,
						distance: 0.9,
					});
				}
			} catch (e) {
				// 届かないものは飛ばして次を取りに行く。ここで return すると
				// 1つ取れなかっただけで残り全部を捨てることになる。
				if (trace) console.log(`[pickup] ${target.name} へ行けない: ${e}`);
				unreachable.add(target.id);
				continue;
			}
			// 拾われるまで少し待つ。判定はサーバー側。
			await sleep(800);
		}
	}

	async eat(_signal: AbortSignal): Promise<boolean> {
		await this.refresh();
		const food = pickFood(this.inventory.items().map((i) => i.name));
		if (!food) return false;

		const before = this.state.food;
		try {
			// 食べるのは手に持っているものなので、まず持ち替える。
			await this.equip(food, "hand");
			// 統合版の消費は「使い始め」と「使い終わり」の2段。サイドカー側で
			// 両方を送って、食べ終わるまで待ってから返す。
			const res = await this.sidecar.send("eat", {}, 10_000);
			if (!res?.ok) return false;
		} catch {
			return false;
		}

		// 満腹度はサーバーから遅れて届く。増えていなければ食べられていない
		// （満腹だった・持ち替えに失敗した）ので、成功を騙らない。
		await sleep(500);
		await this.refresh();
		return this.state.food > before;
	}

	async dropItem(itemName: string, count: number): Promise<void> {
		const want = stripNamespace(itemName);
		await this.refresh();
		await this.sidecar.send("drop", { names: [want], count }, 20_000);
		// サーバーが在庫を送り直すのを待つ。すぐ次の判断をすると、
		// 渡したはずのものがまだ手元にあるように見える。
		await sleep(300);
		await this.refresh();
	}

	async craft(itemName: string, count: number, craftingTable?: Position): Promise<void> {
		const want = stripNamespace(itemName);
		// 3x3 の枠は作業台の画面を開いている間しか使えない。位置を渡さないと
		// サイドカーは持ち物の画面しか開かず、3x3 のレシピが弾かれる。
		// 以前は真偽値だけを渡しており、どこの作業台かが伝わっていなかった。
		for (let i = 0; i < Math.max(1, count); i++) {
			await this.sidecar.send(
				"craft",
				{
					names: [want],
					value: Boolean(craftingTable),
					x: craftingTable?.x ?? 0,
					y: craftingTable?.y ?? 0,
					z: craftingTable?.z ?? 0,
				},
				20_000,
			);
			// サーバーが在庫を送り直すのを待つ。すぐ次を作ると、識別子が
			// 分からないままのスタックを素材に使って弾かれる。
			await sleep(700);
		}
		await this.refresh();
	}

	/**
	 * レシピが存在するかだけを見る。素材が足りるかは craft を試すまで分からない。
	 * 同期APIなので、接続時に取った名前一覧で答えている。
	 */
	canCraft(itemName: string, _craftingTable?: Position): boolean {
		return this.craftable.has(stripNamespace(itemName));
	}
	canSmelt(itemName: string): boolean {
		// 焼けるかどうかはレシピ表では引けない。かまどのレシピは
		// CraftingData の別枠で来るが、そこは取り込んでいない。
		// 序盤に要るものだけ名前で判断する。
		return SMELTABLE.has(stripNamespace(itemName));
	}
	async smelt(
		furnace: Position,
		input: string,
		inputCount: number,
		fuel: string,
		fuelCount: number,
	): Promise<void> {
		await this.sidecar.send(
			"smelt",
			{
				x: furnace.x,
				y: furnace.y,
				z: furnace.z,
				names: [stripNamespace(input), stripNamespace(fuel)],
				count: inputCount,
				// 燃料の数は face に載せる。専用の欄が無いので流用している。
				face: fuelCount,
			},
			20_000,
		);
		await sleep(400);
		await this.refresh();
	}
	async takeAllFromContainer(_signal: AbortSignal, position: Position): Promise<number> {
		// サイドカーが開く・移す・閉じるまでを一続きで行う。途中で放り出すと
		// コンテナが開いたままになり、次の操作が通らなくなる。
		const res = await this.sidecar.send(
			"takeAll",
			{ x: position.x, y: position.y, z: position.z },
			20_000,
		);
		await sleep(300);
		await this.refresh();
		return Number((res as any)?.moved ?? 0);
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
