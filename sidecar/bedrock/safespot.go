package main

// 既知の安全地帯。逃走時に「敵の反対方向へ走るだけ」ではなく、村・ベッド・
// 誰かの拠点など「実際に逃げ込める場所」があればそこを目指すための記録。
//
// 記録元は3つ:
//   - チャンク解析でベッドを見つけたとき(storeChunk)
//   - 村人の存在を確認したとき(AddActor)
//   - TypeScript 側のスキルが訪問時に明示的に記録したとき(safe_spot_add コマンド)
//
// 部屋の自動検出のような大掛かりな構造物認識はしない。ここでやるのは
// 「座標を覚えておいて、近ければ優先してそこへ向かう」だけ。

import (
	"time"

	"github.com/go-gl/mathgl/mgl32"
)

// safeSpot は覚えている安全地帯ひとつぶん。
type safeSpot struct {
	Pos    mgl32.Vec3
	Source string // "bed" | "village" | "manual" など。診断とdedup判定に使う。
	Added  time.Time
}

// 同じ場所の重複記録を避ける距離。これより近い既存の点があれば足さない。
// 村1つ・拠点1つを何百点にも分裂させないため。
const safeSpotDedupRadius = float32(20)

// 覚えておく上限。無限に増やすと毎tickの走査が重くなる。
// 全部埋まったら一番古いものを捨てる。
const maxSafeSpots = 64

// 逃走中に目指す対象として検討する距離。これより遠いものは、走って
// たどり着く前に力尽きる・別の敵に遭遇する可能性の方が高い。
const safeSpotSeekRange = float32(48)

// 着いたとみなす距離。
const safeSpotArriveRange = float32(4)

// addSafeSpotLocked は安全地帯を記録する。近くに既存の点があれば無視する。
// 呼び出し側が mu を持つこと。
func (s *session) addSafeSpotLocked(pos mgl32.Vec3, source string) {
	for _, sp := range s.safeSpots {
		if sp.Pos.Sub(pos).Len() < safeSpotDedupRadius {
			return
		}
	}
	if len(s.safeSpots) >= maxSafeSpots {
		// 一番古いものを捨てる。s.safeSpots は追加順なので先頭が最古。
		s.safeSpots = s.safeSpots[1:]
	}
	s.safeSpots = append(s.safeSpots, safeSpot{Pos: pos, Source: source, Added: time.Now()})
}

// nearestSafeSpotLocked は自分から一番近い安全地帯を返す。無ければ ok=false。
// 呼び出し側が mu を持つこと。
func (s *session) nearestSafeSpotLocked(from mgl32.Vec3, maxRange float32) (safeSpot, bool) {
	var best safeSpot
	bestDist := maxRange
	found := false
	for _, sp := range s.safeSpots {
		d := sp.Pos.Sub(from).Len()
		if d < bestDist {
			bestDist = d
			best = sp
			found = true
		}
	}
	return best, found
}

// bedNames はベッドのブロック名。色ごとに別名(white_bed, red_bed, ...)なので
// 接頭辞ではなく末尾で見る。
func isBedBlockName(name string) bool {
	return len(name) >= 4 && name[len(name)-4:] == "_bed"
}

// scanChunkForBedsLocked は届いたばかりのサブチャンクからベッドを探し、
// 見つかれば安全地帯として覚える。
//
// 4096マスの総当たりだが、これはサブチャンクが届いた瞬間に1回だけ走る処理で、
// tick ループの中身ではない。パレットにベッドが無ければ即座に抜けるので、
// ベッドの無い大半のサブチャンクではほぼコストが無い。
// 呼び出し側が mu を持つこと。
func (s *session) scanChunkForBedsLocked(cx, cz int32, sc subChunk) {
	if len(sc.Storages) == 0 {
		return
	}
	st := &sc.Storages[0]

	// まずパレットにベッドがあるかだけを見る。無ければ探す意味が無い。
	bedIdx := map[uint16]bool{}
	if len(st.PaletteNames) > 0 {
		for i, n := range st.PaletteNames {
			if isBedBlockName(trimNamespace(n)) {
				bedIdx[uint16(i)] = true
			}
		}
	} else {
		for i, id := range st.Palette {
			if name, ok := blockNameFor(id); ok && isBedBlockName(name) {
				bedIdx[uint16(i)] = true
			}
		}
	}
	if len(bedIdx) == 0 {
		return
	}

	baseX := cx * 16
	baseZ := cz * 16
	baseY := int32(sc.Index) * 16
	for x := 0; x < 16; x++ {
		for z := 0; z < 16; z++ {
			for y := 0; y < 16; y++ {
				if !bedIdx[st.indexAt(x, y, z)] {
					continue
				}
				pos := mgl32.Vec3{
					float32(baseX+int32(x)) + 0.5,
					float32(baseY + int32(y)),
					float32(baseZ+int32(z)) + 0.5,
				}
				s.addSafeSpotLocked(pos, "bed")
				// 1つ見つければそのベッド周りは十分。同じサブチャンク内の
				// 残りのマスまで舐める必要は無い。
				return
			}
		}
	}
}

// villagerSafeSpotLocked は村人を見かけたら、その周辺を村(=安全地帯の候補)
// として覚える。呼び出し側が mu を持つこと。
func (s *session) villagerSafeSpotLocked(name string, pos mgl32.Vec3) {
	if !isVillagerName(name) {
		return
	}
	s.addSafeSpotLocked(pos, "village")
}

func isVillagerName(name string) bool {
	return name == "villager" || name == "villager_v2" || name == "wandering_trader"
}

// safeSpotDirectionHelpsLocked は、逃げたい方向(away)に対して、その安全地帯へ
// 向かうことが実質的に「敵から離れる」ことにもなっているかを見る。
//
// 単純に一番近い安全地帯へ直行させると、敵をはさんで反対側にある場合に
// 敵へ突っ込むことになりかねない。内積で大まかに同じ向きかどうかだけ確認する。
func safeSpotDirectionHelps(from, spot mgl32.Vec3, away mgl32.Vec2) bool {
	toSpot := mgl32.Vec2{spot[0] - from[0], spot[2] - from[2]}
	if toSpot.Len() < 0.01 || away.Len() < 0.01 {
		return true
	}
	cos := toSpot.Normalize().Dot(away.Normalize())
	// 90度以内(概ね敵から遠ざかる向き)なら許容する。
	return cos > 0
}
