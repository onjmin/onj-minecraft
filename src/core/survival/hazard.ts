/**
 * 危険域。掘り荒らされて穴だらけになった区域を覚えておき、近づかない。
 *
 * 初期リスの周りは、以前ボット自身が Y=-41〜59 まで掘り抜いた穴の集まりに
 * なっている。実測 2026-09-19(9回の接続)では、時間の 90% を地表より下で
 * 過ごし、位置の 76% が初期リスから 32 ブロック以内、落下死は全部その真下
 * だった。そこへ戻す力が3つある。探索半径が狭い、自分の残骸(作業台・板)を
 * 目印として覚えている、寝床が初期リスにある。
 *
 * ここは「どこが危険域か」と「どう出るか」の計算だけを持つ。世界も時刻も
 * 触らないので、サーバー無しで試せる。どこに区域があるかは agent が
 * logs/hazard-zones.json に持ち、落下死が固まった場所を自動で足す。
 */
export interface HazardZone {
	readonly x: number;
	readonly z: number;
	readonly radius: number;
	readonly reason: string;
}

/** 落下死の記録。区域を自動で足すために覚える。 */
export interface FallDeath {
	readonly x: number;
	readonly z: number;
	readonly at: number;
}

/** 区域の縁からこれだけ離れれば「出た」とみなす。 */
export const HAZARD_EXIT_MARGIN = 16;
/** この距離の中で落下死がこの回数固まったら、そこは穴だらけ。 */
export const FALL_CLUSTER_RADIUS = 24;
export const FALL_CLUSTER_MIN = 2;
/** 自動で足す区域の半径。クレーターは死亡地点より広がっている。 */
export const FALL_ZONE_RADIUS = 40;
/** 落下死を覚えておく期間。古い穴は誰かが埋めているかもしれない。 */
export const FALL_DEATH_TTL_MS = 7 * 24 * 60 * 60_000;

/** その位置を含む区域。複数に入っているなら中心が一番近いもの。無ければ null。 */
export function hazardAt(
	zones: readonly HazardZone[],
	pos: { x: number; z: number },
): HazardZone | null {
	let best: HazardZone | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const z of zones) {
		const d = Math.hypot(pos.x - z.x, pos.z - z.z);
		if (d <= z.radius && d < bestDist) {
			best = z;
			bestDist = d;
		}
	}
	return best;
}

/**
 * 区域から出る先。中心から自分を通る向きに、縁より margin だけ外。
 *
 * 中心にぴったり立っているなら向きが決まらないので +X へ出る。
 * 出た先が別の区域の中なら、そちらの外まで押し出す(2回まで)。
 */
export function hazardExit(
	zones: readonly HazardZone[],
	zone: HazardZone,
	pos: { x: number; z: number },
	margin = HAZARD_EXIT_MARGIN,
): { x: number; z: number } {
	let vx = pos.x - zone.x;
	let vz = pos.z - zone.z;
	const len = Math.hypot(vx, vz);
	if (len < 0.5) {
		vx = 1;
		vz = 0;
	} else {
		vx /= len;
		vz /= len;
	}
	let out = {
		x: Math.round(zone.x + vx * (zone.radius + margin)),
		z: Math.round(zone.z + vz * (zone.radius + margin)),
	};
	for (let i = 0; i < 2; i++) {
		const other = hazardAt(zones, out);
		if (!other || other === zone) break;
		out = {
			x: Math.round(other.x + vx * (other.radius + margin)),
			z: Math.round(other.z + vz * (other.radius + margin)),
		};
	}
	return out;
}

/**
 * 落下死を1件足し、固まっていれば区域にする。
 *
 * 既にある区域の中で落ちたなら、その区域を落下地点まで広げる(縁の近くで
 * 落ちたなら縁がもっと外にある)。区域の外で、近くに別の落下死があれば、
 * それらの重心に新しい区域を置く。
 */
export function noteFallDeath(
	zones: readonly HazardZone[],
	deaths: readonly FallDeath[],
	death: FallDeath,
): { zones: HazardZone[]; deaths: FallDeath[]; added: HazardZone | null } {
	const kept = deaths.filter((d) => death.at - d.at < FALL_DEATH_TTL_MS);
	const nextDeaths = [...kept, death];
	const nextZones = zones.slice();

	const inside = hazardAt(nextZones, death);
	if (inside) {
		const d = Math.hypot(death.x - inside.x, death.z - inside.z);
		const need = Math.ceil(d + FALL_CLUSTER_RADIUS / 2);
		if (need > inside.radius) {
			const idx = nextZones.indexOf(inside);
			nextZones[idx] = { ...inside, radius: need };
		}
		return { zones: nextZones, deaths: nextDeaths, added: null };
	}

	const cluster = nextDeaths.filter(
		(d) => Math.hypot(d.x - death.x, d.z - death.z) <= FALL_CLUSTER_RADIUS,
	);
	if (cluster.length < FALL_CLUSTER_MIN) {
		return { zones: nextZones, deaths: nextDeaths, added: null };
	}
	const cx = Math.round(cluster.reduce((s, d) => s + d.x, 0) / cluster.length);
	const cz = Math.round(cluster.reduce((s, d) => s + d.z, 0) / cluster.length);
	const added: HazardZone = {
		x: cx,
		z: cz,
		radius: FALL_ZONE_RADIUS,
		reason: `落下死が${cluster.length}回固まった`,
	};
	nextZones.push(added);
	return { zones: nextZones, deaths: nextDeaths, added };
}

/** 保存ファイルの形。壊れていても落ちないように、読む側で形を確かめる。 */
export interface HazardFile {
	zones: HazardZone[];
	fallDeaths: FallDeath[];
}

export function parseHazardFile(raw: unknown): HazardFile {
	const out: HazardFile = { zones: [], fallDeaths: [] };
	if (!raw || typeof raw !== "object") return out;
	const r = raw as { zones?: unknown; fallDeaths?: unknown };
	if (Array.isArray(r.zones)) {
		for (const z of r.zones) {
			if (
				z &&
				typeof z.x === "number" &&
				typeof z.z === "number" &&
				typeof z.radius === "number" &&
				z.radius > 0
			) {
				out.zones.push({ x: z.x, z: z.z, radius: z.radius, reason: String(z.reason ?? "") });
			}
		}
	}
	if (Array.isArray(r.fallDeaths)) {
		for (const d of r.fallDeaths) {
			if (d && typeof d.x === "number" && typeof d.z === "number" && typeof d.at === "number") {
				out.fallDeaths.push({ x: d.x, z: d.z, at: d.at });
			}
		}
	}
	return out;
}
