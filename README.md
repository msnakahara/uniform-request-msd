# 制服等支給申請アプリ / Uniform Request App

全社員向けの制服申請フォーム(日本語/English)。6か月ルール・クイズ・社員名簿・緊急時の写真添付に対応。
Uniform request form for all employees (JA/EN) with the 6‑month rule, 3‑question quiz, employee roster and photo for urgent replacements.

## 実行 / Run locally
Node.js >= 22.13, no dependencies.
```
cp .env.example .env   # edit values, then export them (or set in your shell)
ADMIN_PASSCODE=2086 SESSION_SECRET=change-me npm start
npm test
```
Open http://localhost:3000 . 管理 / Admin button → passcode → records, roster, CSV, photos.

## 環境変数 / Environment variables
| Name | Meaning |
|---|---|
| PORT | default 3000 |
| ADMIN_PASSCODE | admin passcode (**change from 2086 in production**) |
| SESSION_SECRET | long random string for cookie signing |
| DATA_DIR | folder for the SQLite DB (needs a persistent disk) |
| GOOGLE_SHEET_ID | optional: Google Sheet to append records to |
| SHEET_TAB | tab name (default 制服申請の記録) |
| GOOGLE_SERVICE_ACCOUNT_JSON / _FILE | service account key (JSON text or file path) |

## デプロイ / Deploy
- **Render**: push to GitHub → New → Blueprint → select repo (`render.yaml` includes a persistent disk). Set ADMIN_PASSCODE.
- **Docker**: `docker build -t uniform . && docker run -p 3000:3000 -v uniform-data:/data -e ADMIN_PASSCODE=... -e SESSION_SECRET=... uniform`

## Google スプレッドシート / Google Sheets (optional)
1. Google Cloud: create a service account, enable Google Sheets API, create a JSON key.
2. Create a Google Sheet, **share it with the service account email as Editor**.
3. Set GOOGLE_SHEET_ID (from the sheet URL) and GOOGLE_SERVICE_ACCOUNT_JSON.
New requests are appended automatically; failed ones retry (Admin → sync). Only people with access to the sheet can see it.

## 注意 / Notes
- 数量は各1点、ズボンは合計1点。同じ社員番号・同じ品目は6か月以内は拒否。
- 名簿未登録の社員番号は申請不可。緊急(6か月未満)は写真必須(確認用のみ、印刷されません)。
- Employee-number lookup returns the registered name (rate-limited). Edited requests update the DB but are not re-appended to the sheet.
- Back up `DATA_DIR` regularly; the Google Sheet is a second copy.
