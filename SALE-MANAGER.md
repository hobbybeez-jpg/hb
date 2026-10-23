# 特價商品管理（Sale Manager）

找出放很久賣不掉的商品，勾選後設定特價期間：開始日自動改特價、結束後自動全部還原。

- 網址：`/sale`（Netlify，檔案 `sale.html`）
- 後端：Supabase Edge Function `sale-manager`（`supabase/functions/sale-manager/`）
- 資料：同一個 Supabase 資料庫的 `sale` schema（`supabase/migrations/20261023000001_sale_manager.sql`）
- 排程：pg_cron 每 10 分鐘檢查一次（`supabase/migrations/20261023000002_sale_manager_cron.sql`）
- 介面與錯誤訊息是英文（和 Receiving Tracker 一樣），本文件為中文說明

## 畫面

| 分頁 | 用途 |
|---|---|
| Find Products | 掃描 Shopify、列出符合條件的商品、勾選、Apply sale、匯出 Excel |
| Sales | 所有特價活動：狀態、每個商品的原價／特價、提前結束、改結束日、匯出 Excel |
| Settings | 規則說明、Shopify 連線測試、排程最後執行時間、變更密碼 |

## 掃描條件（三個都要符合）

1. **過去 2 年沒有任何銷售**：從今天往回 2 年（溫哥華日期）內的所有訂單（網站和 POS 都算），都沒有這個商品。
   **取消的訂單不算銷售**；退貨的訂單算有賣過。
2. **沒有 `sale`、`20off`、`40off` 任何一個 tag**（不分大小寫，`Sale` 也算）。
3. **庫存大於 0**（Shopify 的商品總庫存，所有地點加總）。

另外只掃 **Active** 的商品（Draft、Archived 不列）。

- 掃描用 Shopify 的 bulk operation：先讀全部商品、再讀 2 年內的訂單，商品多的話要幾分鐘。
  可以離開頁面，排程會繼續完成；回來就看得到結果。同時只能有一個掃描。
- 結果會保存，其他人打開也看得到最近一次的掃描；要更新就再按一次「Run new scan」。
- 清單可以篩選（名稱／廠商／SKU／條碼）、排序（最舊的商品、庫存最多、價格最高、折扣最大）。
  - **Can go on sale**：可以特價的商品（預設）。
  - **Price too low**：所有款式的特價都不比原價低（例如原價 $9.99 → 特價還是 $9.99），不能選。
  - **In a sale**：已經在另一個還沒結束的活動裡（包括排定未開始的），不能重複選。
- 備註欄提醒：`Has compare-at`（原本就有 compare-at price，特價期間會被換掉、結束後還原）、
  `Only N% off`（因為進位到 x9.99，實際折扣不到 20%）、`N variants too cheap`（多款式商品裡有幾款太便宜，不會改價）。

## 特價規則

開始日 00:00（溫哥華時間）起，每個款式（variant）：

| 欄位 | 改成 |
|---|---|
| Compare-at price | 目前的價格（原價） |
| Price | 原價 × 60%，**無條件進位到 x9.99**（9.99、19.99、29.99 …） |
| Tags（商品） | 加上 `sale`、`40off` |

例：$123.00 → 73.80 → **$79.99**；$133.35 → 80.01 → **$89.99**；$50.00 → 30.00 → **$39.99**；$15.00 → **$9.99**。

- 進位到 x9.99 之後，實際折扣介於 0%～40%（原價越低折扣越少，例如 $20.00 → $19.99）。清單的「Off」欄顯示實際折扣。
- 算出來的特價**不比原價低**的款式不改價（例如 $9.99、$8.00）；整個商品都這樣就不能選。
- 「原價」是**開始那一刻** Shopify 上的價格（不是掃描時的），所以排定之後改過價也會用新價格。
- 開始時會再檢查一次：這段期間如果商品被加上 sale／20off／40off，或庫存變 0，就跳過（Skipped，備註寫原因），不會改。

**結束日 24:00 之後全部還原**：價格、compare-at price 改回原本的值（原本沒有 compare-at 就清空），拿掉 `sale`、`40off` 兩個 tag。

- 特價期間如果有人**手動改了價格**（不是我們設的特價了），那個款式就不還原，在活動的備註寫出來，請手動確認。
- 特價期間被刪掉的商品／款式會略過並備註。
- 其他人另外加的 tag 不會動。

## 操作

1. **Find Products** → Run new scan → 勾選商品（可以「Select all shown」全選目前篩選的）→ 下方黑色列的 **Apply sale…**。
2. 填活動名稱（可空白）、開始日、結束日（特價的最後一天），輸入**主管密碼**。
   - 開始日是今天：立刻開始改價，畫面顯示進度（商品多時會分批，關掉頁面排程也會繼續）。
   - 開始日在未來：排定，到那天 00:00 之後由排程自動套用（每 10 分鐘檢查，最晚約 00:10 完成）。
3. **Sales** 分頁看所有活動。狀態：

| 狀態 | 意思 |
|---|---|
| Scheduled | 還沒到開始日 |
| Starting | 已到開始日，正在改價 |
| On sale | 特價中 |
| Ending | 已到結束時間（或提前結束），正在還原 |
| Ended | 全部還原完成 |
| Canceled | 開始前取消，沒有改過任何東西 |

活動明細的按鈕：

- **Export Excel**：每個款式一行（原價、原 compare-at、特價、折扣、狀態、套用／還原時間、備註、Shopify 連結），另有活動資料和紀錄兩個工作表。
- **Change end date**（主管密碼）：延長或縮短，不能改成過去的日期。
- **End sale now**（主管密碼）：立刻結束並還原。
- **Cancel sale**（主管密碼）：還沒開始的活動才能取消。
- **Apply now / Restore now**：不用等排程，馬上處理該做的商品。
- **Retry failed**：Shopify 出錯的商品會自動重試（每次間隔幾分鐘），**5 次都失敗就停下來**，修好原因（例如權限）後按這個再試。

**Find Products** 的 **Export Excel**：匯出目前篩選出來的清單（每個款式一行，有勾選的標 Y）。

## 密碼

和 Receiving Tracker 分開（`sale.settings`），bcrypt 雜湊。

| key | 用途 |
|---|---|
| `pw_access` | 員工密碼（進入系統）；未設定＝不需要。**建議設定** |
| `pw_manager` | 主管：Apply sale、取消、提前結束、改結束日、變更密碼 |

掃描、看清單、匯出 Excel、Retry 只需要員工密碼。同一個 IP 15 分鐘內輸錯 5 次（或所有人合計 50 次）會鎖到 15 分鐘的時間窗結束。
緊急解鎖：`delete from sale.auth_failures;`

第一次設定（Supabase SQL Editor，把密碼換成你的）：

```sql
insert into sale.settings (key, value) values
  ('pw_manager', extensions.crypt('主管密碼', extensions.gen_salt('bf', 8))),
  ('pw_access',  extensions.crypt('員工密碼', extensions.gen_salt('bf', 8)))
on conflict (key) do update set value = excluded.value, updated_at = now();
```

之後可以在 Settings 頁變更（需要主管密碼）。

## 部署

1. **Shopify app**（另外建一個，不要用 Receiving Tracker 的：那個刻意沒有改商品、讀訂單的權限）
   - Shopify Dev Dashboard 建立 app（拿到 Client ID／Client secret），或用舊式 custom app 的 Admin API access token（`shpat_…`）。
   - Access scopes **只勾這些**：`read_products`、`write_products`、`read_inventory`、`read_orders`、`read_all_orders`。
     `read_all_orders` 是讀 60 天以前訂單需要的，沒有的話「2 年內沒銷售」會判斷錯（只看得到 60 天）。
   - 安裝到商店。
2. **Supabase Secrets**（Edge Functions → Secrets；token 只放這裡，絕對不要放進 `sale.html` 或 git）：

| Secret | 值 |
|---|---|
| `SALE_SHOPIFY_ADMIN_TOKEN` | 舊式 custom app 的 Admin API access token；或改用下面兩個 |
| `SALE_SHOPIFY_CLIENT_ID`、`SALE_SHOPIFY_CLIENT_SECRET` | Dev Dashboard app 的 Client ID／secret（token 每 24 小時自動更新） |
| `SALE_SHOPIFY_STORE` | 選填，`你的商店.myshopify.com`；沒設就用 Receiving Tracker 的 `SHOPIFY_STORE` |
| `SHOPIFY_API_VERSION` | 選填，預設 `2026-07`（和 Receiving Tracker 共用） |
| `SALE_ALLOWED_ORIGINS` | 建議，特價頁的 Netlify 網址，例如 `https://hobbybee.netlify.app` |

3. **資料庫**：Supabase SQL Editor 依序執行 `supabase/migrations/20261023000001_sale_manager.sql`、`20261023000002_sale_manager_cron.sql`
   （或 `npx supabase db push`）。第二個檔案會啟用 pg_cron、pg_net 並建立排程 `sale-manager-tick`。
4. **Edge Function**：`npx supabase functions deploy sale-manager --project-ref <ref>`（保持 JWT 驗證開啟）。
5. 設定密碼（上面的 SQL）。
6. Netlify 自動部署 `sale.html`，開啟 `https://<你的網站>/sale` → Settings → Test connection。
7. 建議先用 1～2 個商品、開始日今天、結束日今天測一次，到 Shopify 確認價格和 tag，再按 End sale now 看還原。

## 排程（技術說明）

- pg_cron 每 10 分鐘執行一次 SQL：`sale.due_work()` 為 true（有活動到開始／結束時間、或掃描進行中）才用 pg_net 呼叫 Edge Function 的 `tick`，
  沒事時不會呼叫。`tick` 用 `sale.settings` 的 `cron_secret`（migration 自動產生）驗證，`last_tick` 記錄最後一次執行時間（Settings 頁顯示）。
- 每次 `tick` 最多處理約 110 秒，剩下的下次繼續；畫面上的 Apply now／Restore now 每次處理約 25 秒，自動連續呼叫到做完。
- 查排程：`select * from cron.job where jobname = 'sale-manager-tick';`、執行紀錄：`select * from cron.job_run_details order by start_time desc limit 20;`
- 停用排程：`select cron.unschedule('sale-manager-tick');`（再執行一次第二個 migration 就恢復）。
- 換 Supabase 專案時，要改第二個 migration 裡的網址和 anon key。

**不會重複、不會改錯**

- 同一個商品同時只能在一個沒結束的活動裡（資料庫 unique index 保證）。
- 每個商品處理時先「佔住」3 分鐘，排程和畫面同時跑也只會處理一次；中途斷掉的會在 3 分鐘後重試。
- 原價在改價**之前**就存進資料庫，重試時不會把特價誤當成原價。所有 Shopify 修改都是寫入固定的值（價格、tag），重複執行結果一樣。
- 改到一半就被結束的商品也會走還原流程（價格沒被改過的會自動略過）。

## 資料表

| 表 | 內容 |
|---|---|
| `sale.scans` | 每次掃描：狀態、bulk operation ID、統計、符合的商品（`results`） |
| `sale.campaigns` | 特價活動：名稱、開始／結束日期與時間、誰建立／取消／提前結束 |
| `sale.items` | 活動裡的每個商品：狀態、掃描時資料（`snapshot`）、原價與特價（`changes`）、備註、錯誤、套用／還原時間 |
| `sale.events` | 活動紀錄（建立、取消、提前結束、改結束日、重試、改密碼） |
| `sale.settings` | 密碼、`cron_secret`、`last_tick` |

## 測試

```bash
cd tests/sale-manager
npm install
npm test
```

用 PGlite（真的 Postgres）跑 migration，搭配假的 Shopify，測掃描條件、特價計算、套用、還原、排程、取消、重試、密碼。
