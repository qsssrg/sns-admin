# SNS運用 管理画面

SNS運用エージェントチーム(private リポジトリ `qsssrg/claudecode`)を
ブラウザ/スマホから操作する静的管理画面。GitHub Pages で配信される。

**URL**: https://qsssrg.github.io/sns-admin/

## 機能

- **ダッシュボード**: 直近の実行(エージェントが何をしたか)/ 成果サマリー
  (直近7日の公開数・インプレッション・いいね・クリック・内訳)/ キュー件数 /
  トークンウィンドウ使用率 / 動画API予算 / 上位投稿 / 日次PDCAレポート /
  ローカル機の死活(heartbeat)
- **ログ**: パイプライン実行・投稿・計測・承認反映の全履歴
  (`state/activity_log.json`)。各実行の成果レポート全文を展開して読める
- **承認**: 承認待ち投稿のプレビューと承認・却下。決定は
  `sns_team/state/decisions/` に記録され、ローカル機の次回同期で適用される
- **設定**: accounts / conversions / budget / safety / schedule の各 YAML を
  フォームまたは生エディタで編集(コメントは保持される)
- **🤖 AIおまかせ設定**(設定タブ上部): 「何を発信したい・どうなりたい」を
  一言書くだけで、AIがSNSの成功事例を調査して設定プラン一式(テーマ/トーン/
  頻度/時間帯/CV導線/コンテンツピラー)を設計・提案。人間は提案書を読んで
  採用/却下をジャッジするだけ。却下理由は次の改訂案に反映される

## 仕組み

サーバーは無い。ページの JavaScript が GitHub Contents API を直接呼び、
データリポジトリ(private のままでよい)を読み書きする。
ローカルの cron マシンが `git_sync.sh` で pull/push して実際の投稿・生成を行う。

```
ブラウザ ──(PAT / api.github.com)──> qsssrg/claudecode (private)
                                        ▲
                          git_sync.sh   │
ローカル cron マシン ────────────────────┘
```

## 初回セットアップ

1. GitHub で **Fine-grained Personal Access Token** を発行する
   - Resource owner: qsssrg / Repository access: **claudecode のみ**
   - Permissions: **Contents: Read and write**(それ以外は不要)
   - 有効期限: 30〜90日を推奨(期限切れになったら再発行して再入力)
2. https://qsssrg.github.io/sns-admin/ を開き、⚙ からトークンを入力
   - Branch はローカル機の cron が動いているブランチを指定する
3. スマホでは「ホーム画面に追加」でアプリのように使える

## セキュリティ上の注意

- トークンは**この端末の localStorage にのみ**保存される。共有端末では使わない
- トークンが漏れるとリポジトリの内容(スクリプト含む)を書き換えられるため、
  必ず fine-grained・対象リポジトリ限定・Contents のみ・短期限で発行すること
- ページは外部CDNを一切読み込まない(全ライブラリ同梱、CSP 有効)

## 開発

ビルド不要のバニラJS。ローカル確認は `python3 -m http.server` で。
vendor/ には eemeli/yaml(コメント保持YAML)、marked、DOMPurify を同梱。
