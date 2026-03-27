# AMC 積點系統後端

空中美語名間分校｜兒童節積點刷卡系統

## 功能

- 教室管理（新增／刪除）
- 老師卡片綁定（老師卡號 → 負責教室）
- 學生刷卡得點（需先以老師卡登入）
- 即時排行榜（WebSocket 推播）
- 冰淇淋拉霸機（積點換抽獎次數）
- Excel 批次匯入學生名單

## 技術棧

- **後端**：Node.js + Express
- **資料庫**：SQLite（better-sqlite3）
- **即時更新**：WebSocket（ws）
- **部署**：Railway

## 快速啟動

```bash
npm install
npm start
```

預設 port：`3000`，可透過環境變數 `PORT` 覆蓋。
資料庫路徑預設為 `data.db`，可透過 `DB_PATH` 覆蓋。

### Railway 必要環境變數

| 變數名稱 | 值 | 說明 |
|----------|----|------|
| `DB_PATH` | `/data/data.db` | 搭配 Railway Volume 持久化資料庫 |
| `TZ` | `Asia/Taipei` | 修正伺服器時區，確保時間顯示正確 |

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/classrooms` | 取得所有教室 |
| POST | `/api/classrooms` | 新增教室 |
| DELETE | `/api/classrooms/:id` | 刪除教室（含相關紀錄）|
| GET | `/api/teachers` | 取得所有老師綁定 |
| POST | `/api/teachers` | 新增／更新老師綁定 |
| DELETE | `/api/teachers/:cardId` | 刪除老師綁定 |
| GET | `/api/students` | 取得學生名單（map）|
| POST | `/api/students` | 單筆新增／更新學生 |
| POST | `/api/students/batch` | 批次匯入學生 |
| DELETE | `/api/students/:cardId` | 刪除學生 |
| GET | `/api/records` | 取得所有刷卡紀錄 |
| POST | `/api/records` | 新增刷卡紀錄（需老師卡驗證）|
| DELETE | `/api/records` | 清除所有紀錄 |
| GET | `/api/slot/status/:cardId` | 查詢拉霸機狀態 |
| POST | `/api/slot/play` | 執行一次拉霸 |
| GET | `/api/slot/winners` | 今日得獎名單 |
| GET | `/health` | 健康檢查 |

## WebSocket 事件

伺服器廣播以下事件給所有已連線的客戶端：

| 事件 | 說明 |
|------|------|
| `record_added` | 有學生刷卡 |
| `records_cleared` | 所有紀錄已清除 |
| `classroom_added` | 新增教室 |
| `classroom_deleted` | 刪除教室 |
| `student_updated` | 學生資料更新 |
| `students_batch_updated` | 批次匯入完成 |
| `student_deleted` | 學生資料刪除 |
| `slot_win` | 拉霸中獎 |
| `slot_play` | 拉霸一次 |

## 已知修正

- **重複寫入**：修正 WebSocket 廣播與本地樂觀更新的 race condition，避免同一筆資料在 client 端 `data.records` / `data.classrooms` 被 push 兩次。
- **今日刷卡紀錄顯示**：
  - 每一筆刷卡以獨立一行呈現（學生姓名、教室、老師、時間），不再顯示歷史總累積點數。
  - 移除 10 筆上限，當天所有刷卡紀錄全數顯示。
  - 從其他頁切回「刷卡」頁時列表自動刷新。
- **時區修正**：`today()` 改用 `toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })` 取得台灣日期，避免 UTC 與台灣時間（UTC+8）日期不一致；拉霸中獎時間顯示需同步在 Railway 設定 `TZ=Asia/Taipei` 環境變數。
