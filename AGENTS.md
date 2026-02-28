# onj-minecraft

Minecraftマルチエージェント botプロジェクト。LLMを使って autonomous agents を実現。

## 開発ルール

### モジュール追加時の手順

新しいnpmモジュールを追加する場合、以下の手順で行う：

#### 1. ホスト側（WSL）
- `package.json` に依存関係を追加する

#### 2. Dockerfile
- builderステージでpatchを適用する処理を追加する

#### 3. ビルドとコピー
```bash
# build
docker compose build

# ホスト側のnode_modulesを更新
docker run --rm -v $(pwd)/node_modules:/output onj-minecraft cp -r /app/node_modules /output/
```

#### 4. docker-compose.yml
- volumes設定で `/app/node_modules` を除外し、build結果のnode_modulesを優先させる

### ソース修正時の参考

 `/home/loq26/workspace/mindcraft` は動作実績のあるプロジェクト。修正時は必ずmindcraftの 实现を比較参考すること。

#### 参考になるポイント
- smartGoto / pathfinder の設定
- エージェントの狀態管理
- スキル実装のパターン
