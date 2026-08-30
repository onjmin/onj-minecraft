/**
 * サイドカーから受け取った周辺ブロックの写し。
 *
 * BotDriver の WorldReader は同期APIなので、ブロックを引くたびにサイドカーへ
 * 問い合わせるわけにいかない。周辺を立方体でまとめて受け取り、こちらで展開して
 * 同期的に答える。
 *
 * 未取得のマスは「空気」ではなく null を返す。空気と答えると、skills/ が
 * 「そこには何も無い」と解釈して空中に足場を作ろうとする。分からないことは
 * 分からないままにする。
 */
import type { BlockInfo, Position } from "./types";

/** 当たり判定を持たない、通り抜けられるブロック。足場判定に使う。 */
const PASSABLE = new Set([
	"air",
	"cave_air",
	"void_air",
	"water",
	"flowing_water",
	"lava",
	"flowing_lava",
	"short_grass",
	"tall_grass",
	"fern",
	"large_fern",
	"dead_bush",
	"seagrass",
	"vine",
	"snow_layer",
	"torch",
	"soul_torch",
	"redstone_torch",
	"rail",
	"ladder",
]);

/** 素手でも掘れないブロック。掘ろうとして無限に粘るのを防ぐ。 */
const UNBREAKABLE = new Set([
	"bedrock",
	"barrier",
	"command_block",
	"structure_block",
	"end_portal_frame",
	"air",
	"cave_air",
	"void_air",
	"water",
	"flowing_water",
	"lava",
	"flowing_lava",
]);

export interface SnapshotPayload {
	origin: number[];
	size: number;
	palette: string[];
	/** uint16 のリトルエンディアン列を base64 にしたもの。並びは x → y → z。 */
	data: string;
}

export class BlockView {
	private ox = 0;
	private oy = 0;
	private oz = 0;
	private size = 0;
	private palette: string[] = [];
	private indices: Uint16Array = new Uint16Array(0);
	/** 最後に受け取った時刻。古くなったら取り直す判断に使う。 */
	public updatedAt = 0;
	/**
	 * 中身の分かっているマスの数。
	 * 接続直後はサブチャンクがまだ届いておらず 0 になる。0 のまま待つと
	 * world.* が延々 null を返すので、呼び出し側が取り直す判断に使う。
	 */
	public knownCount = 0;
	public center: Position = { x: 0, y: 0, z: 0 };

	get ready(): boolean {
		return this.size > 0;
	}

	load(snap: SnapshotPayload): void {
		const [ox, oy, oz] = snap.origin;
		this.ox = ox;
		this.oy = oy;
		this.oz = oz;
		this.size = snap.size;
		this.palette = snap.palette;
		const raw = Buffer.from(snap.data, "base64");
		// Buffer はプールされた ArrayBuffer の一部を指しており、byteOffset が
		// 奇数になりうる。Uint16Array は2バイト境界を要求するので、そのまま
		// 被せると RangeError になる。専用の領域へ写してから読む。
		this.indices = new Uint16Array(raw.length / 2);
		for (let i = 0; i < this.indices.length; i++) {
			this.indices[i] = raw.readUInt16LE(i * 2);
		}
		let known = 0;
		for (let i = 0; i < this.indices.length; i++) {
			if (this.indices[i] !== 0) known++;
		}
		this.knownCount = known;
		this.updatedAt = Date.now();
		const half = (this.size - 1) / 2;
		this.center = { x: ox + half, y: oy + half, z: oz + half };
	}

	/** name が空文字なら未取得のマス。 */
	private nameAt(x: number, y: number, z: number): string | null {
		if (!this.ready) return null;
		const dx = x - this.ox;
		const dy = y - this.oy;
		const dz = z - this.oz;
		if (dx < 0 || dy < 0 || dz < 0) return null;
		if (dx >= this.size || dy >= this.size || dz >= this.size) return null;
		const i = (dx * this.size + dy) * this.size + dz;
		const name = this.palette[this.indices[i]] ?? "";
		return name === "" ? null : name;
	}

	blockAt(position: Position): BlockInfo | null {
		const x = Math.floor(position.x);
		const y = Math.floor(position.y);
		const z = Math.floor(position.z);
		const name = this.nameAt(x, y, z);
		if (name === null) return null;
		return {
			name,
			position: { x, y, z },
			diggable: !UNBREAKABLE.has(name),
			solid: !PASSABLE.has(name),
		};
	}

	/**
	 * 述語に合うブロックを近い順に返す。
	 * 距離順の立方体シェルで回すので、count が小さければ全走査にならない。
	 */
	findMatching(
		from: Position,
		predicate: (name: string) => boolean,
		maxDistance: number,
		count: number,
	): BlockInfo[] {
		if (!this.ready) return [];
		const ox = Math.floor(from.x);
		const oy = Math.floor(from.y);
		const oz = Math.floor(from.z);
		const r = Math.min(Math.floor(maxDistance), (this.size - 1) / 2);
		const out: BlockInfo[] = [];

		for (let d = 0; d <= r; d++) {
			for (let dx = -d; dx <= d; dx++) {
				for (let dy = -d; dy <= d; dy++) {
					for (let dz = -d; dz <= d; dz++) {
						// シェルの表面だけを見る。内側は前の d で見終わっている。
						if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== d) continue;
						const x = ox + dx;
						const y = oy + dy;
						const z = oz + dz;
						const name = this.nameAt(x, y, z);
						if (name === null || !predicate(name)) continue;
						out.push({
							name,
							position: { x, y, z },
							diggable: !UNBREAKABLE.has(name),
							solid: !PASSABLE.has(name),
						});
						if (out.length >= count) return out;
					}
				}
			}
		}
		return out;
	}
}
