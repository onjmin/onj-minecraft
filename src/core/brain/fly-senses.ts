/**
 * マイクラの出来事を、ハエの感覚ニューロンへの刺激(0..1)に置き換える。
 *
 * これは人が決めた対応表で、ハエが自分で見ているわけではない。何をどの感覚に
 * 入れたかは、判断のたびにログへ出す(隠すと、ハエらしさを人が作ったことが
 * 見えなくなる)。
 *
 *   sugar          食べられる物を持っていて腹が減っている(口元に糖がある)
 *   bitter         腐った肉しか無いのに腹が減っている(苦い物しか無い)
 *   looming_*      敵が近づいてくる(左右別。近いほど強い)
 *   touch          いま殴られた・削られた(機械感覚)
 *   odor           獲物・人・落ちている物の気配(遠いほど弱い。左右は分けない:
 *                  モデルの側で左右の受容体を分けても出力がほぼ同じだった)。
 *                  既定では脳へ送らない(fly-brain.ts の FLY_ODOR)
 *
 * 判断は入れない。数え方だけを決める。
 */
import type { EntityInfo, Position } from "../driver/types";
import { isHostileMob, PREY_NAMES } from "../mobs";
import type { SurvivalSnapshot } from "../survival/snapshot";

export type Stimuli = Record<string, number>;

/** 敵の気配を感じる距離。反射の hostilesNear と同じ。 */
export const LOOMING_RANGE = 12;
/** 匂いが届く距離。 */
export const ODOR_RANGE = 32;

/**
 * 自分から見た相手の向き(度)。正なら右、負なら左。
 *
 * 統合版の yaw は南(+Z)が 0 で、西(-X)へ向かって増える(sidecar/session.go)。
 * 南を向いていると西は右手なので、増える向きが右回り。
 */
export function relativeBearing(self: Position, yawDeg: number, target: Position): number {
	const dx = target.x - self.x;
	const dz = target.z - self.z;
	const bearing = (Math.atan2(-dx, dz) * 180) / Math.PI;
	let rel = bearing - yawDeg;
	while (rel > 180) rel -= 360;
	while (rel < -180) rel += 360;
	return rel;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 左右に分けて足す。真正面・真後ろは両方へ半分ずつ。 */
function addBySide(out: Stimuli, left: string, right: string, rel: number, strength: number): void {
	const side = Math.sin((rel * Math.PI) / 180); // -1(左)..1(右)
	out[right] = clamp01((out[right] ?? 0) + strength * (0.5 + side / 2));
	out[left] = clamp01((out[left] ?? 0) + strength * (0.5 - side / 2));
}

export function senseWorld(input: {
	snapshot: SurvivalSnapshot;
	self: Position;
	yaw: number;
	entities: EntityInfo[];
	/** 前の判断から体力が減ったか。 */
	hurt: boolean;
}): Stimuli {
	const { snapshot: s, self, yaw, entities } = input;
	const hunger = clamp01((20 - s.food) / 10);
	const out: Stimuli = {
		sugar: s.edible ? hunger : 0,
		bitter: !s.edible && s.lastResortFood ? hunger : 0,
		touch: input.hurt ? 1 : 0,
		looming_left: 0,
		looming_right: 0,
		odor: 0,
	};
	for (const e of entities) {
		const d = Math.hypot(e.position.x - self.x, e.position.y - self.y, e.position.z - self.z);
		const rel = relativeBearing(self, yaw, e.position);
		if (isHostileMob(e.name) && d <= LOOMING_RANGE) {
			addBySide(out, "looming_left", "looming_right", rel, 1 - d / LOOMING_RANGE);
		} else if (
			(PREY_NAMES.has(e.name) || e.kind === "player" || e.kind === "item") &&
			d <= ODOR_RANGE
		) {
			// 匂いは一番強い元だけで決める。足し合わせると群れの中で常に最大になる。
			out.odor = Math.max(out.odor, 0.5 * (1 - d / ODOR_RANGE));
		}
	}
	return out;
}

/** 匂いの元で一番強いもの。近づく先に使う。 */
export function strongestOdorSource(
	self: Position,
	yaw: number,
	entities: EntityInfo[],
	side: "left" | "right" | "any",
): EntityInfo | null {
	let best: { e: EntityInfo; d: number } | null = null;
	for (const e of entities) {
		if (!(PREY_NAMES.has(e.name) || e.kind === "player" || e.kind === "item")) continue;
		const d = Math.hypot(e.position.x - self.x, e.position.z - self.z);
		if (d > ODOR_RANGE) continue;
		const rel = relativeBearing(self, yaw, e.position);
		if (side === "left" && rel > 0) continue;
		if (side === "right" && rel < 0) continue;
		if (!best || d < best.d) best = { e, d };
	}
	return best?.e ?? null;
}

/** 一番近い敵。逃げる向きに使う。 */
export function nearestThreat(self: Position, entities: EntityInfo[]): EntityInfo | null {
	let best: { e: EntityInfo; d: number } | null = null;
	for (const e of entities) {
		if (!isHostileMob(e.name)) continue;
		const d = Math.hypot(e.position.x - self.x, e.position.z - self.z);
		if (d > LOOMING_RANGE) continue;
		if (!best || d < best.d) best = { e, d };
	}
	return best?.e ?? null;
}
