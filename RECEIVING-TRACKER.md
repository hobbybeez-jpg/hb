# 進貨進度追蹤（Receiving Tracker）

監控商品從進貨到上架的簡易進度條系統。和庫存系統（Hobby Bee Inventory v2）分開運作、分開登入，
所以不需要為每位員工建立庫存系統帳號；但會**唯讀**連動庫存系統的點貨單資料。

- 網址：`/tracker`（Netlify，檔案 `tracker.html`）
- 後端：Supabase Edge Function `receiving-tracker`（`supabase/functions/receiving-tracker/`）
- 資料：同一個 Supabase 資料庫的 `trk` schema（`supabase/migrations/20261006000001_receiving_tracker.sql`）
- **不會寫入庫存系統**（`wh` schema 只讀）

## 流程

| 步驟 | 誰 | 動作 | 需要 |
|---|---|---|---|
| 1 | 庫存系統人員 | 在庫存系統 Data Import 匯入點貨單 | 自動出現在追蹤清單 |
| 2 | 倉庫人員 | 點好數量後按「數量已確認」（不需要 Finalize） | — |
| 3 | 主管1 | 確認入庫存 | 步驟 2；主管1 密碼；庫存系統尚未 Finalize 時會提醒 |
| 4a | 主管2 | 商品上架系統 | 步驟 3；主管2 密碼 |
| 4b | Renfrew 店員 | 清點到貨商品（掃描 UPC 每次 +1，或直接輸入），數量不符要填備註；完成後歸架 | 步驟 2（和 3 平行，不用等 3） |
| 5 | Renfrew 店員 | 4a、4b 都完成後，掃描 Pending 的商品上架店內 | 完成後進貨表自動隱藏（「已完成」可查） |

- 步驟 2 之後分成兩條平行支線：**3 → 4a**（主管）與 **4b**（Renfrew）。兩條都完成才能做 5。
  進度條中間分上下兩排：上排＝3、4a，下排＝4b。
- 每個步驟記錄「誰、什麼時候」。按錯可以「撤銷」（需要主管密碼，且後面的步驟要先撤銷；已經有商品歸架的 4b 不能撤銷）。
- 步驟 5 時如果還有未歸架或 Pending 未清空的商品，會提醒，確認後仍可完成。

## 主畫面與明細

- 清單：供應商、進貨表編號、建立日期、進度條（目前步驟為橘色）、庫存系統狀態、收貨進度。
- 明細：商品名、UPC、數量（下方小字＝已收）、分配到 PO／MARINE／RENFREW 的數量（來自庫存系統的計畫數量；
  實際分配不同時以小字顯示，PO 下方顯示已分配的訂單號碼）。
- 掃描查詢：掃 UPC 找出所屬的進貨表（未完成的排在前面），以及在 Renfrew 倉庫的位置與待歸架數量。

## Renfrew 倉庫

- 預設貨架：**N、PP、PF、A、B、MH** 和 **Pending（暫置）**。可在「管理格位」新增格位（例如 N-1、N-2）或新的貨架（需要主管密碼）。
- **待歸架**：4b 清點完的商品進入待歸架清單，選位置歸架（可一次「全部放到」某個位置）。
- **掃描移出 Pending**：每掃一次＝一件上架店內（步驟 5 的視窗裡也可以掃）。若所屬進貨表 4a 尚未完成會提醒。
- 點格位可以看內容、**移動**、**移出**（上架店內／售出／損壞／數量調整／其他）。
- **手動加入商品**：不屬於任何進貨表的商品（例如盤點補登）。
- **異動紀錄**：所有歸架、移動、移出、手動加入的紀錄，可用 UPC 篩選。

## 登入與密碼

- 每位員工第一次開啟時輸入**名字**（記錄在步驟和異動上，存在瀏覽器）。
- 密碼都以 bcrypt 雜湊存在 `trk.settings`，可在「設定」頁變更（需要管理密碼）：

| key | 用途 |
|---|---|
| `pw_access` | 員工密碼（進入系統）；未設定＝不需要 |
| `pw_step3` | 主管1：確認入庫存 |
| `pw_step4a` | 主管2：上架系統 |
| `pw_admin` | 管理密碼：撤銷步驟、管理格位、變更密碼；未設定時可用主管1或主管2的密碼 |

第一次設定（Supabase SQL Editor，把密碼換成你的）：

```sql
insert into trk.settings (key, value) values
  ('pw_step3',  extensions.crypt('主管1密碼', extensions.gen_salt('bf', 8))),
  ('pw_step4a', extensions.crypt('主管2密碼', extensions.gen_salt('bf', 8))),
  ('pw_admin',  extensions.crypt('管理密碼',  extensions.gen_salt('bf', 8))),
  ('pw_access', extensions.crypt('員工密碼',  extensions.gen_salt('bf', 8)))
on conflict (key) do update set value = excluded.value, updated_at = now();
```

## 部署

1. 資料庫：在 Supabase SQL Editor 執行 `supabase/migrations/20261006000001_receiving_tracker.sql`
   （或 `npx supabase db push`）。會建立 `trk` schema、預設貨架，並把上線當下**尚未 Finalize** 的點貨單加入追蹤；
   之後新建立的點貨單會自動加入。
2. Edge Function：`npx supabase functions deploy receiving-tracker --project-ref <ref>`
   （保持 JWT 驗證開啟；前端用公開的 anon key 呼叫）。
   選填 Secret：`TRACKER_ALLOWED_ORIGINS`（例如 Netlify 網址），限制只有這個網站能呼叫。
3. 設定密碼（上面的 SQL）。
4. Netlify 會自動部署 `tracker.html`，開啟 `https://<你的網站>/tracker`。

## 連動方式（技術說明）

- 追蹤清單：`trk.shipments`，每次開啟清單時把 `go_live` 之後在 `wh.shipments` 建立的點貨單加入。
  要把較舊的點貨單加入追蹤：`insert into trk.shipments (shipment_id, supplier, name, created_at) select shipment_id, supplier, name, created_at from wh.shipments where shipment_id = '...';`
- 明細：即時讀取 `wh.shipment_lines`、`wh.products`、`wh.allocations`（封存後改讀 `*_archive`）。
  - PO＝`required_po_qty`；已分配＝PO 分配＋已揀貨出貨的 PO。
  - RENFREW＝`required_renfrew_qty`；已分配＝RENFREW 分配。
  - MARINE＝數量 − PO − RENFREW；已上架＝MARINE 分配。
  - 4b 清點的應到數量＝RENFREW 計畫與實際分配取較大者。
- UPC 比對忽略開頭的 0（UPC-A 12 碼／EAN 13 碼都找得到）。
