package main

import (
	"bytes"
	"encoding/base64"
)

// スキンは 64x64 の RGBA をそのまま並べたもの。PNG ではない。
//
// gophertunnel の既定は真っ黒(32x64)で、他プレイヤーからは黒い人影にしか
// 見えず、ボットがどれか分からない。統合版で「購入済みしか使えない」のは
// Persona(キャラクリ)の方で、ログイン時に送る従来型のスキンは任意のデータを
// 送れる。画像ファイルを持ち回らずに済むよう、その場で組み立てる。
const (
	skinW = 64
	skinH = 64
)

type rgba struct{ R, G, B, A uint8 }

var (
	// 遠くからでも分かる色。地形にも他プレイヤーにも普通は無い。
	colorBody = rgba{255, 0, 200, 255} // 蛍光ピンク
	colorHead = rgba{255, 230, 0, 255} // 黄
	colorTrim = rgba{0, 0, 0, 255}     // 縁取り
	colorNone = rgba{0, 0, 0, 0}       // 透明
)

// buildSkin は目立つスキンの生データを返す。
//
// 顔の向きが分かるよう、頭の前面だけ色を変えて目を入れる。全面同色だと
// どちらを向いているか分からず、追いかけるときに困る。
func buildSkin() []byte {
	px := make([]rgba, skinW*skinH)
	for i := range px {
		px[i] = colorNone
	}

	fill := func(x0, y0, w, h int, c rgba) {
		for y := y0; y < y0+h; y++ {
			for x := x0; x < x0+w; x++ {
				if x < 0 || y < 0 || x >= skinW || y >= skinH {
					continue
				}
				px[y*skinW+x] = c
			}
		}
	}

	// 頭(8x8 の面が横に並ぶ配置)。前面だけ黄、他は縁取り色。
	fill(0, 0, 32, 16, colorTrim)
	fill(8, 8, 8, 8, colorHead) // 前面
	// 目。左右に2つ。
	fill(10, 11, 2, 2, colorTrim)
	fill(14, 11, 2, 2, colorTrim)

	// 胴と腕と脚。まとめてピンクで塗る。
	fill(16, 16, 24, 16, colorBody) // 胴
	fill(40, 16, 16, 16, colorBody) // 腕
	fill(0, 16, 16, 16, colorBody)  // 脚
	fill(16, 48, 16, 16, colorBody) // もう片方の腕
	fill(0, 32, 16, 16, colorBody)  // もう片方の脚

	// 胸に横縞を入れて、後ろ姿とも見分けられるようにする。
	fill(20, 20, 16, 2, colorHead)
	fill(20, 26, 16, 2, colorHead)

	out := bytes.NewBuffer(make([]byte, 0, len(px)*4))
	for _, c := range px {
		out.Write([]byte{c.R, c.G, c.B, c.A})
	}
	return out.Bytes()
}

// skinDataBase64 はログインに載せる形。
func skinDataBase64() string {
	return base64.StdEncoding.EncodeToString(buildSkin())
}
