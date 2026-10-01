/**
 * どこを歩いたか・どの高さにいたかの記憶。
 *
 * 判断はしない。「どこが未踏か」「登っているのか行き来しているのか」を
 * 事実として返し、使うのは SITUATION(LLM)と explore の向き(スキル)。
 *
 * 2026-10-01 に agent.ts から切り出した。中身は動かしていない。
 */
import fs from "node:fs";
import path from "node:path";
import type { Position } from "../driver/types";

/** 訪れた格子の控え。 */
const VISITS_FILE = "logs/visited.json";
/** 訪問を数える格子の一辺。 */
const VISIT_CELL = 32;
/** 初期リス(危険域の種)。未踏の遠さを測る原点。 */
const SPAWN_X = 6;
const SPAWN_Z = 66;
/**
 * 未踏の方向を測る設定。初期リスを中心に 8 方位を見て、その扇形(半径 64 より
 * 外)への訪問が一番少ない方位を「未踏」とし、目標点は「これまでの最大到達距離
 * + FRONTIER_STEP」の先に置く。行けば行くほど輪が広がる。固定座標ではない
 * (「±300 は一例」オーナー 2026-09-21)。
 */
const FRONTIER_DIRECTIONS = 8;
const FRONTIER_STEP = 150;
const FRONTIER_MIN_RADIUS = 200;
const FRONTIER_MAX_RADIUS = 800;
const FRONTIER_NEAR_IGNORE = 64;

export type Frontier = {
	target: { x: number; z: number };
	visitsNear: number;
	farthest: number;
};

export type HeightTrend = {
	minutes: number;
	from: number;
	to: number;
	low: number;
	high: number;
};

export class ExplorationMemory {
	/** 高さの推移。5秒ごとの反射で足す。「登っているのか行き来しているのか」を LLM に見せる。 */
	private heightSamples: { at: number; y: number }[] = [];
	/**
	 * 訪れた場所(32 ブロック格子)と回数。どこが未踏かを LLM に見せるため。
	 *
	 * 実測 2026-09-20〜21、位置の 87% が初期リスから 100 ブロック以内、200 を
	 * 超えた記録は無い。羊に出会えないのは範囲が狭いから、というオーナーの
	 * 指摘(300,±300 の四隅に資源がありそう)を受けて入れた。
	 */
	private visitCells = new Map<string, number>();
	private visitsDirty = false;
	private lastVisitSaveAt = 0;

	/** 高さを控える。15分ぶん持つ。あわせて訪れた格子も数える。 */
	sample(pos: Position): void {
		const now = Date.now();
		this.noteVisit(pos, now);
		this.heightSamples.push({ at: now, y: Math.floor(pos.y) });
		const cutoff = now - 15 * 60_000;
		while (this.heightSamples.length > 0 && this.heightSamples[0].at < cutoff) {
			this.heightSamples.shift();
		}
	}

	/** 訪れた格子を数える。60 秒ごとにディスクへ控える(再起動しても未踏の判断が続く)。 */
	private noteVisit(pos: Position, now: number): void {
		const key = `${Math.floor(pos.x / VISIT_CELL)},${Math.floor(pos.z / VISIT_CELL)}`;
		this.visitCells.set(key, (this.visitCells.get(key) ?? 0) + 1);
		this.visitsDirty = true;
		if (now - this.lastVisitSaveAt > 60_000) {
			this.lastVisitSaveAt = now;
			this.save();
		}
	}

	private save(): void {
		if (!this.visitsDirty) return;
		this.visitsDirty = false;
		try {
			const file = path.join(process.cwd(), VISITS_FILE);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ cell: VISIT_CELL, visits: [...this.visitCells] }));
		} catch {
			// 書けなくても行動は続く。
		}
	}

	load(): void {
		try {
			const file = path.join(process.cwd(), VISITS_FILE);
			if (!fs.existsSync(file)) return;
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			if (raw?.cell !== VISIT_CELL || !Array.isArray(raw.visits)) return;
			for (const [k, n] of raw.visits) {
				if (typeof k === "string" && typeof n === "number") this.visitCells.set(k, n);
			}
		} catch {
			// 壊れていたら無かったことにする。
		}
	}

	/**
	 * 未踏の方向と、そこに置く目標点。初期リスから見た 8 方位のうち、扇形
	 * (半径 64 より外)への訪問が一番少ないものを選び、目標点は最大到達距離
	 * + 150 の先(200〜800 に収める)。同数なら今いる場所から近い方。スキル
	 * (explore の向き)と SITUATION の両方が使う。
	 */
	frontier(here: Position): Frontier | null {
		if (this.visitCells.size === 0) return null;
		const cells = [...this.visitCells].map(([k, n]) => {
			const [cx, cz] = k.split(",").map(Number);
			return { x: cx * VISIT_CELL + VISIT_CELL / 2, z: cz * VISIT_CELL + VISIT_CELL / 2, n };
		});
		let farthest = 0;
		for (const c of cells) {
			farthest = Math.max(farthest, Math.hypot(c.x - SPAWN_X, c.z - SPAWN_Z));
		}
		const radius = Math.min(
			FRONTIER_MAX_RADIUS,
			Math.max(FRONTIER_MIN_RADIUS, Math.round(farthest + FRONTIER_STEP)),
		);
		const sector = (2 * Math.PI) / FRONTIER_DIRECTIONS;
		let best: { target: { x: number; z: number }; visitsNear: number; near: number } | null = null;
		for (let i = 0; i < FRONTIER_DIRECTIONS; i++) {
			const angle = i * sector;
			const target = {
				x: Math.round(SPAWN_X + Math.cos(angle) * radius),
				z: Math.round(SPAWN_Z + Math.sin(angle) * radius),
			};
			// この方位の扇形にどれだけ行ったか。初期リスのすぐ周りは全方位に
			// 数えられてしまうので、半径 64 より外だけ見る。
			let visitsNear = 0;
			for (const c of cells) {
				const dx = c.x - SPAWN_X;
				const dz = c.z - SPAWN_Z;
				if (Math.hypot(dx, dz) <= FRONTIER_NEAR_IGNORE) continue;
				let diff = Math.atan2(dz, dx) - angle;
				while (diff > Math.PI) diff -= 2 * Math.PI;
				while (diff < -Math.PI) diff += 2 * Math.PI;
				if (Math.abs(diff) <= sector / 2) visitsNear += c.n;
			}
			const near = Math.hypot(target.x - here.x, target.z - here.z);
			if (
				!best ||
				visitsNear < best.visitsNear ||
				(visitsNear === best.visitsNear && near < best.near)
			) {
				best = { target, visitsNear, near };
			}
		}
		return best
			? { target: best.target, visitsNear: best.visitsNear, farthest: Math.round(farthest) }
			: null;
	}

	/** 直近の高さの推移。地下で行き来しているかを LLM に見せる材料。 */
	heightTrend(): HeightTrend | null {
		if (this.heightSamples.length < 2) return null;
		const first = this.heightSamples[0];
		const last = this.heightSamples[this.heightSamples.length - 1];
		const minutes = Math.round((last.at - first.at) / 60_000);
		if (minutes < 3) return null;
		let low = Number.POSITIVE_INFINITY;
		let high = Number.NEGATIVE_INFINITY;
		for (const s of this.heightSamples) {
			if (s.y < low) low = s.y;
			if (s.y > high) high = s.y;
		}
		return { minutes, from: first.y, to: last.y, low, high };
	}
}
