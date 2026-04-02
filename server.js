const express = require('express');
const cors    = require('cors');
const Database= require('better-sqlite3');
const http    = require('http');
const { WebSocketServer } = require('ws');
const path    = require('path');

// ── Setup ──────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Database ───────────────────────────────────────
const db = new Database(process.env.DB_PATH || 'data.db');

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS classrooms (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS students (
    card_id TEXT PRIMARY KEY,
    name    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS teachers (
    card_id      TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    classroom_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS records (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id      TEXT NOT NULL,
    classroom_id TEXT NOT NULL,
    teacher_card_id TEXT,
    timestamp    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS slot_plays (
    card_id  TEXT NOT NULL,
    play_date TEXT NOT NULL,
    count    INTEGER DEFAULT 0,
    PRIMARY KEY (card_id, play_date)
  );

  CREATE TABLE IF NOT EXISTS slot_wins (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id   TEXT NOT NULL,
    win_date  TEXT NOT NULL,
    win_time  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS slot_entries (
    card_id    TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    PRIMARY KEY (card_id, entry_date)
  );

  CREATE TABLE IF NOT EXISTS slot_draws (
    draw_date TEXT PRIMARY KEY,
    drawn_at  TEXT NOT NULL
  );
`);

// ── DB migration (for existing data.db) ─────────────
// Add teacher_card_id column if the table was created before this feature.
try {
  db.exec('ALTER TABLE records ADD COLUMN teacher_card_id TEXT');
} catch (e) {}

// ── WebSocket broadcast ────────────────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', ws => {
  console.log('Client connected, total:', wss.clients.size);
  ws.on('close', () => console.log('Client disconnected'));
});

// ── Helper ─────────────────────────────────────────
function today() {
  // Taiwan date (UTC+8)
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return tw.toISOString().slice(0, 10);
}

function currentHour() {
  // UTC hour prefix — matches win_time ISO format stored in DB
  // e.g. "2025-04-01T08" when Taiwan time is 16:xx
  return new Date().toISOString().slice(0, 13);
}

function twHour() {
  // Taiwan local hour (UTC+8), used only for activity time check
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return tw.getUTCHours(); // 0-23 in Taiwan time
}

// ── API: Classrooms ────────────────────────────────
app.get('/api/classrooms', (req, res) => {
  const rows = db.prepare('SELECT * FROM classrooms').all();
  res.json(rows);
});

app.post('/api/classrooms', (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  try {
    db.prepare('INSERT OR REPLACE INTO classrooms (id, name) VALUES (?, ?)').run(id, name);
    broadcast('classroom_added', { id, name });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/classrooms/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM classrooms WHERE id = ?').run(id);
  db.prepare('DELETE FROM teachers WHERE classroom_id = ?').run(id);
  db.prepare('DELETE FROM records WHERE classroom_id = ?').run(id);
  broadcast('classroom_deleted', { id });
  res.json({ ok: true });
});

// ── API: Students ──────────────────────────────────
app.get('/api/students', (req, res) => {
  const rows = db.prepare('SELECT card_id, name FROM students').all();
  // Return as { cardId: name } map
  const map = {};
  rows.forEach(r => { map[r.card_id] = r.name; });
  res.json(map);
});

app.post('/api/students', (req, res) => {
  const { cardId, name } = req.body;
  if (!cardId || !name) return res.status(400).json({ error: 'cardId and name required' });
  db.prepare('INSERT OR REPLACE INTO students (card_id, name) VALUES (?, ?)').run(cardId, name);
  broadcast('student_updated', { cardId, name });
  res.json({ ok: true });
});

app.post('/api/students/batch', (req, res) => {
  const { students } = req.body; // [{ cardId, name }]
  if (!Array.isArray(students)) return res.status(400).json({ error: 'students array required' });
  const insert = db.prepare('INSERT OR REPLACE INTO students (card_id, name) VALUES (?, ?)');
  const tx = db.transaction(() => {
    students.forEach(({ cardId, name }) => insert.run(cardId, name));
  });
  tx();
  broadcast('students_batch_updated', { count: students.length });
  res.json({ ok: true, count: students.length });
});

app.delete('/api/students/:cardId', (req, res) => {
  db.prepare('DELETE FROM students WHERE card_id = ?').run(req.params.cardId);
  broadcast('student_deleted', { cardId: req.params.cardId });
  res.json({ ok: true });
});

// ── API: Teachers ──────────────────────────────────
app.get('/api/teachers', (req, res) => {
  const rows = db.prepare('SELECT card_id as cardId, name, classroom_id as classroomId FROM teachers ORDER BY name ASC').all();
  res.json(rows);
});

app.post('/api/teachers', (req, res) => {
  const { cardId, name, classroomId } = req.body;
  if (!cardId || !name || !classroomId) {
    return res.status(400).json({ error: 'cardId, name, classroomId required' });
  }

  try {
    db.prepare('INSERT OR REPLACE INTO teachers (card_id, name, classroom_id) VALUES (?, ?, ?)').run(cardId, name, classroomId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/teachers/:cardId', (req, res) => {
  const { cardId } = req.params;
  db.prepare('DELETE FROM teachers WHERE card_id = ?').run(cardId);
  res.json({ ok: true });
});

app.get('/api/teachers/lookup', (req, res) => {
  const { cardId } = req.query;
  if (!cardId) return res.status(400).json({ error: 'cardId required' });
  const row = db.prepare('SELECT card_id as cardId, name, classroom_id as classroomId FROM teachers WHERE card_id = ?').get(cardId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// ── API: Records (check-in) ────────────────────────
app.get('/api/records', (req, res) => {
  const rows = db.prepare(
    `SELECT
      r.card_id as cardId,
      r.classroom_id as classroomId,
      r.teacher_card_id as teacherCardId,
      t.name as teacherName,
      r.timestamp as timestamp
    FROM records r
    LEFT JOIN teachers t ON t.card_id = r.teacher_card_id
    ORDER BY r.timestamp DESC`
  ).all();
  res.json(rows);
});

app.post('/api/records', (req, res) => {
  const { cardId, classroomId, timestamp, teacherCardId } = req.body;
  if (!cardId || !classroomId || !timestamp || !teacherCardId) {
    return res.status(400).json({ error: 'cardId, classroomId, timestamp, teacherCardId required' });
  }

  // Validate teacher exists and is responsible for the classroom.
  const teacher = db.prepare('SELECT card_id as cardId, name, classroom_id as classroomId FROM teachers WHERE card_id = ?').get(teacherCardId);
  if (!teacher) return res.status(403).json({ error: 'teacher not bound' });
  if (teacher.classroomId !== classroomId) return res.status(403).json({ error: 'teacher classroom mismatch' });

  db.prepare(
    'INSERT INTO records (card_id, classroom_id, teacher_card_id, timestamp) VALUES (?, ?, ?, ?)'
  ).run(cardId, classroomId, teacherCardId, timestamp);

  // Get total points for this card
  const { total } = db.prepare(
    'SELECT COUNT(*) as total FROM records WHERE card_id = ?'
  ).get(cardId);

  broadcast('record_added', {
    cardId,
    classroomId,
    teacherCardId,
    teacherName: teacher.name,
    timestamp,
    totalPts: total
  });
  res.json({ ok: true, totalPts: total });
});

app.delete('/api/records', (req, res) => {
  db.prepare('DELETE FROM records').run();
  broadcast('records_cleared', {});
  res.json({ ok: true });
});

// ── API: Lottery (加權抽獎) ────────────────────────
const MAX_DAILY_WINS      = 20;  // 全體每日上限
const MAX_WINS_PER_PERSON = 2;   // 每人累計最多中獎次數
const COST_PER_PLAY       = 5;   // 每 5 點換 1 次

// 中獎機率（依累計中獎次數）
function getWinProb(histWins) {
  if (histWins === 0) return 0.12;  // 0 勝 → 12%
  if (histWins === 1) return 0.05;  // 1 勝 → 5%
  return 0;                         // 2 勝以上 → 0%（可參加但不中獎）
}

// 加權隨機抽取 count 名，不重複
function weightedDraw(cardIds, weightMap, count) {
  const pool = [...cardIds];
  const winners = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const totalWeight = pool.reduce((sum, id) => sum + weightMap[id], 0);
    let rand = Math.random() * totalWeight;
    let selectedIdx = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      rand -= weightMap[pool[j]];
      if (rand <= 0) { selectedIdx = j; break; }
    }
    winners.push(pool[selectedIdx]);
    pool.splice(selectedIdx, 1);
  }
  return winners;
}

// GET /api/slot/status/:cardId — 查詢個人狀態
app.get('/api/slot/status/:cardId', (req, res) => {
  const { cardId } = req.params;
  const date = today();

  // 積點與可用次數
  const { total }      = db.prepare('SELECT COUNT(*) as total FROM records WHERE card_id = ?').get(cardId);
  const row            = db.prepare('SELECT count FROM slot_plays WHERE card_id = ? AND play_date = ?').get(cardId, date);
  const usedPlays      = row ? row.count : 0;
  const earnedPlays    = Math.floor(total / COST_PER_PLAY);
  const availablePlays = Math.max(0, earnedPlays - usedPlays);

  // 中獎資訊
  const { todayCnt }  = db.prepare('SELECT COUNT(*) as todayCnt FROM slot_wins WHERE card_id = ? AND win_date = ?').get(cardId, date);
  const { histWins }  = db.prepare('SELECT COUNT(*) as histWins FROM slot_wins WHERE card_id = ?').get(cardId);
  const { totalWins } = db.prepare('SELECT COUNT(*) as totalWins FROM slot_wins WHERE win_date = ?').get(date);
  const canWin        = histWins < MAX_WINS_PER_PERSON;  // 2 勝以上中獎率 0%

  res.json({
    totalPts:        total,
    availablePlays,
    usedPlays,
    earnedPlays,
    hasWonToday:     todayCnt > 0,
    winCount:        histWins,
    winProb:         getWinProb(histWins),
    canWin,
    remainingPrizes: Math.max(0, MAX_DAILY_WINS - totalWins),
    totalWins
  });
});

// POST /api/slot/play — 每 5 點換 1 次，未中可繼續抽（台灣時間 13:00–20:00）
app.post('/api/slot/play', (req, res) => {
  const { cardId } = req.body;
  if (!cardId) return res.status(400).json({ error: 'cardId required' });

  const twH = twHour();
  if (twH < 13 || twH >= 20) {
    return res.status(400).json({ error: 'closed', message: '活動時間為台灣時間 13:00–20:00' });
  }

  const date = today();

  // 確認有剩餘次數
  const { total }   = db.prepare('SELECT COUNT(*) as total FROM records WHERE card_id = ?').get(cardId);
  const row         = db.prepare('SELECT count FROM slot_plays WHERE card_id = ? AND play_date = ?').get(cardId, date);
  const usedPlays   = row ? row.count : 0;
  const earnedPlays = Math.floor(total / COST_PER_PLAY);
  if (earnedPlays - usedPlays <= 0) {
    return res.status(400).json({ error: 'no_plays', message: '沒有可用次數，繼續刷卡累積積點！' });
  }

  // 確認每日上限
  const { dailyWins } = db.prepare('SELECT COUNT(*) as dailyWins FROM slot_wins WHERE win_date = ?').get(date);
  if (dailyWins >= MAX_DAILY_WINS) {
    return res.status(400).json({ error: 'no_prizes', message: '今日獎品已全數送出！' });
  }

  // 先扣次數（防止重試作弊）
  db.prepare(`
    INSERT INTO slot_plays (card_id, play_date, count) VALUES (?, ?, 1)
    ON CONFLICT(card_id, play_date) DO UPDATE SET count = count + 1
  `).run(cardId, date);

  // 加權中獎判斷（超過個人上限直接不中）
  const { histWins } = db.prepare('SELECT COUNT(*) as histWins FROM slot_wins WHERE card_id = ?').get(cardId);
  const canWin   = histWins < MAX_WINS_PER_PERSON;
  const winProb  = getWinProb(histWins);
  const isWin    = canWin && (Math.random() < winProb);

  // 剩餘次數（扣完後）
  const newAvailable = Math.max(0, earnedPlays - usedPlays - 1);

  if (isWin) {
    const winTime = new Date().toISOString();
    db.prepare('INSERT INTO slot_wins (card_id, win_date, win_time) VALUES (?, ?, ?)').run(cardId, date, winTime);
    const { newTotal } = db.prepare('SELECT COUNT(*) as newTotal FROM slot_wins WHERE win_date = ?').get(date);
    broadcast('slot_win', { cardId, date, time: winTime, totalWins: newTotal, remainingPrizes: MAX_DAILY_WINS - newTotal });
  }

  broadcast('slot_play', { cardId, isWin });
  res.json({ ok: true, isWin, availablePlays: newAvailable });
});

// POST /api/slot/draw — 觸發今日抽獎（限 admin）
app.post('/api/slot/draw', (req, res) => {
  const { adminKey } = req.body;
  if (process.env.ADMIN_KEY && adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const date = today();

  // 不能重複抽
  const existing = db.prepare('SELECT 1 FROM slot_draws WHERE draw_date = ?').get(date);
  if (existing) return res.status(400).json({ error: 'already_drawn', message: '今日已抽過' });

  // 取得今日所有報名者
  const entries = db.prepare('SELECT card_id FROM slot_entries WHERE entry_date = ?').all(date).map(r => r.card_id);
  if (entries.length === 0) return res.status(400).json({ error: 'no_entries', message: '今日尚無人報名' });

  // 計算每人權重（依歷史中獎次數）
  const weightMap = {};
  for (const cardId of entries) {
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM slot_wins WHERE card_id = ?').get(cardId);
    weightMap[cardId] = getWeight(cnt);
  }

  // 加權抽出最多 20 名
  const drawCount = Math.min(MAX_DAILY_WINS, entries.length);
  const winners = weightedDraw(entries, weightMap, drawCount);

  const drawnAt = new Date().toISOString();

  // 寫入中獎紀錄（transaction）
  const insertWin = db.prepare('INSERT INTO slot_wins (card_id, win_date, win_time) VALUES (?, ?, ?)');
  const markDraw  = db.prepare('INSERT INTO slot_draws (draw_date, drawn_at) VALUES (?, ?)');
  db.transaction(() => {
    for (const cardId of winners) {
      insertWin.run(cardId, date, drawnAt);
    }
    markDraw.run(date, drawnAt);
  })();

  broadcast('slot_draw', { date, drawnAt, winners, totalWins: winners.length });
  res.json({ ok: true, winners, totalWins: winners.length, totalEntries: entries.length });
});

// GET /api/slot/winners — 今日中獎名單
app.get('/api/slot/winners', (req, res) => {
  const date = today();
  const rows = db.prepare(
    'SELECT card_id as cardId, win_time as time FROM slot_wins WHERE win_date = ? ORDER BY id ASC'
  ).all(date);
  res.json(rows);
});

// GET /api/slot/daily — 今日統計
app.get('/api/slot/daily', (req, res) => {
  const date = today();
  const { totalWins } = db.prepare('SELECT COUNT(*) as totalWins FROM slot_wins WHERE win_date = ?').get(date);
  const { totalEntries } = db.prepare('SELECT COUNT(*) as totalEntries FROM slot_entries WHERE entry_date = ?').get(date);
  const drawRow = db.prepare('SELECT drawn_at FROM slot_draws WHERE draw_date = ?').get(date);
  res.json({
    totalWins,
    totalEntries,
    remainingPrizes: Math.max(0, MAX_DAILY_WINS - totalWins),
    drawDone: !!drawRow,
    drawnAt: drawRow ? drawRow.drawn_at : null
  });
});

// ── Health check ───────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Start ──────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ AMC 積點系統後端已啟動 port ${PORT}`);
});
