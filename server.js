const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

if (!process.env.DATABASE_URL) {
  console.error('Не задана переменная окружения DATABASE_URL (строка подключения к PostgreSQL)');
  process.exit(1);
}

// SSL включаем явно, параметр sslmode из строки убираем, чтобы он не перебивал настройку
let connectionString = process.env.DATABASE_URL;
try {
  const u = new URL(connectionString);
  u.searchParams.delete('sslmode');
  connectionString = u.toString();
} catch { /* оставляем как есть */ }
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 5 });
const q = (text, params) => pool.query(text, params);

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_pair ON messages (from_id, to_id, id)');
}

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server);

// Файлы лежат в корне репозитория, поэтому отдаём только нужные
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/logo.jpg', (req, res) => res.sendFile(__dirname + '/logo.jpg'));

// Диагностическая страница: показывает, выполняется ли JavaScript и что приходит с сервера
const TEST_HTML = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Диагностика</title></head>
<body style="font:16px/1.4 system-ui,sans-serif;padding:16px;background:#111;color:#eee">
<h3 id="s">⚠ JavaScript не выполняется</h3>
<pre id="o" style="white-space:pre-wrap;font-size:13px;color:#bbb"></pre>
<script>
var o = document.getElementById('o'), s = document.getElementById('s');
s.textContent = '✓ JavaScript работает';
function log(t) { o.textContent += t + '\\n\\n'; }
log('Браузер: ' + navigator.userAgent);
log('Адрес: ' + location.href);
fetch('/api/users').then(function (r) { log('/api/users → HTTP ' + r.status); }).catch(function (e) { log('/api/users ошибка: ' + e.message); });
fetch('/').then(function (r) {
  var h = [];
  r.headers.forEach(function (v, k) { h.push(k + ': ' + v); });
  log('Заголовки главной страницы:\\n' + h.join('\\n'));
  return r.text();
}).then(function (t) {
  log('Размер главной страницы: ' + t.length + ' символов');
  log('Есть конец файла: ' + (t.indexOf('</ht' + 'ml>') > -1));
  log('Скрипт-блоков в ней: ' + (t.split('<scr' + 'ipt').length - 1));
}).catch(function (e) { log('Главная страница, ошибка: ' + e.message); });
</script>
</body></html>`;
app.get('/test', (req, res) => res.type('html').send(TEST_HTML));

const wrap = (fn) => (req, res, next) =>
  fn(req, res, next).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера, попробуйте ещё раз' });
  });

const sign = (u) => jwt.sign({ id: u.id, username: u.username }, SECRET, { expiresIn: '30d' });

// Токен должен быть верным, а пользователь — существовать в базе
const auth = wrap(async (req, res, next) => {
  let payload;
  try {
    payload = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
  } catch {
    return res.status(401).json({ error: 'Требуется вход' });
  }
  const r = await q('SELECT id, username FROM users WHERE id = $1', [payload.id]);
  if (!r.rows[0]) return res.status(401).json({ error: 'Требуется вход' });
  req.user = r.rows[0];
  next();
});

app.post('/api/register', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!/^[\p{L}\d_.-]{3,20}$/u.test(username || '') || (password || '').length < 6) {
    return res.status(400).json({ error: 'Имя: 3–20 символов (буквы, цифры, _ . -), пароль: от 6 символов' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await q('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username', [username, hash]);
    const user = r.rows[0];
    io.emit('users-changed');
    res.json({ token: sign(user), user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Это имя уже занято' });
    throw e;
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const r = await q('SELECT * FROM users WHERE username = $1', [String(username || '')]);
  const row = r.rows[0];
  if (!row || !(await bcrypt.compare(String(password || ''), row.password_hash))) {
    return res.status(401).json({ error: 'Неверное имя или пароль' });
  }
  const user = { id: row.id, username: row.username };
  res.json({ token: sign(user), user });
}));

// Список собеседников с последним сообщением для превью
app.get('/api/users', auth, wrap(async (req, res) => {
  const r = await q(
    `SELECT u.id, u.username, lm.text AS last_text, lm.from_id AS last_from, lm.created_at AS last_at
     FROM users u
     LEFT JOIN LATERAL (
       SELECT m.text, m.from_id, m.created_at FROM messages m
       WHERE (m.from_id = u.id AND m.to_id = $1) OR (m.from_id = $1 AND m.to_id = u.id)
       ORDER BY m.id DESC LIMIT 1
     ) lm ON true
     WHERE u.id <> $1
     ORDER BY lm.created_at DESC NULLS LAST, u.username`,
    [req.user.id]
  );
  res.json(r.rows);
}));

// История переписки; ?before=<id> подгружает более старые сообщения
app.get('/api/messages/:peerId', auth, wrap(async (req, res) => {
  const peer = Number(req.params.peerId);
  if (!Number.isInteger(peer)) return res.status(400).json({ error: 'Неверный собеседник' });
  const before = Number(req.query.before) || 2147483647;
  const r = await q(
    `SELECT * FROM (
       SELECT id, from_id, to_id, text, created_at FROM messages
       WHERE ((from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)) AND id < $3
       ORDER BY id DESC LIMIT 50
     ) t ORDER BY id`,
    [req.user.id, peer, before]
  );
  res.json(r.rows);
}));

io.use(async (socket, next) => {
  try {
    const p = jwt.verify(socket.handshake.auth.token, SECRET);
    const r = await q('SELECT id, username FROM users WHERE id = $1', [p.id]);
    if (!r.rows[0]) throw new Error('no user');
    socket.user = r.rows[0];
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

const online = new Map(); // userId -> число открытых соединений

io.on('connection', (socket) => {
  const me = socket.user.id;
  socket.join('user:' + me);

  online.set(me, (online.get(me) || 0) + 1);
  if (online.get(me) === 1) socket.broadcast.emit('presence', { id: me, online: true });
  socket.emit('online', [...online.keys()]);

  socket.on('message', async (data) => {
    try {
      const { to, text: raw } = data || {};
      const text = String(raw || '').trim().slice(0, 4000);
      const toId = Number(to);
      if (!text || !Number.isInteger(toId)) return;
      const exists = await q('SELECT 1 FROM users WHERE id = $1', [toId]);
      if (!exists.rowCount) return;
      const r = await q(
        'INSERT INTO messages (from_id, to_id, text) VALUES ($1, $2, $3) RETURNING id, from_id, to_id, text, created_at',
        [me, toId, text]
      );
      io.to('user:' + toId).to('user:' + me).emit('message', r.rows[0]);
    } catch (e) {
      console.error(e);
    }
  });

  socket.on('disconnect', () => {
    const n = (online.get(me) || 1) - 1;
    if (n <= 0) {
      online.delete(me);
      io.emit('presence', { id: me, online: false });
    } else {
      online.set(me, n);
    }
  });
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => server.listen(PORT, () => console.log('Lirian: http://localhost:' + PORT)))
  .catch((e) => { console.error('Не удалось подключиться к базе:', e.message); process.exit(1); });
