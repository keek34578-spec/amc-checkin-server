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
  db.prepare('DELETE FROM slot_plays').run();  // 同步清除已用拉霸次數，避免積點歸零後次數鎖死
  broadcast('records_cleared', {});
  res.json({ ok: true });
});

// ── API: Slot machine ──────────────────────────────
const MAX_DAILY_WINS    = 20;
const MAX_TOTAL_WINS    = 2;    // 每位小朋友活動期間最多中獎次數
const COST_PER_PLAY     = 5;
const TOP_RANK_BONUS    = 10;   // 積點排名前 N 名享有特殊機率
// 中獎機率：0 次中獎 → 15%，中過 1 次 → 5%，中過 2 次且排名前10 → 1%，其餘 → 0%
const WIN_PROBS = [0.15, 0.05];

app.get('/api/slot/status/:cardId', (req, res) => {
  const { cardId } = req.params;
  const date = today();

  // Total points
  const { total } = db.prepare('SELECT COUNT(*) as total FROM records WHERE card_id = ?').get(cardId);

  // Plays used today
  const row = db.prepare('SELECT count FROM slot_plays WHERE card_id = ? AND play_date = ?').get(cardId, date);
  const usedPlays = row ? row.count : 0;

  // Earned plays (total points / cost)
  const earnedPlays = Math.floor(total / COST_PER_PLAY);
  const availablePlays = Math.max(0, earnedPlays - usedPlays);

  // Today's total wins (global)
  const { wins } = db.prepare('SELECT COUNT(*) as wins FROM slot_wins WHERE win_date = ?').get(date);
  const remainingPrizes = Math.max(0, MAX_DAILY_WINS - wins);

  // This card's total wins (all-time, for probability tier)
  const { totalWins } = db.prepare('SELECT COUNT(*) as totalWins FROM slot_wins WHERE card_id = ?').get(cardId);

  // Has this card won today?
  const winRow = db.prepare('SELECT COUNT(*) as cnt FROM slot_wins WHERE card_id = ? AND win_date = ?').get(cardId, date);
  const hasWonToday = winRow.cnt > 0;

  res.json({ totalPts: total, availablePlays, usedPlays, remainingPrizes, todayWins: wins, totalWins, hasWonToday });
});

app.post('/api/slot/play', (req, res) => {
  const { cardId } = req.body;
  if (!cardId) return res.status(400).json({ error: 'cardId required' });

  // ── Activity time gate: Taiwan 13:00–20:00 ──
  const twH = twHour();
  if (twH < 13 || twH >= 20) {
    return res.status(400).json({ error: 'closed', message: '活動時間為台灣時間 13:00–20:00' });
  }

  const date = today();

  // Check plays available
  const { total } = db.prepare('SELECT COUNT(*) as total FROM records WHERE card_id = ?').get(cardId);
  const row = db.prepare('SELECT count FROM slot_plays WHERE card_id = ? AND play_date = ?').get(cardId, date);
  const usedPlays = row ? row.count : 0;
  const earnedPlays = Math.floor(total / COST_PER_PLAY);
  const availablePlays = earnedPlays - usedPlays;

  if (availablePlays <= 0) return res.status(400).json({ error: 'no_plays', message: '沒有可用次數' });

  // Check daily prize cap
  const { wins: dailyWins } = db.prepare('SELECT COUNT(*) as wins FROM slot_wins WHERE win_date = ?').get(date);
  if (dailyWins >= MAX_DAILY_WINS) return res.status(400).json({ error: 'no_prizes', message: '今日獎品已送完' });

  // This card's total wins
  const { totalWins } = db.prepare('SELECT COUNT(*) as totalWins FROM slot_wins WHERE card_id = ?').get(cardId);

  // Deduct one play BEFORE deciding win (prevents retry abuse)
  db.prepare(`
    INSERT INTO slot_plays (card_id, play_date, count) VALUES (?, ?, 1)
    ON CONFLICT(card_id, play_date) DO UPDATE SET count = count + 1
  `).run(cardId, date);

  // Win probability rules:
  // 0 wins → 15%
  // 1 win  → 5%
  // ≥2 wins + 積點排名前 TOP_RANK_BONUS 名 → 1%
  // ≥2 wins + 排名不在前列 → 0%（可以拉但不會中）
  let winProb = 0;
  if (totalWins < WIN_PROBS.length) {
    winProb = WIN_PROBS[totalWins];
  } else {
    // 已中獎 2 次，檢查積點排名是否在前 TOP_RANK_BONUS 名
    const allTotals = db.prepare(
      'SELECT card_id, COUNT(*) as pts FROM records GROUP BY card_id ORDER BY pts DESC'
    ).all();
    const rank = allTotals.findIndex(r => r.card_id === cardId);
    if (rank !== -1 && rank < TOP_RANK_BONUS) {
      winProb = 0.01; // 前10名保留 1% 機率
    }
  }

  const isWin = Math.random() < winProb;

  if (isWin) {
    const winTime = new Date().toISOString();
    db.prepare('INSERT INTO slot_wins (card_id, win_date, win_time) VALUES (?, ?, ?)').run(cardId, date, winTime);
    const { wins: newWins } = db.prepare('SELECT COUNT(*) as wins FROM slot_wins WHERE win_date = ?').get(date);
    broadcast('slot_win', { cardId, date, time: winTime, todayWins: newWins, remainingPrizes: MAX_DAILY_WINS - newWins });
  }

  broadcast('slot_play', { cardId, isWin });
  res.json({ ok: true, isWin });
});

app.get('/api/slot/winners', (req, res) => {
  const date = today();
  const rows = db.prepare(
    'SELECT card_id as cardId, win_time as time FROM slot_wins WHERE win_date = ? ORDER BY id ASC'
  ).all(date);
  res.json(rows);
});

app.get('/api/slot/winners/all', (req, res) => {
  const rows = db.prepare(`
    SELECT
      w.card_id   AS cardId,
      s.name      AS name,
      w.win_date  AS date,
      w.win_time  AS time,
      COUNT(*) OVER (PARTITION BY w.card_id) AS totalWins
    FROM slot_wins w
    LEFT JOIN students s ON s.card_id = w.card_id
    ORDER BY w.id ASC
  `).all();
  res.json(rows);
});

app.get('/api/slot/daily', (req, res) => {
  const date = today();
  const { wins } = db.prepare('SELECT COUNT(*) as wins FROM slot_wins WHERE win_date = ?').get(date);
  res.json({ todayWins: wins, remainingPrizes: Math.max(0, MAX_DAILY_WINS - wins) });
});

// ── Health check ───────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Serve frontend HTML ─────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '兒童節活動.html'));
});

// ── Start ──────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ AMC 積點系統後端已啟動 port ${PORT}`);
});
