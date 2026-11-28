const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 20) {
  console.error('Задай переменную JWT_SECRET: длинная случайная строка, от 20 символов');
  process.exit(1);
}

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
  await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper TEXT NOT NULL DEFAULT ''");
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper_img BYTEA');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper_v INTEGER NOT NULL DEFAULT 0');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_v INTEGER NOT NULL DEFAULT 0');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT');
  await q('ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL');
  await q('CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email)');
  await q(`CREATE TABLE IF NOT EXISTS login_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_pair ON messages (from_id, to_id, id)');
  await q('ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_id INTEGER');
  await q(`CREATE TABLE IF NOT EXISTS chat_groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_group_msgs ON messages (group_id, id)');
}

const app = express();
app.set('trust proxy', 1);   // Render стоит за прокси, нужно для определения IP
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server);

// Файлы лежат в корне репозитория, поэтому отдаём только нужные
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
for (const f of ['logo.jpg', 'base.css', 'extra.css', 'photos.js', 'wallpapers.js', 'security.js', 'auth.js', 'groups.js', 'app.js', 'privacy.html']) {
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
['/', '/base.css', '/extra.css', '/photos.js', '/wallpapers.js', '/security.js', '/auth.js', '/groups.js', '/app.js'].forEach(function (u) {
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

// tv — номер «поколения» входов: смена пароля или выход везде делают старые токены недействительными
const sign = (u) => jwt.sign({ id: u.id, username: u.username, tv: u.token_v || 0 }, SECRET, { expiresIn: '30d' });

// Токен должен быть верным, а пользователь — существовать в базе
const auth = wrap(async (req, res, next) => {
  let payload;
  try {
    payload = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
  } catch {
    return res.status(401).json({ error: 'Требуется вход' });
  }
  const r = await q('SELECT id, username, token_v FROM users WHERE id = $1', [payload.id]);
  if (!r.rows[0] || r.rows[0].token_v !== (payload.tv || 0)) return res.status(401).json({ error: 'Требуется вход' });
  req.user = r.rows[0];
  next();
});

// Остальные маршруты вынесены в отдельные файлы
require('./routes-auth')({ app, io, q, auth, wrap, sign, SECRET });
const chat = require('./chatcore')({ q, io });
require('./routes-media')({ app, io, q, auth, wrap, chat });
require('./routes-groups')({ app, io, q, auth, wrap });

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
     ORDER BY lm.created_at DESC NULLS LAST, u.username`,
    [req.user.id]
  );
  // Группы идут в тот же список; у них отрицательный id, а название лежит в username
  const g = await q(
    `SELECT -cg.id AS id, cg.name AS username, true AS is_group, false AS has_avatar, 0 AS avatar_v,
            (SELECT count(*)::int FROM group_members WHERE group_id = cg.id) AS members,
            lm.text AS last_text, lm.from_id AS last_from, lm.created_at AS last_at, lm.has_image AS last_image, lm.from_name AS last_name
     FROM chat_groups cg
     JOIN group_members gm ON gm.group_id = cg.id AND gm.user_id = $1
     LEFT JOIN LATERAL (
       SELECT m.text, m.from_id, m.created_at, (m.image IS NOT NULL) AS has_image, u.username AS from_name
       FROM messages m JOIN users u ON u.id = m.from_id
       WHERE m.group_id = cg.id ORDER BY m.id DESC LIMIT 1
     ) lm ON true`,
    [req.user.id]
  );
  const stamp = (x) => (x.last_at ? new Date(x.last_at).getTime() : 0);
  res.json([...r.rows, ...g.rows].sort((a, b) => stamp(b) - stamp(a) || String(a.username).localeCompare(String(b.username))));
}));

// История переписки; ?before=<id> подгружает более старые сообщения
app.get('/api/messages/:peerId', auth, wrap(async (req, res) => {
  const peer = Number(req.params.peerId);
  if (!Number.isInteger(peer)) return res.status(400).json({ error: 'Неверный собеседник' });
  const before = Number(req.query.before) || 2147483647;
  if (peer < 0) {
    const gid = -peer;
    const ok = await q('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [gid, req.user.id]);
    if (!ok.rowCount) return res.status(404).json({ error: 'Группа не найдена' });
    const gm = await q(
      `SELECT * FROM (
         SELECT m.id, m.from_id, -m.group_id AS to_id, m.group_id, m.text, m.created_at,
                (m.image IS NOT NULL) AS has_image, u.username AS from_name
         FROM messages m JOIN users u ON u.id = m.from_id
         WHERE m.group_id = $1 AND m.id < $2 ORDER BY m.id DESC LIMIT 50
       ) t ORDER BY id`,
      [gid, before]
    );
    return res.json(gm.rows);
  }
  if (peer < 1) return res.status(400).json({ error: 'Неверный собеседник' });
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
    const r = await q('SELECT id, username, token_v FROM users WHERE id = $1', [p.id]);
    if (!r.rows[0] || r.rows[0].token_v !== (p.tv || 0)) throw new Error('no user');
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
      if (!text || !Number.isInteger(toId) || toId === 0) return;
      await chat.send(me, toId, text, null);
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
