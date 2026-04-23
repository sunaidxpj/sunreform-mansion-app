# サンリフォーム マンション検索

サンリフォーム社内向け：既存マンションリスト (Firestore) をマンション名で
あいまい検索し、物件詳細・関連現場一覧を閲覧するツール。

- 認証: GitHub OAuth（sunaidxpj org メンバー限定）
- フロント: GitHub Pages （このリポジトリ）
- バックエンド: [sunbo-v2](https://github.com/sunaidxpj/sunbo-v2) Cloud Run 内の `?action=mansion-*` エンドポイント
- データ: Firestore `mansions` / `sites`

URL: https://sunaidxpj.github.io/sunreform-mansion-app/
