### このリポジトリの概要
- 全体的にProject Sid のパクリ。
- MindCraft/Voyager が抱える「行動成功率の低さ」を、泥臭いフォールバック処理で無理やり解決する。
- 行動のサイクルからLLMを追い出し、RTX 5060 Ti 程度のアフガキ環境でも複数体を快適に回すことを目指す。

### きっかけ
MindCraft/Voyager を試運転したところ「ダイヤを斧で叩くアホ」だと判明してしまったため。

### 先行研究

[<img src="https://img.youtube.com/vi/tbSev4nj_Io/maxresdefault.jpg" width="300">](https://youtube.com/shorts/tbSev4nj_Io)

#### Project Sid: [Official Site](https://fundamentalresearchlabs.com/blog/project-sid) / [Paper](https://arxiv.org/abs/2411.00114)
* 1000体規模のAI文明シミュレーション。本プロジェクトの「社会」の理想形。


#### MindCraft: [GitHub](https://github.com/mindcraft-bots/mindcraft) / [Paper](https://arxiv.org/abs/2403.04756)
* プロンプトにマイクラの知識・ノウハウを詰め込み、最初から「賢く」動かすタイプ。RTX 5090クラスのハイエンド環境であれば、実用レベルの自律運用を可能にすると思われる。


#### Voyager: [GitHub](https://github.com/MineDojo/Voyager) / [Paper](https://arxiv.org/abs/2305.16291)
* スキルツリー形式で「できること」を積み上げていく学習型。LLMが毎ターン行動を選択する仕組み上、反射的な危機回避よりも機能拡張に重きを置いたアーキテクチャ。

#### シャノン (Shannon): [Zenn記事](https://zenn.dev/rai_rai/articles/a03367b83bcaef)
* 人間からのタスク遂行に特化した国内事例。Function Callingの活用により、実行速度を高速化している。
