package main

// 統合版のチャンク(サブチャンク)を解く。
//
// 形式は「バージョンバイト → ストレージ数 → 各ストレージ(ビット詰めのインデックス配列
// ＋ パレット)」。パレットは実行時IDの並び(isRuntime)か、NBT の並びのどちらか。
// 実行時IDは版によって「通し番号」だったり「ブロック状態NBTのハッシュ」だったりする
// ため、名前に戻すには別途対応表が要る。まずは何が来ているかを見られるようにする。

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"sort"

	"github.com/sandertv/gophertunnel/minecraft/nbt"
)

// subChunk は1つのサブチャンク(16x16x16)。
type subChunk struct {
	// Index はワールド内での絶対的な Y 区画番号。version 9 でのみ届く。
	Index int8
	// Storages はレイヤー。0 が通常のブロック、1 が水などの重なり。
	Storages []blockStorage
}

type blockStorage struct {
	BitsPerBlock byte
	IsRuntime    bool
	// Indices は 4096 個。Palette への添字。
	Indices [4096]uint16
	// Palette は実行時ID。IsRuntime が false のときは NBT から名前を拾って
	// PaletteNames に入れる。
	Palette      []int32
	PaletteNames []string
}

// blockAt はサブチャンク内の相対座標からパレット添字を引く。
// 統合版の並びは x を最上位、z、y の順(YZX ではない)。
func (s *blockStorage) indexAt(x, y, z int) uint16 {
	return s.Indices[(x<<8)|(z<<4)|y]
}

type reader struct {
	b   *bytes.Reader
	err error
}

func (r *reader) u8() byte {
	if r.err != nil {
		return 0
	}
	v, err := r.b.ReadByte()
	if err != nil {
		r.err = err
	}
	return v
}

func (r *reader) i8() int8 { return int8(r.u8()) }

func (r *reader) u32() uint32 {
	if r.err != nil {
		return 0
	}
	var buf [4]byte
	if _, err := r.b.Read(buf[:]); err != nil {
		r.err = err
		return 0
	}
	return binary.LittleEndian.Uint32(buf[:])
}

// varint32 は ZigZag された可変長整数。パレットの要素数とIDに使われる。
func (r *reader) varint32() int32 {
	if r.err != nil {
		return 0
	}
	var v uint32
	for shift := uint(0); shift < 35; shift += 7 {
		b := r.u8()
		if r.err != nil {
			return 0
		}
		v |= uint32(b&0x7f) << shift
		if b&0x80 == 0 {
			return int32(v>>1) ^ -int32(v&1)
		}
	}
	r.err = fmt.Errorf("varint が長すぎる")
	return 0
}

// decodeSubChunks は LevelChunk の RawPayload から先頭 count 個のサブチャンクを解く。
func decodeSubChunks(payload []byte, count int) ([]subChunk, error) {
	r := &reader{b: bytes.NewReader(payload)}
	out := make([]subChunk, 0, count)
	for i := 0; i < count; i++ {
		sc, err := decodeSubChunk(r)
		if err != nil {
			return out, fmt.Errorf("%d 番目のサブチャンクで失敗: %w", i, err)
		}
		out = append(out, sc)
	}
	return out, r.err
}

func decodeSubChunk(r *reader) (subChunk, error) {
	var sc subChunk
	version := r.u8()
	storageCount := 1
	switch version {
	case 1:
		// 旧形式。ストレージは1つだけ。
	case 8:
		storageCount = int(r.u8())
	case 9:
		storageCount = int(r.u8())
		sc.Index = r.i8()
	default:
		return sc, fmt.Errorf("未知のサブチャンク版: %d", version)
	}
	if r.err != nil {
		return sc, r.err
	}
	for i := 0; i < storageCount; i++ {
		st, err := decodeStorage(r)
		if err != nil {
			return sc, err
		}
		sc.Storages = append(sc.Storages, st)
	}
	return sc, r.err
}

func decodeStorage(r *reader) (blockStorage, error) {
	var st blockStorage
	header := r.u8()
	st.BitsPerBlock = header >> 1
	st.IsRuntime = header&1 == 1

	if st.BitsPerBlock == 0 {
		// 全ブロックが同じ。添字は全て0で、パレットは1要素。
		st.Palette = append(st.Palette, r.varint32())
		return st, r.err
	}
	if st.BitsPerBlock > 32 {
		return st, fmt.Errorf("ビット幅が不正: %d", st.BitsPerBlock)
	}

	// 1ワード(32bit)に詰められる個数。余りビットは捨てられる。
	perWord := 32 / int(st.BitsPerBlock)
	words := (4096 + perWord - 1) / perWord
	mask := uint32((1 << st.BitsPerBlock) - 1)

	pos := 0
	for w := 0; w < words; w++ {
		word := r.u32()
		if r.err != nil {
			return st, r.err
		}
		for p := 0; p < perWord && pos < 4096; p++ {
			st.Indices[pos] = uint16((word >> (uint(p) * uint(st.BitsPerBlock))) & mask)
			pos++
		}
	}

	size := int(r.varint32())
	if r.err != nil {
		return st, r.err
	}
	if size < 0 || size > 1<<16 {
		return st, fmt.Errorf("パレットの要素数が不正: %d", size)
	}
	if st.IsRuntime {
		st.Palette = make([]int32, 0, size)
		for i := 0; i < size; i++ {
			st.Palette = append(st.Palette, r.varint32())
		}
		return st, r.err
	}

	// NBT のパレット。ここには名前がそのまま入っているので対応表が要らない。
	dec := nbt.NewDecoderWithEncoding(r.b, nbt.NetworkLittleEndian)
	st.PaletteNames = make([]string, 0, size)
	for i := 0; i < size; i++ {
		var entry struct {
			Name string `nbt:"name"`
		}
		if err := dec.Decode(&entry); err != nil {
			return st, fmt.Errorf("パレットのNBTを読めない: %w", err)
		}
		st.PaletteNames = append(st.PaletteNames, entry.Name)
	}
	return st, r.err
}

// --- ワールドの保持 ---

// world は受け取ったサブチャンクを座標で引けるように持つ。
// 統合版のオーバーワールドは Y が -64..319 で、サブチャンク番号は -4..19。
type world struct {
	columns map[[2]int32]map[int8]*subChunk
}

func newWorld() *world {
	return &world{columns: map[[2]int32]map[int8]*subChunk{}}
}

func (w *world) put(cx, cz int32, sc subChunk) {
	key := [2]int32{cx, cz}
	col, ok := w.columns[key]
	if !ok {
		col = map[int8]*subChunk{}
		w.columns[key] = col
	}
	stored := sc
	col[sc.Index] = &stored
}

// floorDiv16 は負の座標でも正しく区画番号を求める。単純な /16 だと -1 が 0 になる。
func floorDiv16(v int32) int32 { return v >> 4 }

// blockAt は絶対座標のブロック名を返す。未取得の領域は ok=false。
func (w *world) blockAt(x, y, z int32) (string, bool) {
	col, ok := w.columns[[2]int32{floorDiv16(x), floorDiv16(z)}]
	if !ok {
		return "", false
	}
	sc, ok := col[int8(floorDiv16(y))]
	if !ok || len(sc.Storages) == 0 {
		return "", false
	}
	st := &sc.Storages[0]
	idx := st.indexAt(int(x&15), int(y&15), int(z&15))

	if len(st.PaletteNames) > 0 {
		if int(idx) >= len(st.PaletteNames) {
			return "", false
		}
		return trimNamespace(st.PaletteNames[idx]), true
	}
	if int(idx) >= len(st.Palette) {
		return "", false
	}
	return blockNameFor(st.Palette[idx])
}

// loadedColumns は取得済みの列の数。どれだけ見えているかの目安。
func (w *world) loadedColumns() int { return len(w.columns) }

// paletteNamesOf はそのサブチャンクに「出てくる可能性のある」ブロック名を返す。
//
// パレットはサブチャンク(16x16x16=4096マス)あたり数個〜数十個しかない。
// 「このサブチャンクに作業台はあるか」を知るのに4096マスを引く必要はなく、
// パレットを見れば足りる。遠くまで見渡すための肝がこれで、走査量が
// 3桁変わる。
func paletteNamesOf(sc *subChunk) []string {
	if len(sc.Storages) == 0 {
		return nil
	}
	st := &sc.Storages[0]
	if len(st.PaletteNames) > 0 {
		out := make([]string, 0, len(st.PaletteNames))
		for _, n := range st.PaletteNames {
			out = append(out, trimNamespace(n))
		}
		return out
	}
	out := make([]string, 0, len(st.Palette))
	for _, id := range st.Palette {
		if n, ok := blockNameFor(id); ok {
			out = append(out, n)
		}
	}
	return out
}

// findWide は取得済みのチャンクすべてから、名前の合うブロックを近い順に探す。
//
// 立方体を総当たりしない。半径128の立方体は1600万マスあり、引けば tick が
// 止まる。代わりに
//  1. 取得済みの列を、自分からの水平距離で並べる
//  2. 各サブチャンクのパレットに目的の名前が入っているかだけ見る
//  3. 入っていたサブチャンクだけ、中の4096マスを引く
//
// の順で絞る。人工物は世界のごく一部にしか無いので、2 でほとんど落ちる。
//
// 半径はチャンク単位ではなくブロック単位。取得していない領域は当然見えない
// ので、実効範囲は requestRadius が決める。
func (w *world) findWide(
	ox, oy, oz int32,
	want map[string]bool,
	radius float64,
	count int,
) []foundBlock {
	type colRef struct {
		key  [2]int32
		dist float64
	}
	// まず列を距離順に。列の中心と自分の水平距離で測る。
	cols := make([]colRef, 0, len(w.columns))
	for key := range w.columns {
		cx := float64(key[0]*16 + 8)
		cz := float64(key[1]*16 + 8)
		dx := cx - float64(ox)
		dz := cz - float64(oz)
		d := math.Sqrt(dx*dx + dz*dz)
		// 列の中心が範囲外でも、手前の角は届いていることがある。
		// 半分の対角(約11.3)ぶん甘く見る。
		if d-11.4 > radius {
			continue
		}
		cols = append(cols, colRef{key, d})
	}
	sort.Slice(cols, func(i, j int) bool { return cols[i].dist < cols[j].dist })

	out := make([]foundBlock, 0, count)
	for _, c := range cols {
		col := w.columns[c.key]
		for idx, sc := range col {
			// パレットで落とす。ここが効くので総当たりにならない。
			hit := false
			for _, n := range paletteNamesOf(sc) {
				if want[n] {
					hit = true
					break
				}
			}
			if !hit {
				continue
			}
			baseX := c.key[0] * 16
			baseY := int32(idx) * 16
			baseZ := c.key[1] * 16
			for lx := int32(0); lx < 16; lx++ {
				for lz := int32(0); lz < 16; lz++ {
					for ly := int32(0); ly < 16; ly++ {
						x, y, z := baseX+lx, baseY+ly, baseZ+lz
						name, ok := w.blockAt(x, y, z)
						if !ok || !want[name] {
							continue
						}
						dx := float64(x - ox)
						dy := float64(y - oy)
						dz := float64(z - oz)
						d := math.Sqrt(dx*dx + dy*dy + dz*dz)
						if d > radius {
							continue
						}
						out = append(out, foundBlock{Name: name, X: x, Y: y, Z: z, Dist: d})
					}
				}
			}
		}
		// 近い列から見ているので、必要数が揃ったらそこで切り上げてよい。
		// ただし同じ列の中では距離順になっていないため、最後に並べ直す。
		if len(out) >= count {
			break
		}
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Dist < out[j].Dist })
	if len(out) > count {
		out = out[:count]
	}
	return out
}

// foundBlock は findWide の結果。距離を持たせるのは並べ替えのため。
type foundBlock struct {
	Name string
	X    int32
	Y    int32
	Z    int32
	Dist float64
}

// forget は中心から remove チャンクより遠い列を捨てる。
//
// 取得した列は今まで一度も捨てていなかった。歩き回るほど積み上がるので、
// 要求範囲を広げるならここが要る。捨てた列は s.requested からも消して、
// 戻ってきたときに取り直せるようにする(呼び出し側の責務)。
//
// 捨てた列のキーを返す。
func (w *world) forget(px, pz int32, keep int32) [][2]int32 {
	var dropped [][2]int32
	for key := range w.columns {
		dx := key[0] - px
		dz := key[1] - pz
		if dx < 0 {
			dx = -dx
		}
		if dz < 0 {
			dz = -dz
		}
		if dx > keep || dz > keep {
			dropped = append(dropped, key)
		}
	}
	for _, key := range dropped {
		delete(w.columns, key)
	}
	return dropped
}

// setBlock は1マスだけ差し替える。掘った/置いた結果を反映するのに使う。
// パレットに無い名前なら末尾に足す。
func (w *world) setBlock(x, y, z int32, name string) {
	col, ok := w.columns[[2]int32{floorDiv16(x), floorDiv16(z)}]
	if !ok {
		return
	}
	sc, ok := col[int8(floorDiv16(y))]
	if !ok || len(sc.Storages) == 0 {
		return
	}
	st := &sc.Storages[0]

	// 名前で持つ側に寄せる。実行時IDのパレットしか無い場合は名前側へ作り直す。
	if len(st.PaletteNames) == 0 {
		st.PaletteNames = make([]string, len(st.Palette))
		for i, id := range st.Palette {
			if n, ok := blockNameFor(id); ok {
				st.PaletteNames[i] = n
			}
		}
		st.Palette = nil
	}

	idx := -1
	for i, n := range st.PaletteNames {
		if n == name {
			idx = i
			break
		}
	}
	if idx < 0 {
		if len(st.PaletteNames) >= 1<<16 {
			return
		}
		st.PaletteNames = append(st.PaletteNames, name)
		idx = len(st.PaletteNames) - 1
	}
	st.Indices[(int(x&15)<<8)|(int(z&15)<<4)|int(y&15)] = uint16(idx)
}

// runtimeIDAt は絶対座標のブロックの実行時IDを返す。
// 設置の transaction はクリック先のIDを要求するため、名前とは別に引けるようにする。
// setBlock で名前側に寄せた区画では引けないので、その場合は名前から引き直す。
func (w *world) runtimeIDAt(x, y, z int32) (int32, bool) {
	col, ok := w.columns[[2]int32{floorDiv16(x), floorDiv16(z)}]
	if !ok {
		return 0, false
	}
	sc, ok := col[int8(floorDiv16(y))]
	if !ok || len(sc.Storages) == 0 {
		return 0, false
	}
	st := &sc.Storages[0]
	idx := int(st.indexAt(int(x&15), int(y&15), int(z&15)))
	if len(st.Palette) > idx {
		return st.Palette[idx], true
	}
	if len(st.PaletteNames) > idx {
		return blockIDFor(st.PaletteNames[idx])
	}
	return 0, false
}
