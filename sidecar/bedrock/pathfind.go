package main

// ブロックを見ながらの経路探索。
//
// 歩ける道だけを探すと、壁に囲まれた場所や谷の向こうへは永久に辿り着けない。
// 1歩ごとに「歩く / 跳ぶ / 落ちる / 掘って抜ける / 足場を置いて渡る」のどれかを
// 選べるようにして、泥臭い手段も経路の一部として扱う。
//
// 探索は立ち位置(足元の座標)を節点とする A*。移動できるかは
//   足元が通れる / 頭上が通れる / その下が固い
// の3つで判定する。未取得のマスは通れない扱いにする。空気と見なして進むと、
// 読み込みが追いつかない方向へ突っ込んで落ちる。

import (
	"container/heap"
	"math"
)

type blockPos struct{ X, Y, Z int32 }

// 1歩の種類。実行側はこれを見て、歩く前に掘る/置くを挟む。
const (
	stepWalk   = iota // そのまま歩く
	stepJump          // 1段上がる
	stepFall          // 落ちる
	stepDig           // 塞いでいるブロックを壊してから進む
	stepBridge        // 足場が無いので置いてから進む
	stepTower         // 跳んで足元に置き、1段上がる（柱積み）
	stepSwim          // 水の中を進む（足場は要らない）
	stepSwimUp        // 水の中を浮上して1段上がる
)

type step struct {
	// Pos は移動後の立ち位置(足元)。
	Pos    blockPos
	Action int
	// Dig は進む前に壊すブロック。stepDig でのみ埋まる。
	Dig []blockPos
	// Fill は進む前に埋めるブロック。stepBridge でのみ埋まる。
	Fill blockPos
}

// caps はボットにできること。手持ちや道具で経路の選択肢が変わる。
type caps struct {
	// CanDig が false なら掘る手は使わない。
	CanDig bool
	// Blocks は足場に使えるブロックの数。0 なら橋は架けない。
	Blocks int
}

// 通り抜けられるブロック。TypeScript 側の blockview.ts と揃えてある。
var passableBlocks = map[string]bool{
	"air": true, "cave_air": true, "void_air": true,
	"water": true, "flowing_water": true,
	"short_grass": true, "tall_grass": true, "fern": true, "large_fern": true,
	"dead_bush": true, "seagrass": true, "vine": true, "snow_layer": true,
	"torch": true, "soul_torch": true, "redstone_torch": true,
	"rail": true, "wheat": true, "carrots": true, "potatoes": true,
	"red_flower": true, "yellow_flower": true, "sapling": true,
}

// 上に乗ってはいけないもの。通れるかどうかとは別に、足場にすると死ぬ。
var hazardBlocks = map[string]bool{
	"lava": true, "flowing_lava": true, "fire": true, "soul_fire": true,
	"magma": true, "cactus": true, "sweet_berry_bush": true,
	// 焚き火も踏めば燃える。拠点の中にあることが多く、実際に拠点の
	// チェストへ向かう途中で焼け死んでいる(2026-09-13 15:06)。
	"campfire": true, "soul_campfire": true,
	// 落ちれば出られない。
	"powder_snow": true,
}

// 壊せないもの。掘る手を選ぶ前に除く。
var undiggableBlocks = map[string]bool{
	"bedrock": true, "barrier": true, "command_block": true,
	"structure_block": true, "end_portal_frame": true, "obsidian": true,
	"water": true, "flowing_water": true, "lava": true, "flowing_lava": true,
}

func (w *world) passable(p blockPos) bool {
	name, ok := w.blockAt(p.X, p.Y, p.Z)
	if !ok {
		// 未取得は通れないものとして扱う。空気と決めつけて進むより安全。
		return false
	}
	return passableBlocks[name]
}

// diggable は壊して通れるようにできるか。未取得は触らない。
func (w *world) diggable(p blockPos) bool {
	name, ok := w.blockAt(p.X, p.Y, p.Z)
	if !ok {
		return false
	}
	return !passableBlocks[name] && !undiggableBlocks[name] && !hazardBlocks[name]
}

// solidFloor はそこに立ったときの足場として使えるか。
func (w *world) solidFloor(p blockPos) bool {
	name, ok := w.blockAt(p.X, p.Y, p.Z)
	if !ok || hazardBlocks[name] {
		return false
	}
	return !passableBlocks[name]
}

// inWater はそこが水の中か。
//
// 水の中では足場が要らない。立てなくても浮いて進めるし、跳べば上がれる。
// これを扱えないと、水路や滝を一切使えない。実測 2026-09-13、水を伝って
// 上がれないために、地下から出る手が「掘る」か「柱積み」しか無かった。
func (w *world) inWater(p blockPos) bool {
	name, ok := w.blockAt(p.X, p.Y, p.Z)
	return ok && (name == "water" || name == "flowing_water")
}

// standable はそこに立てるか。足元と頭上が空いていて、その下が足場であること。
func (w *world) standable(p blockPos) bool {
	if !w.passable(p) || !w.passable(blockPos{p.X, p.Y + 1, p.Z}) {
		return false
	}
	return w.solidFloor(blockPos{p.X, p.Y - 1, p.Z})
}

type pathNode struct {
	pos   blockPos
	g, f  float64
	index int
}

type nodeQueue []*pathNode

func (q nodeQueue) Len() int           { return len(q) }
func (q nodeQueue) Less(i, j int) bool { return q[i].f < q[j].f }
func (q nodeQueue) Swap(i, j int)      { q[i], q[j] = q[j], q[i]; q[i].index = i; q[j].index = j }
func (q *nodeQueue) Push(x any)        { n := x.(*pathNode); n.index = len(*q); *q = append(*q, n) }
func (q *nodeQueue) Pop() any          { old := *q; n := old[len(old)-1]; *q = old[:len(old)-1]; return n }

// 落ちてよい高さ。これを超える段差は経路に含めない。
const maxDrop = 3

// 行動の重み。掘るのも置くのも時間がかかるので、歩ける道があればそちらを選ぶ。
const (
	costWalk = 1.0
	costJump = 1.5
	costFall = 1.2
	// 泳ぐのは歩くより遅いが、柱積み(置く)や掘るよりはずっと速い。
	costSwim   = 2.0
	costDig    = 5.0 // 1ブロックあたり
	costBridge = 4.0
)

// findPath は from から goal へ行ける手順を返す。見つからなければ nil。
// maxNodes は tick を止めないための上限。
func (w *world) findPath(from, goal blockPos, tolerance float64, maxNodes int, c caps) []step {
	h := func(p blockPos) float64 {
		dx := float64(p.X - goal.X)
		dy := float64(p.Y - goal.Y)
		dz := float64(p.Z - goal.Z)
		return math.Sqrt(dx*dx+dz*dz) + math.Abs(dy)
	}
	reached := func(p blockPos) bool {
		dx := float64(p.X - goal.X)
		dz := float64(p.Z - goal.Z)
		return math.Sqrt(dx*dx+dz*dz) <= tolerance
	}

	open := &nodeQueue{{pos: from, g: 0, f: h(from)}}
	heap.Init(open)
	best := map[blockPos]float64{from: 0}
	// その位置へ「どこから」「どの手順で」来たか。手順だけだと遡れない。
	type origin struct {
		prev blockPos
		st   step
	}
	cameFrom := map[blockPos]origin{}

	// 手順を組み立てる。goal から遡って順番を戻す。
	build := func(at blockPos) []step {
		var path []step
		for at != from {
			o, ok := cameFrom[at]
			if !ok {
				break
			}
			path = append(path, o.st)
			at = o.prev
		}
		for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
			path[i], path[j] = path[j], path[i]
		}
		return path
	}

	// 打ち切ったときに使う「一番目標に近づけた地点」。
	// 上限に達したからと nil を返すと、ボットは一歩も動かないまま
	// 同じ計画を繰り返し、結局「目標に届かなかった」で終わる。
	// 木の周りのように分岐が多い場所では 800 ノードは簡単に尽きる。
	// 途中まででも進めば、そこから計画し直して近づける。
	closest := from
	closestH := h(from)

	visited := 0
	for open.Len() > 0 {
		if visited >= maxNodes {
			// 意味のあるぶん近づけたときだけ返す。ほとんど近づけていない
			// 経路を返すと、進んでは計画し直すのを繰り返して足踏みになる。
			if closestH < h(from)-1 {
				return build(closest)
			}
			return nil
		}
		visited++
		cur := heap.Pop(open).(*pathNode)
		if hc := h(cur.pos); hc < closestH {
			closestH = hc
			closest = cur.pos
		}
		if reached(cur.pos) {
			return build(cur.pos)
		}
		if cur.g > best[cur.pos] {
			continue
		}
		for _, mv := range w.moves(cur.pos, c) {
			cost := cur.g + mv.cost
			if old, seen := best[mv.step.Pos]; seen && cost >= old {
				continue
			}
			best[mv.step.Pos] = cost
			cameFrom[mv.step.Pos] = origin{prev: cur.pos, st: mv.step}
			heap.Push(open, &pathNode{pos: mv.step.Pos, g: cost, f: cost + h(mv.step.Pos)})
		}
	}
	return nil
}

type move struct {
	step step
	cost float64
}

// moves は1歩で行ける先を、手段ごとに列挙する。
// 斜めは扱わない。角抜けの判定が要るうえ、実際の歩行が安定しない。
func (w *world) moves(p blockPos, c caps) []move {
	dirs := [4][2]int32{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}
	out := make([]move, 0, 12)

	for _, d := range dirs {
		x, z := p.X+d[0], p.Z+d[1]
		foot := blockPos{x, p.Y, z}
		head := blockPos{x, p.Y + 1, z}

		// そのまま歩ける
		if w.standable(foot) {
			out = append(out, move{step{Pos: foot, Action: stepWalk}, costWalk})
			continue
		}

		// 1段上がる。頭上2つぶんが空いていないと跳べない。
		up := blockPos{x, p.Y + 1, z}
		if w.passable(blockPos{p.X, p.Y + 2, p.Z}) && w.standable(up) {
			out = append(out, move{step{Pos: up, Action: stepJump}, costJump})
			continue
		}

		// 水の中は足場が無くても進める。泳いで渡る。
		if w.inWater(foot) && w.passable(head) {
			out = append(out, move{step{Pos: foot, Action: stepSwim}, costSwim})
			continue
		}

		// 落ちる
		if w.passable(foot) && w.passable(head) {
			for dy := int32(1); dy <= maxDrop; dy++ {
				cand := blockPos{x, p.Y - dy, z}
				if w.standable(cand) {
					out = append(out, move{step{Pos: cand, Action: stepFall}, costFall})
					break
				}
				if !w.passable(cand) {
					break
				}
			}
		}

		// 掘って抜ける。足場があり、塞いでいるものが壊せるとき。
		if c.CanDig && w.solidFloor(blockPos{x, p.Y - 1, z}) {
			var dig []blockPos
			ok := true
			for _, b := range []blockPos{foot, head} {
				if w.passable(b) {
					continue
				}
				if !w.diggable(b) {
					ok = false
					break
				}
				dig = append(dig, b)
			}
			if ok && len(dig) > 0 {
				out = append(out, move{
					step{Pos: foot, Action: stepDig, Dig: dig},
					costWalk + costDig*float64(len(dig)),
				})
				continue
			}
		}

		// 足場を置いて渡る。空間は空いているが下が無いとき。
		if c.Blocks > 0 && w.passable(foot) && w.passable(head) {
			below := blockPos{x, p.Y - 1, z}
			if w.passable(below) {
				out = append(out, move{
					step{Pos: foot, Action: stepBridge, Fill: below},
					costWalk + costBridge,
				})
			}
		}
	}

	// 水の中は泳いで真上へ上がる。置く物も掘る力も要らない。
	//
	// 水中でジャンプを押し続けると浮上する。実プレイヤーが水流で上がるのと
	// 同じ手で、持ち物が空でも使える。地下から地上へ戻る道として、掘る・
	// 積むに次ぐ3本目になる。
	if w.inWater(p) {
		up := blockPos{p.X, p.Y + 1, p.Z}
		// 水面から上がるときは、その上に頭が入る空きが要る。
		if w.inWater(up) || (w.passable(up) && w.passable(blockPos{p.X, p.Y + 2, p.Z})) {
			out = append(out, move{step{Pos: up, Action: stepSwimUp}, costSwim})
		}
	}

	// 柱を積んで真上へ上がる。
	//
	// 掘るだけでは登れない。頭上を壊しても縦穴が伸びるだけで、ボットは底に
	// 残る。実測で100回掘って高さが1も変わらなかった。実プレイヤーと同じく、
	// 跳んで足元にブロックを置いて上がる。
	//
	// mineflayer-pathfinder の allow1by1towers と同じ手。あちらも経路探索の
	// move として持っており、スキル側に専用処理は置いていない。
	if c.Blocks > 0 {
		up := blockPos{p.X, p.Y + 1, p.Z}
		head := blockPos{p.X, p.Y + 2, p.Z}
		if w.passable(up) && w.passable(head) {
			out = append(out, move{
				step{Pos: up, Action: stepTower, Fill: p},
				costJump + costBridge,
			})
		}
	}

	// 真下を掘って降りる。縦穴を掘るときに要る。
	if c.CanDig {
		below := blockPos{p.X, p.Y - 1, p.Z}
		if w.diggable(below) && w.solidFloor(blockPos{p.X, p.Y - 2, p.Z}) {
			out = append(out, move{
				step{Pos: below, Action: stepDig, Dig: []blockPos{below}},
				costFall + costDig,
			})
		}
	}

	return out
}

// stepName は手順の種類を人が読める名前にする。診断用。
func stepName(action int) string {
	switch action {
	case stepWalk:
		return "walk"
	case stepJump:
		return "jump"
	case stepFall:
		return "fall"
	case stepDig:
		return "dig"
	case stepBridge:
		return "bridge"
	case stepTower:
		return "tower"
	case stepSwim:
		return "swim"
	case stepSwimUp:
		return "swimUp"
	default:
		return "unknown"
	}
}
