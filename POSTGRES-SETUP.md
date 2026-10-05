# 改用 PostgreSQL 保存曲庫

這個更新包只更新後端與 Dockerfile，不含 data/songs.json、data/songs.sqlite、src 或 dist。
它不會覆蓋 GitHub 裡的歌曲清單或介面。你在網站新增的資料需要透過備份移到新資料庫。

## 1. 先下載目前還存在的歌曲與歌詞

先解壓縮這份 ZIP 到一個獨立資料夾，暫時不要覆蓋 GitHub 專案，也不要重新部署。
在解壓後的資料夾開 PowerShell，執行：

```powershell
powershell -ExecutionPolicy Bypass -File ".\tools\export-current.ps1"
```

腳本從現有公開歌曲 API 逐首下載完整資料，不會修改網站。
完成後，下載資料夾會出現 pk-library-backup-日期時間.json。
請確認終端顯示「備份完成」與歌曲數量，再繼續。
備份也包含 YouTube 網址和備註。已經消失的歌詞無法透過這個腳本復原。
匯出期間先暫停在網站新增、修改、刪除歌曲；失敗時腳本不會輸出一份不完整的備份。

## 2. 建立 Neon 資料庫

前往 https://console.neon.tech，註冊或登入。
建立一個 Free 方案的專案，例如 pk-song-library，使用預設 PostgreSQL 資料庫即可。
打開專案的 Connect，複製完整的 PostgreSQL connection string。
可使用 pooled 連線，保留原本的 sslmode 等參數。
這條網址包含資料庫密碼，只填入 Render 環境變數；不要放進 GitHub 或貼在公開訊息中。
請保留此專案與同一個 production 分支，網站更新時繼續用同一條連線。

## 3. 設定 Render，再上傳程式

完成第一步備份後，到 Render 的 7unslib 服務 → Environment，新增：

| Key | Value |
| --- | --- |
| DATABASE_URL | Neon Connect 畫面複製的完整連線網址 |

保留原本 ADMIN_PASSWORD 與其他設定。
如果修改環境變數觸發舊程式部署，現有資料可能再次重置，所以必須先完成備份。

將更新包的 Dockerfile、server、tools、POSTGRES-SETUP.md 複製到你 clone 下來的 GitHub 專案，合併資料夾並取代同名檔案。
保留原本 data、src、dist 資料夾。
在該 GitHub 專案的 PowerShell 執行：

```powershell
git rev-parse --show-toplevel
git status --short
git add Dockerfile server tools POSTGRES-SETUP.md
git commit -m "改用雲端資料庫並加入曲庫備份還原"
$branch = (git branch --show-current).Trim()
git push -u origin $branch
```

執行前確認第一行顯示的是你的 GitHub 專案資料夾，不是 Downloads 或使用者主資料夾。
Render 會使用新 Dockerfile 安裝 PostgreSQL 驅動並部署。
若缺少 DATABASE_URL，新程式會拒絕啟動，不會退回暫存資料庫。
若部署失敗，先查看 Logs 的訊息，不要重填歌曲資料。

## 4. 將備份匯入雲端

新建立的 Neon 曲庫一開始會是空的，因為資料尚未搬進去。
先進網站點「歌曲管理」，輸入原本管理密碼。
然後在同一個瀏覽器開：

https://songdatabase-1.onrender.com/admin/backup

選擇第一步下載的 JSON，確認預覽歌曲與歌詞數量，按「匯入這份備份」。
如果網站已經沒有任何可匯出的歌曲，可選你 GitHub 專案原本的 data/songs.json 匯入；這只能還原該檔案裡的內容。
匯入新增缺少的 ID，並補上空白的歌詞、網址、備註；不會刪除現有歌曲或覆蓋已填寫的歌詞。
同一份備份重複匯入，不會重複新增同一 ID 的歌曲。

## 5. 確認保存成功

匯入後先查看歌曲、歌詞與備註是否完整，並下載一份新的 JSON 備份。
新增一首自己輸入文字的測試歌，儲存後在 Render 重啟服務。
重啟後確認測試歌與文字仍在，再刪除測試歌。
之後網站更新不需要重新上傳曲庫，持續使用同一個 DATABASE_URL 即可。
請定期透過 /admin/backup 下載備份，並留意 Neon 帳戶的容量及方案限制。

## 驗證範圍

已完成本機 SQLite 模式的 HTTP 驗證：管理登入、受保護的完整匯出、匯入交易、錯誤資料拒絕、合唱歌手搜尋、編輯與刪除後重啟保留資料。
已檢查 PostgreSQL 參數轉換與伺服器語法。
尚未使用你的 Neon 資料庫測試實際 PostgreSQL 連線。部署後需完成第五步確認，不能把本機測試當成已驗證雲端連線。
