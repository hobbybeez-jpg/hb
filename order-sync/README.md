# 訂單逐筆處理（Shopify → 庫存/出貨/預購）

輸入一個 Shopify 單號，先**預覽**會寫到哪個試算表、哪個分頁、第幾列、每一欄的值和顏色，確認後再按**寫入**。
目前是逐筆人工確認的版本；逐筆檢視沒問題後，再加上定時自動處理。

- 程式放在**另外新建的 Google Sheet**（訂單自動化控制台）裡，用試算表 ID 去讀寫
  庫存/出貨/預購、2025／2024 已出貨、PW/PO。原本那些試算表裡的 Apps Script 不用改，也不會互相干擾。
- 預覽不會改任何東西。寫入前會重新讀一次 Shopify 和試算表，內容和預覽不同就要求重新預覽。
- 每次寫入都記在控制台的「紀錄」分頁（單號、寫到哪幾列、警告、誰按的）。

## 安裝

1. **新建一個 Google Sheet**，例如「訂單自動化控制台」。選單 **擴充功能 → Apps Script** 開啟（空的專案就好）。
2. 把程式放進去：設定好下面的「自動更新」後，到 GitHub 的 **Actions → order-sync deploy → Run workflow** 執行一次，
   程式就會自動推上去，不用貼。
   （不想設定自動更新的話，也可以手動把 `src/` 的檔案逐一建立貼上：`.js` 建成「指令碼」檔、`Dialog.html` 建成 HTML 檔，
   `appsscript.json` 在專案設定勾「在編輯器中顯示 appsscript.json」後貼上。）
3. 回到試算表重新整理，會出現選單 **訂單自動化**。按 **建立／補齊「設定」和「紀錄」分頁**（第一次會要求授權）。
4. 在「設定」分頁填：

   | 設定 | 填什麼 |
   |---|---|
   | `SHOPIFY_STORE` | `你的商店.myshopify.com` |
   | `MAIN_SHEET_ID` | 庫存/出貨/預購（2026）的網址或 ID |
   | `POPW_SHEET_ID` | PW/PO（Private Warehouse / PO Arrival）的網址或 ID |
   | `YEAR_SHEET_2025`、`YEAR_SHEET_2024` | 2025、2024 已出貨獨立檔的網址或 ID |
   | `ALERT_EMAIL` | 預購應付和已付對不起來時通知誰 |

   整個網址直接貼上也可以，會自動取出 ID。每年新增獨立年份檔時，加一列 `YEAR_SHEET_2026` 之類。
5. **Shopify app**：在 Shopify Dev Dashboard 建一個只給這個工具用的 app（和 Receiving Tracker 的做法一樣），
   Scopes 填 `read_orders,read_products`，App URL 填 `https://example.com`（這個工具用不到），安裝到商店，
   然後用選單 **設定 Shopify 金鑰** 貼上 Client ID 和 Client secret。
   （2026 年以前在後台建的舊式 custom app，可以在第一個問題留空，改貼 `shpat_…` token。）
   金鑰存在 Apps Script 的指令碼屬性，不會出現在試算表裡。
6. 用選單 **測試 Shopify 連線** 輸入一個單號，看得到訂單的原始資料就代表設定好了。
   這裡也可以檢查手續費：Shopify Payments 看 `transactions → fees`，PayPal 看 `receiptJson` 裡的 fee。

## 自動更新

`main` 上的 `order-sync/` 有變動時，GitHub Action（`.github/workflows/order-sync-deploy.yml`）會先跑測試，
通過才用 [clasp](https://github.com/google/clasp) 把 `src/` 推到控制台的 Apps Script。只需要設定一次：

1. 打開 <https://script.google.com/home/usersettings>，把 **Google Apps Script API** 打開。
2. 控制台的 Apps Script → **專案設定**，複製「指令碼 ID」。
3. 在自己的電腦（要有 Node.js）執行一次：
   ```
   npx @google/clasp@2.4.2 login
   ```
   瀏覽器登入 Google 後，會產生 `~/.clasprc.json`（Windows 在 `C:\Users\你的名字\.clasprc.json`）。
4. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**，新增兩個：
   - `ORDER_SYNC_SCRIPT_ID`：第 2 步的指令碼 ID
   - `CLASPRC_JSON`：`.clasprc.json` 的整個內容

注意：`CLASPRC_JSON` 等於你 Google 帳號編輯 Apps Script 的權限，只放在 GitHub secret，不要貼到別的地方。
推上去會**覆蓋**整個 Apps Script 專案的程式（設定、金鑰、「設定」「紀錄」分頁都不受影響），所以請不要直接在 Apps Script 編輯器裡改程式，要改就改 repo。

沒有 `read_all_orders`（Dev Dashboard 不接受這個權限），所以只讀得到最近 60 天的訂單：POPW 出貨單的原單超過 60 天時，
N 欄（原單手續費）留空、原單的保險不會自動加到 L 欄，預覽會用黃色提示，請人工補上。

## 使用

選單 **訂單自動化 → 開啟逐筆／批次處理**。

### 批次：找出還沒登記的單，一次寫入

左邊「找未登記的訂單」選日期範圍（預設最近 3 天，最多 31 天），按「掃描」。程式會從最早的單開始逐張判斷：

| 狀態 | 意思 |
|---|---|
| 可寫入 | 沒有錯誤也沒有警告，預設勾選 |
| 需確認 | 有警告（例如原單超過 60 天讀不到手續費），先按「檢視」看過再勾 |
| 錯誤 | 例如找不到原單號、INT 還沒付清，不能寫入 |
| 部分已登記 | 一張單有些商品已經記過、有些沒有，請人工處理 |
| 已登記 | 要新增的列都已經在試算表裡（不管是人工還是程式寫的），或「紀錄」分頁顯示寫入過 |
| 不用記錄／略過 | 只有禮物卡之類的商品；已取消、測試訂單 |

按「寫入勾選的 N 張」會照訂單時間先後寫入，寫完每張單會列出寫到哪幾列的連結。
單數多的時候會自動分段（Apps Script 一次最多跑 6 分鐘），畫面會接著跑完。

### 逐筆

左邊是最近 25 張訂單（寫入過的會標「已寫入」），點一下或輸入單號按「預覽」。

預覽會列出：
- Shopify 每個商品被判斷成什麼（現貨／預購／backorder／服務費／POPW 出貨／不記錄）
- 每筆付款和手續費（讀不到會標出來）
- 錯誤（紅色，不能寫入）、警告（黃色，要勾「我已確認」才能寫入）、說明
- 每一個要新增或修改的列：分頁、列號、每一欄的值、顏色

寫入後會列出每一列的連結，可以直接點過去檢查。

## 規則

### 新訂單（現貨、PW、預購、backorder）

| 項目 | 規則 |
|---|---|
| 單號 | 只有一個商品：`CA53126D`；多個：`CA53126D-1`、`-2`…，**現貨先編號、預購/backorder 後編號**。保險、禮品包裝、Storage Fee、運費類自訂商品不佔編號 |
| 分頁 | 寄送國家是加拿大、美國，或自取、PW → `{年}已出貨 CA`；其他國家 → `{年}已出貨 INT`。年份＝訂單日期（溫哥華時間）的年份 |
| Platform | POS → `Store`；其他 → `Shopify` |
| K Sales Price | 單價 × 數量 − 這個商品分到的折扣（用 Shopify 自己的折扣分配，整單折扣碼是按金額比例分攤） |
| L Shipping Charged | 第一項＝運費（扣掉運費折扣）＋保險＋禮品包裝＋Storage Fee＋運費類自訂商品；第二項起 0 |
| M Shipping Cost | 線上寄送：第一項留空（之後填實際運費），第二項起 0、灰色；自取：每項 0、青色；PW：每項留空、橘色；POS：0 |
| N Platform Fee | 第一項＝手續費（Shopify Payments 的 fees 或 PayPal receipt 裡的 fee，現金 0）；有預購的混合單按已付金額比例只算現貨部分 |
| INT | 要等客人付完運費 invoice（不是 partially paid）才處理；N＝第一筆付款的手續費，O＝補運費那筆的手續費 |
| PW | 已出貨照常記（M 橘色），另外在 PW/PO 的「PO/PW」分頁新增：C=`PW`（灰底）、D=訂單日期、E 單號、F 品名、G UPC、I 數量、J email，H/L/M/P/Q 公式從上一列複製 |
| 預購 | 只記在「預購」分頁：A 單號、B（backorder＝`backorder`；只有預購而且有付運費＝`shipping paid` 藍底）、C 日期、D 品名（去掉款式和 [Backorder]）、I UPC、L 數量、M 單價應付、N 已付總額。訂金：M＝訂金×5−0.01（不是 .99 結尾會警告）。有折扣時 M 和 N 都扣。J、K 公式從上一列複製；O＝訂金 `=M*L-N`，全額 `---` |
| 訂貨 | 預購/backorder 的 UPC 在「訂貨」B 欄找不到時，在最後一筆資料下面新增 A 品名、B UPC、C Pre-Order Deadline（從商品敘述 `Pre-Order Deadline: 2026-10-23` 讀） |
| 不記錄 | Gift Card、Coin Exchange、Transaction Fee、Cancellation Fee、Duties，會在預覽裡列出 |
| H Supplier | 留空，人工填 |

### POPW 出貨單（Draft 單，商品名稱是 `CA46701D⇥品名⇥(UPC)⇥日期`）

- **預購／backorder 到貨**（預購表找得到這個單號）：
  - 預購表：B 改 `Y`；N 加上這次付的金額（`=78+311.99`）；應付（M×L）＝已付 → 整列綠色，不相等 → 整列橘色並寄信。
  - 已出貨：寫到**原單年份**的分頁（2025 的原單寫到 2025 獨立檔），國外寄送寫 INT。
    A 原單號、B 原單日期、C `PO-Shopify`（原本是 backorder 寫 `Shopify`）、D 品名、J 數量、K 應付總額、
    L 第一項＝出貨單運費＋服務費，再加上原單沒記過的保險／運費（原單只有預購、而且這是原單第一個出貨的商品才加）、
    M 規則同上、N 原單手續費（按這個商品在原單的已付金額比例）、O 第一項＝出貨單的手續費。
- **PW 存放的現貨出貨**（已出貨找得到這個單號）：不新增列，改原本那一列：L 加上出貨單運費＋服務費、O＝出貨單手續費（只改第一項）。PW/PO 試算表那一列的標記人工處理。
- 兩邊都找不到 → 錯誤，不寫入。

## 已知和過去人工紀錄不同的地方

用 2026-09-01 ～ 10-14 的訂單匯出（2,018 張）回放，和試算表逐欄比對：

- 大部分欄位 96–100% 相同。
- **折扣**：以前整筆折扣扣在其中一項，現在按金額比例分攤（K、預購 M/N 約 7% 的列因此不同）。
- **M 欄顏色**：以前自取青色、第二項灰色只有部分訂單有標，現在一律照規則標。
- **商品順序**：約 2% 的多件訂單，人工編號的順序和 Shopify 不同。
- **日期**：午夜之後的訂單有幾筆人工記成前一天，現在一律用 Shopify 的訂單日期。
- 試算表裡幾筆品名打錯字、UPC 少一位（Shopify 的 SKU 少一位，程式會優先用 Barcode）。

## 開發

```
cd order-sync
npm test                                   # 規則、寫入（假的試算表）、Shopify 資料轉換
node tools/replay.js orders.csv sheet.json # 用訂單匯出回放並和試算表比對
```

`sheet.json` 是試算表各分頁的資料（`{ "2026已出貨 CA": [{ "r": 列, "v": [A..O], "colors": { "M": "#ffff00" } }], "預購": [...] }`）。
訂單匯出和試算表資料含客人個資，**不要放進 repo**。
