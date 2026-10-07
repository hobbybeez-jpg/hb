# 進貨進度追蹤（Receiving Tracker）

監控商品從進貨到上架的簡易進度條系統。和庫存系統（Hobby Bee Inventory v2）分開運作、分開登入，
所以不需要為每位員工建立庫存系統帳號；但會**唯讀**連動庫存系統的點貨單資料。

- 網址：`/tracker`（Netlify，檔案 `tracker.html`）
- 後端：Supabase Edge Function `receiving-tracker`（`supabase/functions/receiving-tracker/`）
- 資料：同一個 Supabase 資料庫的 `trk` schema（`supabase/migrations/20261006000001_receiving_tracker.sql`）
- **不會寫入庫存系統**（`wh` schema 只讀）
- 介面與錯誤訊息全部是英文（本文件為中文說明）

畫面上的英文名稱對照：

| 步驟 | 畫面名稱 | 分頁 | 畫面名稱 |
|---|---|---|---|
| 1 匯入點貨單 | Imported | 進貨表 | Shipments |
| 2 數量已確認 | Qty Confirmed | 掃描查詢 | UPC Lookup |
| 3 確認入庫存 | Inventory Confirmed | Renfrew 庫存 | Renfrew Stock |
| 4a 上架系統 | Listed Online | 異動紀錄 | Activity Log |
| 4b Renfrew 清點 | Renfrew Count | 設定 | Settings |
| 5 上架店內 | On Store Shelf | 待歸架 | To Put Away |

## 流程

| 步驟 | 誰 | 動作 | 需要 |
|---|---|---|---|
| 1 | 庫存系統人員 | 在庫存系統 Data Import 匯入點貨單 | 自動出現在追蹤清單 |
| 2 | 倉庫人員 | 在**庫存系統** Receiving 頁按 Finalize Shipment 左邊的「Qty Confirmed」（不需要 Finalize）；按 Finalize 時若還沒按過也會自動完成步驟 2。追蹤頁也可以按（備用） | — |
| 3 | 主管1 | 確認入庫存 | 步驟 2；主管1 密碼；庫存系統尚未 Finalize 時會提醒 |
| 4a | 主管2 | 商品上架系統 | 步驟 3；主管2 密碼 |
| 4b | Renfrew 店員 | 清點到貨商品（掃描 UPC 每次 +1，或直接輸入），**每掃一次就存檔**，可以分批、隔天繼續；全部點齊自動完成，缺貨可填備註後按 Complete 4b | 步驟 2（和 3 平行，不用等 3） |
| 5 | Renfrew 店員 | 4a、4b 都完成後，掃描 Pending 的商品上架店內（4a 完成後店員才看得到價格、打條碼） | 完成後進貨表自動隱藏（「已完成」可查） |

- 步驟 2 之後分成兩條平行支線：**3 → 4a**（主管）與 **4b**（Renfrew）。兩條都完成才能做 5。
  進度條中間分上下兩排：上排＝3、4a，下排＝4b。
- **沒有 Renfrew 商品的單**：4b、5 顯示「Not needed」，4a 完成後整張單自動完成並隱藏（撤銷 4a 會一起恢復）。
- 每個步驟記錄「誰、什麼時候」。按錯可以「Undo」（後面的步驟要先撤銷）。
- **密碼只用在步驟 3、4a 和它們的 Undo**（3＝主管1 密碼，4a＝主管2 密碼）；步驟 2、4b、5 和它們的 Undo 都不需要密碼。
- 撤銷 4b 只會重新打開清點，已點的數量和已歸架的商品都保留，可以直接修改。
- 步驟 5 時如果還有未歸架或 Pending 未清空的商品，會提醒，確認後仍可完成。

## 庫存系統的連動按鈕（Qty Confirmed）

- 庫存系統 Receiving 頁、Finalize Shipment 按鈕左邊的 **Qty Confirmed**：按下＝追蹤系統步驟 2 完成，倉庫人員不需要打開追蹤頁。
- 記錄的人員是庫存系統登入的帳號名稱（例如 amy）。已完成時按鈕變成綠色「✓ Qty Confirmed」，滑鼠移上去可看誰、何時按的。
- 按 Finalize Shipment 時，如果還沒按過 Qty Confirmed，會自動補上步驟 2。
- 被設為不追蹤（ignored）的單、或追蹤系統連不上時，按鈕自動隱藏，不影響收貨。
- 庫存系統呼叫追蹤系統的 `getStatus` 與 `completeStep`；舊的點貨單按下時會自動加入追蹤。
- 庫存系統前端的修改在 `New_WH` 專案的 `web/index.html`（V1.9），需要另外部署到 Cloudflare Pages。

## 主畫面與明細

- 清單：供應商、進貨表編號、建立日期、進度條（目前步驟為橘色）、庫存系統狀態、收貨進度。
- 明細：商品名、UPC、數量（下方小字＝已收）、分配到 PO／MARINE／RENFREW 的數量（來自庫存系統的計畫數量；
  實際分配不同時以小字顯示，PO 下方顯示已分配的訂單號碼）。
- 掃描查詢：掃 UPC 找出所屬的進貨表（未完成的排在前面），以及在 Renfrew 庫存的位置與待歸架數量。

## Renfrew 庫存（Renfrew Stock）

- 預設貨架：**Nendoroid（N）、POP UP PARADE（PP）、Prize Figure（PF）、Action Figure（A）、Blind Box（B）、MegaHouse（MH）** 和 **Pending（暫置）**。每個貨架預設一格，編號為 N-1、PP-1、PF-1、A-1、B-1、MH-1。可在「Manage Locations」新增格位（輸入貨架代碼會自動建議下一個編號，例如 N-2），或輸入新的貨架代碼與名稱建立新貨架（不需要密碼；刪除格位時該格必須是空的）。
- **待歸架**：點到的商品就可以歸架，不用等 4b 完成。每個商品分成兩部分：
  - **Pending**：預設 1 件（上店面用）。如果 Pending 裡已經有這個商品，或這張單已經放過，預設 0。
  - **Box**：其餘數量，預設放到這個 UPC 目前所在（或上次放）的格子；第一次出現的商品要選格子，或用「Set box for all」一次設定。
- **庫存系統數量變動提醒**：4b 完成後，若庫存系統又修改了 Renfrew 數量，明細會顯示「Inventory now X」。4b 未完成前清點清單會自動跟著庫存系統更新。
- **掃描移出 Pending**：每掃一次＝一件上架店內（步驟 5 的視窗裡也可以掃）。若所屬進貨表 4a 尚未完成會提醒。
- 點格位可以看內容、**移動**、**移出**（上架店內／售出／損壞／數量調整／其他）。同一格同一個 UPC 合成一行顯示（下方列出來自哪些進貨單）；移動、移出時自動先扣最早進來的。
- 店面庫存不追蹤：商品掃出 Pending（上店面）後就不再記錄。
- **手動加入商品**：不屬於任何進貨表的商品（例如盤點補登）。
- **異動紀錄**：所有歸架、移動、移出、手動加入的紀錄，可用 UPC 篩選。

## 登入與密碼

- 每位員工第一次開啟時輸入**名字**（記錄在步驟和異動上，存在瀏覽器）。點右上角名字可以更換。
- **共用裝置**：電腦和平板預設為共用裝置，**閒置 6 小時**（沒有點按、打字或掃描）後自動清除名字，下次使用要重新輸入；畫面自動更新不算使用。
  手機預設不是共用裝置，名字會一直保留。登入視窗的「Shared device」可以改，每台裝置各自記住。
- 密碼都以 bcrypt 雜湊存在 `trk.settings`，可在「設定」頁變更（需要管理密碼）：

| key | 用途 |
|---|---|
| `pw_access` | 員工密碼（進入系統）；未設定＝不需要 |
| `pw_step3` | 主管1：確認入庫存 |
| `pw_step4a` | 主管2：上架系統 |
| `pw_admin` | 管理密碼：只用於「設定」頁變更密碼；未設定時可用主管1或主管2的密碼 |

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
  不想追蹤的（例如長期開著的 Store Transfer）：`update trk.shipments set ignored = true where shipment_id = '...';`（改回 `false` 即恢復）。
  上線時已把 2026-10-01 以前建立、仍未 Finalize 的 6 筆（Anirevo 2026、New Store Transfer ×2、Walmart、Store Transfer、Plamod）設為 ignored。
  要把較舊的點貨單加入追蹤：`insert into trk.shipments (shipment_id, supplier, name, created_at) select shipment_id, supplier, name, created_at from wh.shipments where shipment_id = '...';`
- 明細：即時讀取 `wh.shipment_lines`、`wh.products`、`wh.allocations`（封存後改讀 `*_archive`）。
  - PO＝`required_po_qty`；已分配＝PO 分配＋已揀貨出貨的 PO。
  - RENFREW＝`required_renfrew_qty`；已分配＝RENFREW 分配。
  - MARINE＝數量 − PO − RENFREW；已上架＝MARINE 分配。
  - 4b 清點的應到數量＝RENFREW 計畫與實際分配取較大者。
- UPC 比對忽略開頭的 0（UPC-A 12 碼／EAN 13 碼都找得到）。
