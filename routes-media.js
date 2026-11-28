// Профиль, аватарки, обои чата и фото в сообщениях
const express = require('express');

module.exports = function ({ app, io, q, auth, wrap, chat }) {
app.get('/api/me', auth, wrap(async (req, res) => {
  const r = await q(
    `SELECT id, username, avatar_v, (avatar IS NOT NULL) AS has_avatar,
            wallpaper, wallpaper_v, (wallpaper_img IS NOT NULL) AS has_wallpaper_img
     FROM users WHERE id = $1`,
    [req.user.id]
  );
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

// Обои чата: готовый узор (id задаёт клиент) или своё фото
app.put('/api/wallpaper', auth, wrap(async (req, res) => {
  const w = String((req.body || {}).wallpaper || '');
  if (!/^[a-z]{0,20}$/.test(w)) return res.status(400).json({ error: 'Неверные обои' });
  const r = await q(
    "UPDATE users SET wallpaper = $1 WHERE id = $2 AND ($1 <> 'custom' OR wallpaper_img IS NOT NULL) RETURNING id",
    [w, req.user.id]
  );
  if (!r.rowCount) return res.status(400).json({ error: 'Сначала загрузи своё фото' });
  io.to('user:' + req.user.id).emit('wallpaper-changed');
  res.json({ wallpaper: w });
}));

app.put('/api/wallpaper-image', auth, express.raw({ type: 'image/*', limit: '2mb' }), wrap(async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return res.status(400).json({ error: 'Нужна картинка в формате JPEG' });
  }
  const r = await q(
    "UPDATE users SET wallpaper_img = $1, wallpaper = 'custom', wallpaper_v = wallpaper_v + 1 WHERE id = $2 RETURNING wallpaper_v",
    [buf, req.user.id]
  );
  io.to('user:' + req.user.id).emit('wallpaper-changed');
  res.json({ wallpaper: 'custom', wallpaper_v: r.rows[0].wallpaper_v });
}));

app.get('/api/wallpaper-image', auth, wrap(async (req, res) => {
  const r = await q('SELECT wallpaper_img FROM users WHERE id = $1', [req.user.id]);
  const buf = r.rows[0] && r.rows[0].wallpaper_img;
  if (!buf) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-cache' });
  res.send(buf);
}));

// Фото в сообщениях (клиент заранее сжимает их до 1280 px JPEG)
app.post('/api/photo/:to', auth, express.raw({ type: 'image/*', limit: '1500kb' }), wrap(async (req, res) => {
  const to = Number(req.params.to);
  const buf = req.body;
  if (!Number.isInteger(to)) return res.status(400).json({ error: 'Неверный получатель' });
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return res.status(400).json({ error: 'Нужна картинка в формате JPEG' });
  }
  const caption = String(req.query.caption || '').trim().slice(0, 1000);
  const row = to === 0 ? null : await chat.send(req.user.id, to, caption, buf);
  if (!row) return res.status(404).json({ error: 'Получатель не найден' });
  res.json({ ok: true });
}));

// Фото видят только отправитель, получатель или участники группы
app.get('/api/photo/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).end();
  const r = await q(
    `SELECT image FROM messages WHERE id = $1 AND image IS NOT NULL AND (from_id = $2 OR to_id = $2
       OR group_id IN (SELECT group_id FROM group_members WHERE user_id = $2))`,
    [id, req.user.id]
  );
  if (!r.rows[0]) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.send(r.rows[0].image);
}));
};
