# サンリフォーム マンション検索アプリ 要件定義書

最終更新: 2026-05-04

## 目次

- [1. 概要](#1-概要)
- [2. システム概要](#2-システム概要)
- [3. 機能要件](#3-機能要件)
- [4. 非機能要件](#4-非機能要件)
- [5. データモデル](#5-データモデル)
- [6. API 仕様](#6-api-仕様)
- [7. インフラ構成](#7-インフラ構成)
- [8. 制約事項・既知のリスク](#8-制約事項既知のリスク)
- [9. 運用](#9-運用)
- [10. 用語集](#10-用語集)
- [11. 改訂履歴](#11-改訂履歴)

## 1. 概要

### 1.1 目的
過去にサンリフォームで工事を行ったマンションについて、社内で素早く情報を検索・参照し、新規見積りや工事準備の効率を上げる。具体的には、マンションごとに蓄積された **申し送り事項**（管理人の癖、搬入経路、駐車、近隣対応、共用部養生規定など）を一元化し、属人化を解消する。

### 1.2 利用者
- 株式会社サンリフォーム および グループ会社（SUNホールディングス、SSCリサイクル）の社員
- 営業／設計／工事／現場管理担当が主な利用層

### 1.3 利用シーン
- 新規問合せ時に「このマンション、過去に工事したことがあるか」を即確認
- 着工準備で管理会社情報・搬入経路・駐車場・養生規定を確認
- 完工時に現場で得た知見を入力 → 次回担当への申し送り
- ベテラン勢の暗黙知を文字化して新人に渡す

---

## 2. システム概要

### 2.1 全体構成

```mermaid
flowchart TB
  Browser["ブラウザ (PC / iPhone Safari / Android Chrome)<br/>Vanilla JS SPA on GitHub Pages<br/>sunaidxpj.github.io/sunreform-mansion-app"]
  Backend["Cloud Run: sunbo-v2 (asia-northeast1)<br/>sunbo-v2-504595374043.asia-northeast1.run.app"]
  FS["Firestore<br/>mansions / sites / raw_notes / dm_targets / staff_master"]
  SRS["SRS 基幹DB (毎時同期)"]
  CW["ChatWork (DM webhook + 日次救出スキャン)"]
  ANDPAD["ANDPAD (日次クロール)"]

  Browser -->|Bearer id_token<br/>Microsoft Entra ID, MSAL.js, OIDC+PKCE| Backend
  Backend --> FS
  SRS --> Backend
  CW <--> Backend
  ANDPAD --> Backend
  Browser -.->|申し送り編集 (即時)| Backend
```

### 2.2 リポジトリ構成
| リポジトリ | 内容 | デプロイ先 |
|---|---|---|
| `sunreform-mansion-app` | フロントエンド SPA | GitHub Pages |
| `sunbo-v2` | バックエンド全般（API、ChatWork bot、各種同期ジョブ） | Cloud Run + Cloud Run Jobs |

---

## 3. 機能要件

### 3.1 認証
- **方式**: Microsoft Entra ID（旧 Azure AD）の OIDC + PKCE フロー
- **ライブラリ**: MSAL.js v3（`@azure/msal-browser`）
- **テナント**: シングルテナント（`AZURE_TENANT_ID = 45878bb2-...`）
- **許可ドメイン**: `sunreform.jp`, `sun-holdings.jp`, `ssc-recycle.jp`（`ALLOWED_EMAIL_DOMAINS` env var で管理）
- **トークン**: id_token を Bearer ヘッダで送信、バックエンドで JWKS 検証（`exp` / `iat` / `aud` / `iss` の必須化、`tid` 一致、メールドメイン allowlist）
- **セッション**: localStorage に MSAL キャッシュ、acquireTokenSilent で再利用、失敗時は loginRedirect
- **失敗時挙動**:
  - 許可ドメイン外のメールでログイン → バックエンド 401（`email domain not allowed`）→ フロントはログイン画面に戻し、再ログインを促す
  - テナント外ユーザーは Microsoft 側で拒否されるため id_token 自体が発行されない
  - id_token 期限切れは acquireTokenSilent → 失敗時 loginRedirect で自動更新

### 3.2 検索機能
- **キーワード**: マンション名 or 市名で**部分一致**検索
- **正規化**: NFKC + カタカナ→ひらがな + 長音/中黒/各種ハイフン除去
  - 例: 「シャトレ」「ｼｬﾄﾚ」「しゃとれ」「シャトレ・」「シャトレ−」すべて同じ結果
- **並び替え**: 工事件数順（既定）/ 名前順（日本語照合）
- **件数制限**: 検索結果上位100件まで表示
- **キャッシュ**: 全マンションリストを sessionStorage にキャッシュし、初回以降の起動を高速化

### 3.3 マンション詳細画面
- **ヘッダー**: マンション名、住所、現場履歴件数
- **申し送り事項**:
  - AI で集約された統合テキスト（後述 4.3）を表示
  - 「編集」ボタンで textarea で直接追記可能
  - 最終更新日時／更新者（Microsoft アカウント名）を表示
- **原文を見る**:
  - `raw_notes` の件数を表示（例: `▸ 原文を見る (5件)`）
  - クリックで展開、各 raw_note を出典・投稿者・日時・本文で一覧表示
  - 出典ラベル: アプリ入力 / 完工DM返信 / 新規引合DM返信 / ANDPAD / 移行データ
- **関連する現場**:
  - 該当マンションの過去工事一覧（`sites` から）
  - 表示項目: 現場ID／住所／工事状況（色分けチップ）／担当／工事金額／利益率／受付日
  - 行クリックで展開し追加情報（受付日／契約日／媒体／店舗／総額／全担当の業務分担率）

### 3.4 申し送り入力ルート（4経路 + 移行）
| 経路 | 反映タイミング | source 値 |
|---|---|---|
| アプリの「編集」ボタン | 即時 | `app` |
| 完工DM への返信 (ChatWork) | 即時（webhook） | `dm_completed` |
| 新規引合DM への返信 (ChatWork) | 即時（webhook） | `dm_new` |
| ANDPAD 案件詳細から | 翌日（日次クロール） | `andpad` |
| 旧データ移行（一回限り） | 移行時のみ | `legacy_import` |

### 3.5 ChatWork 自動通知
- **完工通知 (`handle_completed`)**:
  - 工事ステータスが「完工」に変化したサイトを検知
  - 担当 6 スロット（main/sub/design/staff4-6）の active メンバー全員に DM 送信
  - 本文: 物件名、現場ID、申し送り収集テンプレート（マンション特徴／気をつけること／管理人・共用部／運搬・駐車／その他）
  - DM ごとに `dm_targets` ドキュメントを auto-id で作成（`status=open`）
- **新規引合通知 (`handle_new`)**:
  - 新規案件 + 担当登録を検知
  - **既存 申し送り がある場合のみ**、担当 6 スロット全員に DM
  - 本文: 過去の申し送りを共有 + 気付き事項あれば返信のお願い
- **返信キャプチャ (`collect.py`)**:
  - DM webhook で受信
  - 送信ルームに対する最新の status=open dm_target を引き、対応マンションの `raw_notes` に追加
  - `resummarize()` を即時実行し `申し送り` を更新
  - dm_target を `status=replied` に更新
- **dm_targets ライフサイクル**:
  - `open` → 返信を受け取った時点で `replied`
  - `expired` 状態は enum として定義済みだが、自動遷移ロジックは未実装（将来課題）。長期間返信のない `open` レコードはそのまま残る

### 3.6 言い忘れ救出（日次バッチ）
- **モジュール**: `mansion/scan_chatwork.py`（Cloud Run Job `sunreform-chatwork-scan-job`、Scheduler `chatwork-scan-daily`）
- 毎日 03:00 JST に Cloud Run Job 起動
- 各 staff_master の DM ルームから過去 7 日分のメッセージを取得（ChatWork API）
- bot の完工DM／新規引合DM を起点に、後続の staff メッセージを raw_notes に取り込み
- 「返信機能」を使わず通常メッセージで書かれた申し送りも回収
- `chatwork_message_id` で冪等性確保（重複追加なし）
- フィルタ: 箇条書き「・」を含むメッセージのみ（雑談・質問の誤検知抑制）

### 3.7 ANDPAD 自動同期（日次バッチ）
- **モジュール**: `mansion/crawl_andpad.py`（Cloud Run Job `sunreform-andpad-crawl-job`、Scheduler `andpad-crawl-daily`）
- 毎日 03:00 JST に Cloud Run Job 起動 + ジョブ内ランダム遅延 0〜1h（深夜帯にバラけて疑われ防止）
- Playwright で Auth0 ログイン（メール+パスワード認証、MFA 無効）
- 自社情報管理→案件 一覧 (`https://work.andpad.jp/our/orders`) を全ページ巡回（`?page=N` 形式）
- 各案件詳細ページから抽出:
  - 物件情報（住所、号室、物件種別）
  - 管理会社情報（管理人TEL、勤務時間、管理体制、管理会社名、エレベーター、オートロック）
  - 現場に関する注意事項（入庫方法・搬入経路、駐車場、階段、トイレ、共用部養生範囲）
  - 施工に関する注意点（工事可能時間、土曜日の工事、近隣承認、近隣挨拶範囲）
- **除外**: 案件名・案件種別・案件フロー・担当者名（マンションの特性ではないため）
- **除外**: キーボックス番号・取付位置（個別現場ごとの設定で再利用不可）
- マンション特定: `案件管理ID == SRS site ID` 経由で `sites/{id}.mansion_key` を引く（最も確実）
- フォールバック: 物件管理ID → 物件名 normalize → 住所末尾の建物名抽出
- **冪等性**: `andpad_order_id` をキーに `upsert` 動作。同じ order_id の raw_note が既存ならその body を**上書き**、なければ新規追加（履歴は残らない）。マンション側 `申し送り` は影響を受けたマンションについて当日中に再 resummarize で再生成
- **失敗時挙動**: ページ単位で例外発生時はそのページをスキップしてジョブを継続。冪等な upsert なので翌日の再実行で復旧する

### 3.8 AI 要約（resummarize）
- **トリガー**: raw_notes に追加・更新があった直後に自動実行
- **モデル**: Vertex AI Gemini（`config.GENERATION_MODEL`）
- **入力**: 該当マンションの raw_notes 全件（時系列）
- **プロンプト**:
  - 役割: 分譲マンション改修現場の申し送り編集者
  - 絶対ルール: 入力に書かれていない事実を追加しない、内容が薄ければ短いまま、出力文字数は入力以下、不明なことは書かない
  - 整理ルール: 箇条書き、重複統合、矛盾は両論併記、カテゴリ分け（マンションの特徴／管理人・共用部／運搬・搬入経路／駐車／その他注意点）
- **passthrough 短絡**:
  - raw_notes が 1 件のみの場合、Gemini を呼ばずに本文をそのまま `申し送り` に反映
  - 短い単一原文を要約させると Gemini が文脈を勝手に補完してハルシネーションを起こすため
- **後処理**: 出力先頭の見出し風プレフィックス（「【統合後の申し送り】」など）を正規表現で除去

---

## 4. 非機能要件

### 4.1 セキュリティ
- 認証なしのアクセスはバックエンドで全 401 拒否（OPTIONS を除く）
- バックエンド `/?action=mansion-*` 全エンドポイントで Bearer id_token 検証必須
- id_token 検証: 必須 claim (`exp` / `iat` / `aud` / `iss`) を `require` 強制、`tid` がサンリフォームテナント、`aud` がアプリ ID、`iss` 一致、メールドメインが `ALLOWED_EMAIL_DOMAINS` に含まれること
- 管理者専用エンドポイントは Bearer 検証通過後にメールアドレスで判定（§6 参照）
- CORS は `https://sunaidxpj.github.io` のみ許可
- ChatWork bot トークン、ANDPAD 認証情報、ChatWork API トークンは Google Secret Manager で管理
- フロントエンドには認証情報を一切埋め込まない（公開 OAuth client_id / tenant_id のみ）

### 4.2 パフォーマンス
- 全マンション一覧取得（`mansion-list`）: 約 15,000 件、初回 2-3 秒、以降 sessionStorage キャッシュで即時
- 詳細ページ（`mansion-detail`）: 1 秒以内
- 検索: クライアントサイド完結（API 呼び出しなし）、即時
- ChatWork 返信→申し送り反映: webhook 受信から 5-15 秒（Gemini 呼び出し含む）

### 4.3 可用性
- Cloud Run min-instances: 0（コールドスタート許容、初回数秒の遅延あり）
- Cloud Run max-instances: 2（過負荷防止）
- フロントは GitHub Pages（実質 99.9%+）

### 4.4 モバイル対応
- 画面幅 ≤640px で：
  - 現場テーブルをカード型レイアウトに切替（data-label による自動展開）
  - ヘッダーをコンパクト化
  - 申し送り編集 textarea のフォントサイズ調整

### 4.5 ブラウザサポート
- 対象: モダンブラウザ最新版（Chrome / Edge / Safari / Firefox）
- IE / 旧版はサポート外（MSAL.js v3 が ES2018+ を要求するため）

---

## 5. データモデル

### 5.1 Firestore コレクション

#### `mansions/{mansion_key}`
マンション本体。`mansion_key` は SRS の `contruction_add3`（建物名）から生成（空白・中黒・Firestore不正文字を除去）。

| フィールド | 型 | 説明 |
|---|---|---|
| `name` | string | 表示用建物名 |
| `name_normalized` | string | mansion_key と同じ |
| `city` | string | 市区町村 |
| `address1` | string | 都道府県＋市区町村＋町名 |
| `address2` | string | 丁目番地 |
| `site_count` | int | 紐付く sites の数（`sync_srs` で計算） |
| `申し送り` | string | AI 要約結果（resummarize の出力） |
| `raw_notes_count` | int | サブコレクション件数 |
| `memo_updated_at` | timestamp | 最終更新時刻 |
| `memo_updated_by` | string | 最終更新者メール |
| `updated_at` | timestamp | sync_srs 同期時刻 |

#### `mansions/{mansion_key}/raw_notes/{auto_id}`
申し送りの原文。

| フィールド | 型 | 説明 |
|---|---|---|
| `body` | string | 原文 |
| `author_name` | string | 投稿者名 |
| `author_email` | string? | アプリ経由のみ |
| `source` | string | `app` / `dm_completed` / `dm_new` / `andpad` / `legacy_import` |
| `site_id` | string? | 完工DM由来なら現場ID、andpad なら案件ID |
| `slot` | string? | 完工DM由来なら担当スロット |
| `chatwork_message_id` | string? | scan_chatwork による回収時 |
| `andpad_order_id` | string? | ANDPAD クローラ由来 |
| `created_at` | timestamp | |

#### `sites/{site_id}`
SRS の `deal_viewer` 行。`site_id` は SRS の `id`。

| フィールド | 型 | 説明 |
|---|---|---|
| `mansion_key` | string | 紐付くマンション |
| `name` | string | 案件名 |
| `branch_name` | string | 店舗 |
| `city` | string | |
| `media_name` | string | 媒体 |
| `building_type` | string | "マンション" |
| `construction_status` | string | 工事状況 |
| `contruction_add1` `contruction_add2` `contruction_add3` | string | 工事先住所 |
| `reception_date` `contract_date` | timestamp | |
| `contract_amount` `total_amount` `profit_amount` | number | |
| `main_staff` `sub_staff` `design_staff` `staff4` `staff5` `staff6` `charge_staff` | string | |
| `*_division_rate` | number | 担当ごとの業務分担率 |
| `synced_at` | timestamp | |

#### `dm_targets/{auto_id}`
ChatWork DM 送信履歴。返信先解決用。

| フィールド | 型 | 説明 |
|---|---|---|
| `room_id` | string | DM ルーム |
| `mansion_key` | string | 紐付くマンション |
| `mansion_name` | string | |
| `source` | string | `new` / `completed` |
| `site_id` | string? | |
| `slot` | string? | |
| `staff_name` | string | |
| `sent_at` | timestamp | |
| `status` | string | `open` / `replied` / `expired` |
| `replied_at` | timestamp? | |

#### `staff_master/{normalized_name}`
社員マスタ。SRS から定期同期。

| フィールド | 型 | 説明 |
|---|---|---|
| `name` | string | 表示名 |
| `room_id` | string | ChatWork DM ルームID |
| `chatwork_account_id` | string | |
| `active` | boolean | |

---

## 6. API 仕様

ベース URL: `https://sunbo-v2-504595374043.asia-northeast1.run.app`
共通: `Authorization: Bearer {Microsoft id_token}` 必須

| メソッド | パス | 説明 | レスポンス |
|---|---|---|---|
| GET | `/?action=mansion-list` | 全マンション軽量リスト | `{items: [{key, name, city, address1, address2, site_count}]}` |
| GET | `/?action=mansion-detail&key={key}` | マンション詳細＋紐付く sites | `{mansion: {...}, sites: [...]}` |
| POST | `/?action=mansion-update-memo` | 申し送り原文を1件追加し再要約 | `{ok, summary, raw_notes_count}` |
| GET | `/?action=mansion-raw-notes&key={key}` | raw_notes 一覧（時系列降順） | `{items: [{id, body, author_name, source, site_id, slot, created_at}]}` |

#### `mansion-update-memo` リクエスト
- Body (JSON): `{ "key": string, "memo": string }`（`key` はクエリでも可）
- バリデーション: `key` 必須（欠如→ 400 `missing key`）、`memo` 非空（trim 後空文字→ 400 `empty memo not accepted`）
- 該当マンションが Firestore に存在しない場合 → 404 `mansion not found`
- 認証失敗 → 401

### 管理者専用
管理者判定は Bearer 検証通過後に payload の `preferred_username` / `upn` が固定の管理者メールであるかで行う。

| メソッド | パス | 認可 | 説明 |
|---|---|---|---|
| GET/POST | `/?action=mansion-cleanup-orphans` | 管理者のみ（Bearer + 管理者メール） | sites と紐付かない mansion ドキュメントを削除（`dry_run=1` で件数のみ） |
| GET/POST | `/?action=mansion-migrate-raw-notes` | 管理者 OR `X-Sync-Token`（`CW_TOKEN[:16]`） | 旧 申し送り 系フィールドを raw_notes に移行（idempotent、1回限り想定） |

`mansion-migrate-raw-notes` のみ内部スクリプト（curl 等）からの呼び出しを許容するため X-Sync-Token を併用する。`mansion-cleanup-orphans` は破壊的操作のため管理者ログインを必須とし、X-Sync-Token では呼び出せない。

---

## 7. インフラ構成

### 7.1 GCP プロジェクト
- `default-gemini-project-486705`
- リージョン: `asia-northeast1`

### 7.2 Cloud Run サービス
| 名前 | 役割 |
|---|---|
| `sunbo-v2` | バックエンド API + ChatWork webhook 受信 + 各同期ロジック |

### 7.3 Cloud Run Jobs
| 名前 | 役割 | 起動 |
|---|---|---|
| `sunreform-mansion-job` | SRS → Firestore 同期、新規/完工イベント検出、ChatWork DM 通知 | 毎時 0 分（`sunreform-mansion-hourly`） |
| `sunreform-chatwork-scan-job` | ChatWork DM 巡回バッチ（言い忘れ救出） | 毎日 03:00 JST（`chatwork-scan-daily`） |
| `sunreform-andpad-crawl-job` | ANDPAD Web クローラ | 毎日 03:00 JST + 0-1h ランダム遅延（`andpad-crawl-daily`） |

### 7.4 Secret Manager
| シークレット | 内容 |
|---|---|
| `cw-token` | ChatWork bot API トークン |
| `srs-ssh-pass` | SRS 踏み台 SSH パスワード |
| `srs-db-pass` | SRS MySQL パスワード |
| `andpad-email` | ANDPAD ボット用ログインメール |
| `andpad-password` | ANDPAD ボット用パスワード |

### 7.5 認証情報の取り扱い
- すべて Secret Manager で版管理、Cloud Run の `--set-secrets` で実行時注入
- Service Account に `roles/secretmanager.secretAccessor` を最小権限で付与
- フロントエンドには一切の機密情報を埋め込まない

---

## 8. 制約事項・既知のリスク

### 8.1 ANDPAD クローラ
- ANDPAD の利用規約上、自動アクセスが明示禁止される可能性がある（運用前に最終確認）
- ANDPAD UI の DOM 構造が変わるとセレクタが壊れる可能性（汎用セレクタで多重防御済み）
- 個人アカウントを Secret Manager (`andpad-email` / `andpad-password`) 経由で使用しているため、運用者交代時にシークレット差し替えが必要

### 8.2 Gemini レート制限
- 大量同時 resummarize で 429 エラー発生（経験値: 約 180 件連続で 6 件失敗）
- 対策: 失敗分は翌日の自動再実行で吸収、もしくは `--retry-keys` モードで個別リトライ

### 8.3 ハルシネーション対策
- 短い単一原文の summarize は危険（過去事例: 「スキップフロア」7文字 → 657文字の捏造文）
- 対策: count==1 の場合は Gemini を呼ばず passthrough、count>=2 でも厳しいプロンプト指示

### 8.4 マンション名寄せ
- SRS の `contruction_add3` フィールドの表記揺れ（中黒・全角半角カナ）で別マンション扱いになる
- 対策: `normalize_mansion_key` で中黒・スペース・改行を除去、`merge_dot_duplicates` で既存重複を統合
- 残課題: 半角カナ vs 全角カナの違いまでは吸収できていない

---

## 9. 運用

### 9.1 デプロイ
- フロント: GitHub に push → GitHub Pages 自動反映（数分）
- バックエンド: `gcloud run deploy sunbo-v2 --source .`（Cloud Build 自動）
- ANDPAD クローラ: `gcloud builds submit --config=cloudbuild-andpad.yaml`
- 各 Cloud Run Job: `--source` 経由 or イメージ直接指定

### 9.2 監視
- Cloud Logging で各サービス・ジョブのログ確認
- 異常検知の自動通知は未実装（将来課題）
- 暫定運用: 開発担当が `sunreform-mansion-job` の直近実行ログを定期目視（直近 24h でエラーが出ていないか）。`gcloud run jobs executions list --job=sunreform-mansion-job --region=asia-northeast1` で履歴、`gcloud run jobs executions logs <execution>` で詳細を確認

### 9.3 バックアップ
- Firestore は GCP 標準のレプリケーションに依存（明示的バックアップ未実装）
- 将来課題: 重要時点のスナップショット運用

---

## 10. 用語集

| 用語 | 説明 |
|---|---|
| マンション | 改修対象の建物。SRS の `contruction_add3` ベース |
| 現場 / サイト | 1 件の改修案件。SRS の `deal_viewer` 行 |
| 申し送り（事項） | 次回担当者への注意点・知見の集合 |
| raw_note | 申し送りの原文 1 件 |
| 完工DM | 工事完了時に bot から担当者に送られる ChatWork DM |
| 新規引合DM | 新規案件で担当登録された時に bot から送られる DM |
| dm_target | 上記 DM の送信履歴。返信先解決用 |
| HD | SUNホールディングス（`sun-holdings.jp` ドメイン）。サンリフォームの親会社的な持株会社 |
| ANDPAD | 工程管理 SaaS。サンリフォームが施工管理に使用 |
| SRS | サンリフォームの基幹業務システム（社内 MySQL） |
| sunbo-v2 | バックエンド全般を担う Cloud Run サービス兼 ChatWork bot |

---

## 11. 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-05-02 | 初版（現行コードからの逆算ドキュメント） |
| 2026-05-04 | レビュー反映: 管理者エンドポイントの認可分離、`mansion-update-memo` リクエスト仕様、ANDPAD upsert 仕様、dm_targets ライフサイクル、認証失敗時挙動、監視暫定運用、目次・改訂履歴・Mermaid 図を追加 |
