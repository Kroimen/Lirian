const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const db = new Database('chat.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_pair ON messages (from_id, to_id, id);
`);

const app = express();
app.use(express.json());
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server);

const sign = (u) => jwt.sign({ id: u.id, username: u.username }, SECRET, { expiresIn: '7d' });

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Требуется вход' });
  }
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!/^[\w.-]{3,20}$/.test(username || '') || (password || '').length < 6) {
    return res.status(400).json({ error: 'Имя: 3–20 символов, пароль: от 6' });
  }
  try {
    const r = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, bcrypt.hashSync(password, 10));
    const user = { id: Number(r.lastInsertRowid), username };
    res.json({ token: sign(user), user });
  } catch {
    res.status(409).json({ error: 'Это имя уже занято' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Неверное имя или пароль' });
  }
  const user = { id: row.id, username: row.username };
  res.json({ token: sign(user), user });
});

app.get('/api/users', auth, (req, res) => {
  res.json(db.prepare('SELECT id, username FROM users WHERE id != ? ORDER BY username').all(req.user.id));
});

// История переписки; ?before=<id> подгружает более старые сообщения
app.get('/api/messages/:peerId', auth, (req, res) => {
  const me = req.user.id;
  const peer = Number(req.params.peerId);
  const before = Number(req.query.before) || 9e15;
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND id < ?
       ORDER BY id DESC LIMIT 50`
    )
    .all(me, peer, peer, me, before);
  res.json(rows.reverse());
});

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, SECRET);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const me = socket.user.id;
  socket.join('user:' + me);

  socket.on('message', ({ to, text }) => {
    text = String(text || '').trim().slice(0, 4000);
    to = Number(to);
    if (!text || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(to)) return;
    const r = db.prepare('INSERT INTO messages (from_id, to_id, text) VALUES (?, ?, ?)').run(me, to, text);
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid);
    io.to('user:' + to).to('user:' + me).emit('message', msg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('http://localhost:' + PORT));
