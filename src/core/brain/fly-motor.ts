/**
 * ハエの出力ニューロンの発火を、マイクラのスキルに置き換える。
 *
 * 感覚(fly-senses.ts)と同じく人が決めた対応表。ハエの脳が選ぶのは
 * 「食べる・逃げる・歩く・下がる・身繕い」のどれかと左右の偏りまでで、
 * どのスキルで実現するかはここで決める。木を集める・道具を作るといった
 * 対応はハエの行動に無いので、ハエのモードでは選ばれない。
 */
import type { EntityInfo, Position } from "../driver/types";
import { nearestThreat, relativeBearing, strongestOdorSource } from "./fly-senses";
import type { Decision, OfferedSkill } from "./types";

/** 出力グループ名(fly/brain.py の outputs と揃える)。 */
export type MotorRates = Record<string, number>;

/** 行動の型。どの出力グループが勝ったか。 */
export type MotorProgram = "feed" | "escape" | "walk" | "back" | "groom" | "still";

/** これを超えて初めて「動いた」とみなす平均発火率(Hz)。 */
export const ACTIVE_HZ = Number(process.env.FLY_ACTIVE_HZ ?? 1);

const PROGRAMS: [string, MotorProgram][] = [
	["escape", "escape"],
	["feed", "feed"],
	["walk_forward", "walk"],
	["walk_backward", "back"],
	["groom", "groom"],
];

/**
 * 一番強く発火したグループを選ぶ。どれも閾値に届かなければ still。
 *
 * グループ間の大小をそのまま比べるのは乱暴だが(ニューロン数も発火の
 * 癖も違う)、どれを採ったかは必ず数字と一緒にログへ出すので、後から
 * 正規化を足せる。左右の偏り(turn)は -1(左)..1(右)。
 */
export function readMotor(rates: MotorRates): {
	program: MotorProgram;
	winner: string | null;
	turn: number;
} {
	let winner: string | null = null;
	let program: MotorProgram = "still";
	let best = ACTIVE_HZ;
	for (const [group, p] of PROGRAMS) {
		const r = rates[group] ?? 0;
		if (r > best) {
			best = r;
			winner = group;
			program = p;
		}
	}
	const left = rates.turn_left ?? 0;
	const right = rates.turn_right ?? 0;
	const turn = left + right > 0 ? (right - left) / (left + right) : 0;
	// 旋回(DNa01/02)も歩行の指令として順位に入れる。前進の DNp09 はこのモデルでは
	// どの入力でもほぼ 0 Hz で、旋回が歩行のほとんど唯一の出口になっている。
	// 入れないと、旋回 45Hz・身繕い 13Hz で身繕いが勝ち、ずっと止まっていた
	// (実測 2026-10-01 BRAIN=fly baseline)。
	if (Math.max(left, right) > best) {
		winner = left >= right ? "turn_left" : "turn_right";
		program = "walk";
	}
	return { program, winner, turn };
}

/** 自分の向きを基準に、前後左右へ dist ブロック先の地点。 */
function pointToward(self: Position, yawDeg: number, relDeg: number, dist: number) {
	const a = ((yawDeg + relDeg) * Math.PI) / 180;
	// yaw の前方は (-sin, cos)(fly-senses.ts の relativeBearing と同じ取り方)。
	return { x: Math.round(self.x - Math.sin(a) * dist), z: Math.round(self.z + Math.cos(a) * dist) };
}

export function motorToDecision(input: {
	program: MotorProgram;
	turn: number;
	self: Position;
	yaw: number;
	entities: EntityInfo[];
	offered: OfferedSkill[];
	summary: string;
}): Decision {
	const { program, turn, self, yaw, entities, summary } = input;
	const usable = new Set(input.offered.filter((s) => s.blocked === null).map((s) => s.name));
	const can = (name: string) => usable.has(name);
	const act = (name: string, args: Record<string, unknown> = {}, why = ""): Decision => ({
		action: { name, args },
		// 構えは毎回言い直す。逃げたあと flee のまま残すと、殴り返す場面でも逃げる。
		stance: "auto",
		memory: `${summary} → ${program}${why ? `: ${why}` : ""}`,
	});
	// 止まる。survival.rest はハエのときだけ一覧に足される(fly-brain.ts)。
	const rest = (why: string): Decision => act("survival.rest", {}, why);

	switch (program) {
		case "feed":
			if (can("survival.eat")) return act("survival.eat", {}, "口吻を伸ばした");
			return rest("口吻を伸ばしたが、食べられる物が無い");
		case "escape": {
			// 一番近い敵の反対へ跳ぶ。敵が見えなければ真後ろへ。
			const threat = nearestThreat(self, entities);
			const away = threat ? relativeBearing(self, yaw, threat.position) + 180 : 180;
			const to = pointToward(self, yaw, away, 12);
			return {
				...act(
					"goto.coords",
					{ x: to.x, z: to.z },
					threat ? `${threat.name} から離れる` : "後ろへ",
				),
				stance: "flee",
			};
		}
		case "back": {
			const to = pointToward(self, yaw, 180, 6);
			return act("goto.coords", { x: to.x, z: to.z }, "後ずさり");
		}
		case "walk": {
			// 曲がる側に匂いの元があれば、そちらへ寄る。無ければ歩き回る。
			const side = turn > 0.2 ? "right" : turn < -0.2 ? "left" : "any";
			const src = strongestOdorSource(self, yaw, entities, side);
			if (src?.kind === "item" && can("collecting.pickup")) {
				return act("collecting.pickup", {}, `${src.name} の匂いへ`);
			}
			if (src?.kind === "player" && can("goto.player")) {
				return act("goto.player", {}, `${src.username ?? src.name} の気配へ`);
			}
			if (src) {
				return act(
					"goto.coords",
					{ x: Math.round(src.position.x), z: Math.round(src.position.z) },
					`${src.name} の匂いへ`,
				);
			}
			if (Math.abs(turn) > 0.2) {
				const to = pointToward(self, yaw, turn > 0 ? 60 : -60, 16);
				return act("goto.coords", { x: to.x, z: to.z }, turn > 0 ? "右へ曲がる" : "左へ曲がる");
			}
			if (can("exploring.explore_land")) return act("exploring.explore_land", {}, "歩き回る");
			return rest("歩く先が無い");
		}
		case "groom":
			return rest("身繕い(その場に留まる)");
		default:
			return rest("運動ニューロンが黙っている");
	}
}
