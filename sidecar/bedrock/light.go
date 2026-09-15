package main

// 明るさの推定。
//
// 統合版のサーバーはライトレベルをクライアントへ送ってこない。本家の
// クライアントは自分で計算している。こちらも同じことをする必要がある。
//
// 送られてこないことを理由に、ドライバは長いあいだ getLightLevel を 15 固定で
// 返していた。プロンプトには常に "Light Level: 15"(＝真昼の地上と同じ)と出る。
// 暗いことが一度も伝わらないので、明かりを置く判断も、夜を避ける判断も
// 生まれようがなかった。9/5〜9/11 の死因606件のうち mob・矢・爆発が約6割で、
// どれも暗い所にしか湧かない相手。
//
// 本家と同じ伝播計算はしない。ここで要るのは「今いる所は敵が湧くほど暗いか」
// であって、正確な 0〜15 ではない。
//   - 空明かり: 頭上に不透明なブロックがあるか。無ければ時刻で決まる。
//   - ブロック明かり: 近くの光源から多光源BFSで伝播させる。
// の大きい方を採る。

import "strings"

// ブロック明かりを探す範囲。松明の明るさが14なので、14マス離れれば
// どのみち0になる。8マスあれば「今いる所が暗いか」の判断には足りる。
const lightScanRadius = int32(8)

// 空を探して上る上限。ワールドの天井。
const lightSkyTop = int32(320)

// 明かりが透けるブロック。ここに無いものは光を止める扱いにする。
//
// 既定を「止める」にしてあるのは、間違える向きを選べるため。知らない
// ブロックを透かすと「明るい」と答えてしまい、直そうとしている不具合と
// 同じものになる。逆に倒れたときは、明るい所で松明を1本余計に置くだけ。
var lightTransparentExact = map[string]bool{
	"air": true, "cave_air": true, "void_air": true,
	"water": true, "flowing_water": true,
	"lava": true, "flowing_lava": true,
	"short_grass": true, "tall_grass": true, "fern": true, "large_fern": true,
	"dead_bush": true, "seagrass": true, "vine": true, "snow_layer": true,
	"torch": true, "soul_torch": true, "redstone_torch": true,
	"wall_torch": true, "lantern": true, "soul_lantern": true,
	"rail": true, "golden_rail": true, "detector_rail": true, "activator_rail": true,
	"wheat": true, "carrots": true, "potatoes": true, "beetroot": true,
	"red_flower": true, "yellow_flower": true, "sapling": true,
	"iron_bars": true, "chain": true, "ladder": true, "scaffolding": true,
	"web": true, "fire": true, "soul_fire": true, "end_rod": true,
	"glass": true, "glass_pane": true, "barrier": true,
	"glow_lichen": true, "sculk_vein": true, "hanging_roots": true,
	"brown_mushroom": true, "red_mushroom": true, "sugar_cane": true,
	"kelp": true, "bamboo": true, "cocoa": true, "lily_pad": true,
	"nether_wart": true, "sweet_berry_bush": true, "cave_vines": true,
	"cave_vines_body_with_berries": true, "cave_vines_head_with_berries": true,
}

// 接尾辞でまとめて透かすもの。色や木の種類ぶん名前があり、
// 一覧に並べても抜けるだけなので形で拾う。
var lightTransparentSuffix = []string{
	"_leaves", "_glass", "_glass_pane", "_sapling", "_torch",
	"_carpet", "_button", "_pressure_plate", "_rail", "_candle",
	"_fence", "_fence_gate", "_sign", "_banner", "_bars",
	"_flower", "_coral", "_coral_fan", "_amethyst_bud", "_azalea_leaves",
}

// lightPasses は明かりがこのブロックを通るか。
func lightPasses(name string) bool {
	if lightTransparentExact[name] {
		return true
	}
	for _, suf := range lightTransparentSuffix {
		if strings.HasSuffix(name, suf) {
			return true
		}
	}
	return false
}

// 明かりを出すブロックと、その明るさ。
// 自分で作れるもの(松明・かがり火・かまど)と、洞窟で実際に出会うもの
// (溶岩・グロウストーン・光苔)を入れてある。
var lightEmitters = map[string]int{
	"torch": 14, "wall_torch": 14,
	"soul_torch": 10, "soul_wall_torch": 10,
	"redstone_torch": 7,
	"lantern":        15, "soul_lantern": 10,
	"glowstone": 15, "sea_lantern": 15, "shroomlight": 15,
	"jack_o_lantern": 15, "beacon": 15, "conduit": 15,
	"lava": 15, "flowing_lava": 15, "fire": 15,
	"soul_fire": 10, "campfire": 15, "soul_campfire": 10,
	"end_rod": 14, "crying_obsidian": 10, "respawn_anchor": 15,
	"magma": 3, "glow_lichen": 7, "brewing_stand": 1,
	"lit_furnace": 13, "lit_smoker": 13, "lit_blast_furnace": 13,
	"lit_redstone_ore": 9, "lit_deepslate_redstone_ore": 9,
	"amethyst_cluster": 5, "small_amethyst_bud": 1,
	"medium_amethyst_bud": 2, "large_amethyst_bud": 4,
	"end_portal": 15, "end_gateway": 15, "dragon_egg": 1,
	"sculk_catalyst": 6, "ochre_froglight": 15,
	"verdant_froglight": 15, "pearlescent_froglight": 15,
}

// lightEmission はそのブロックが出す明るさ。出さないなら 0。
func lightEmission(name string) int {
	return lightEmitters[name]
}

// skyLightFor は時刻ぶんの空明かり。
//
// 本家は空明かりの値そのものは昼夜で変えず、描画と湧き判定の側で時刻を
// 見る。ここでは「敵が湧く明るさかどうか」を1つの数で表したいので、
// 時刻を織り込んだ実効値を返す。夜の地上が 4 なのは、実際にそこへ
// 敵が湧くため。湧き判定のしきい値(7以下)より下になる。
func skyLightFor(worldTick int32) int {
	t := ((worldTick % 24000) + 24000) % 24000
	switch {
	case t < 12000:
		return 15 // 昼
	case t < 13000:
		return 7 // 日没
	case t < 22000:
		return 4 // 夜
	default:
		return 7 // 夜明け
	}
}

// skyBlockedAbove は頭上に明かりを止めるブロックがあるか。
//
// 上へ辿るのではなく、頭上の全部を見て「読めている不透明ブロックが
// 1つでもあるか」を見る。読めていない高さを障害物と数えないためで、
// 地表より上の空気だけのサブチャンクは中身が空なので届かず、
// 上へ辿る書き方だと地上にいても「読めない」で止まってしまう。
func (w *world) skyBlockedAbove(p blockPos) bool {
	for y := p.Y + 1; y <= lightSkyTop; y++ {
		name, ok := w.blockAt(p.X, y, p.Z)
		if !ok {
			// この高さは持っていない。障害物とは数えない。
			continue
		}
		if !lightPasses(name) {
			return true
		}
	}
	return false
}

// blockLightAt は光源から伝播してきた明るさ。
//
// 近くの光源を集めて多光源BFSで広げる。壁を回り込ませたいので、
// 直線距離ではなく通れるマスを辿る。範囲は lightScanRadius の立方体だけ
// なので、走査は最大で 17^3 マス。
func (w *world) blockLightAt(p blockPos) int {
	r := lightScanRadius
	level := map[blockPos]int{}
	queue := make([]blockPos, 0, 16)

	for dx := -r; dx <= r; dx++ {
		for dy := -r; dy <= r; dy++ {
			for dz := -r; dz <= r; dz++ {
				q := blockPos{p.X + dx, p.Y + dy, p.Z + dz}
				name, ok := w.blockAt(q.X, q.Y, q.Z)
				if !ok {
					continue
				}
				if e := lightEmission(name); e > 0 {
					level[q] = e
					queue = append(queue, q)
				}
			}
		}
	}
	if len(queue) == 0 {
		return 0
	}

	neighbors := []blockPos{
		{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1},
	}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		v := level[cur] - 1
		if v <= 0 {
			continue
		}
		for _, d := range neighbors {
			n := blockPos{cur.X + d.X, cur.Y + d.Y, cur.Z + d.Z}
			if n.X < p.X-r || n.X > p.X+r ||
				n.Y < p.Y-r || n.Y > p.Y+r ||
				n.Z < p.Z-r || n.Z > p.Z+r {
				continue
			}
			if v <= level[n] {
				continue
			}
			name, ok := w.blockAt(n.X, n.Y, n.Z)
			if !ok {
				continue
			}
			// 目的地は不透明でも値を入れる。中を照らすわけではないが、
			// 隣が明るければ「その場は暗くない」で困らない。
			if !lightPasses(name) && n != p {
				continue
			}
			level[n] = v
			queue = append(queue, n)
		}
	}
	return level[p]
}

// lightAt はその場の明るさ(0〜15)。
//
// 2つめの返り値が false なら、そこはまだ読み込めていないので分からない。
// 「分からない」を 0 や 15 に丸めないこと。丸めた 15 がこの仕組みを
// 作る羽目になった原因そのもの。
func (w *world) lightAt(p blockPos, worldTick int32) (int, bool) {
	if _, ok := w.blockAt(p.X, p.Y, p.Z); !ok {
		return 0, false
	}

	light := 0
	if !w.skyBlockedAbove(p) {
		light = skyLightFor(worldTick)
	}
	if b := w.blockLightAt(p); b > light {
		light = b
	}
	if light > 15 {
		light = 15
	}
	return light, true
}
