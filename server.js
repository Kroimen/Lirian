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
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar BYTEA');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_v INTEGER NOT NULL DEFAULT 0');
  await q(`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q('ALTER TABLE messages ADD COLUMN IF NOT EXISTS image BYTEA');
  await q('CREATE INDEX IF NOT EXISTS idx_pair ON messages (from_id, to_id, id)');
}

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server);

// Файлы лежат в корне репозитория, поэтому отдаём только нужные
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
for (const f of ['logo.jpg', 'base.css', 'extra.css', 'photos.js', 'app.js']) {
  app.get('/' + f, (req, res) => res.sendFile(__dirname + '/' + f));
}

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
['/', '/base.css', '/extra.css', '/photos.js', '/app.js'].forEach(function (u) {
  fetch(u, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) {
    var ok = t.slice(-30).indexOf('END') > -1 || t.indexOf('</ht' + 'ml>') > -1;
    log('Файл ' + u + ': ' + t.length + ' символов, конец на месте: ' + ok);
  }).catch(function (e) { log('Файл ' + u + ': ошибка ' + e.message); });
});
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
    const user = { ...r.rows[0], has_avatar: false, avatar_v: 0 };
    io.emit('users-changed');
    res.json({ token: sign(user), user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Это имя уже занято' });
    throw e;
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const r = await q(
    'SELECT id, username, password_hash, avatar_v, (avatar IS NOT NULL) AS has_avatar FROM users WHERE username = $1',
    [String(username || '')]
  );
  const row = r.rows[0];
  if (!row || !(await bcrypt.compare(String(password || ''), row.password_hash))) {
    return res.status(401).json({ error: 'Неверное имя или пароль' });
  }
  const user = { id: row.id, username: row.username, has_avatar: row.has_avatar, avatar_v: row.avatar_v };
  res.json({ token: sign(user), user });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const r = await q('SELECT id, username, avatar_v, (avatar IS NOT NULL) AS has_avatar FROM users WHERE id = $1', [req.user.id]);
  res.json(r.rows[0]);
}));

// Аватарки хранятся в базе (клиент заранее уменьшает их до 256x256 JPEG)
app.get('/api/avatar/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).end();
  const r = await q('SELECT avatar FROM users WHERE id = $1', [id]);
  const buf = r.rows[0] && r.rows[0].avatar;
  if (!buf) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.send(buf);
}));

app.put('/api/avatar', auth, express.raw({ type: 'image/*', limit: '300kb' }), wrap(async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return res.status(400).json({ error: 'Нужна картинка в формате JPEG' });
  }
  const r = await q('UPDATE users SET avatar = $1, avatar_v = avatar_v + 1 WHERE id = $2 RETURNING avatar_v', [buf, req.user.id]);
  io.emit('avatar-changed', { id: req.user.id, has: true, v: r.rows[0].avatar_v });
  res.json({ avatar_v: r.rows[0].avatar_v });
}));

app.delete('/api/avatar', auth, wrap(async (req, res) => {
  const r = await q('UPDATE users SET avatar = NULL, avatar_v = avatar_v + 1 WHERE id = $1 RETURNING avatar_v', [req.user.id]);
  io.emit('avatar-changed', { id: req.user.id, has: false, v: r.rows[0].avatar_v });
  res.json({ avatar_v: r.rows[0].avatar_v });
}));

// Фото в сообщениях (клиент заранее сжимает их до 1280 px JPEG)
app.post('/api/photo/:to', auth, express.raw({ type: 'image/*', limit: '1500kb' }), wrap(async (req, res) => {
  const to = Number(req.params.to);
  const buf = req.body;
  if (!Number.isInteger(to)) return res.status(400).json({ error: 'Неверный получатель' });
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return res.status(400).json({ error: 'Нужна картинка в формате JPEG' });
  }
  const exists = await q('SELECT 1 FROM users WHERE id = $1', [to]);
  if (!exists.rowCount) return res.status(404).json({ error: 'Получатель не найден' });
  const caption = String(req.query.caption || '').trim().slice(0, 1000);
  const r = await q(
    `INSERT INTO messages (from_id, to_id, text, image) VALUES ($1, $2, $3, $4)
     RETURNING id, from_id, to_id, text, created_at, true AS has_image`,
    [req.user.id, to, caption, buf]
  );
  io.to('user:' + to).to('user:' + req.user.id).emit('message', r.rows[0]);
  res.json({ ok: true });
}));

// Фото видят только отправитель и получатель
app.get('/api/photo/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).end();
  const r = await q(
    'SELECT image FROM messages WHERE id = $1 AND image IS NOT NULL AND (from_id = $2 OR to_id = $2)',
    [id, req.user.id]
  );
  if (!r.rows[0]) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.send(r.rows[0].image);
}));

// Список собеседников с последним сообщением для превью
app.get('/api/users', auth, wrap(async (req, res) => {
  const r = await q(
    `SELECT u.id, u.username, u.avatar_v, (u.avatar IS NOT NULL) AS has_avatar, lm.text AS last_text, lm.from_id AS last_from, lm.created_at AS last_at, lm.has_image AS last_image
     FROM users u
     LEFT JOIN LATERAL (
       SELECT m.text, m.from_id, m.created_at, (m.image IS NOT NULL) AS has_image FROM messages m
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
       SELECT id, from_id, to_id, text, created_at, (image IS NOT NULL) AS has_image FROM messages
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
        'INSERT INTO messages (from_id, to_id, text) VALUES ($1, $2, $3) RETURNING id, from_id, to_id, text, created_at, false AS has_image',
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
