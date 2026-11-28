// Группы: создание, участники, переименование, выход
module.exports = function ({ app, io, q, auth, wrap }) {
  const isMember = async (g, u) => (await q('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [g, u])).rowCount > 0;
  const ownerOf = async (g) => ((await q('SELECT owner_id FROM chat_groups WHERE id = $1', [g])).rows[0] || {}).owner_id;
  const cleanIds = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : []);
  // Сообщаем всем участникам (и тем, кого только что убрали), чтобы список чатов обновился
  async function notify(g, extra = []) {
    const r = await q('SELECT user_id FROM group_members WHERE group_id = $1', [g]);
    const rooms = [...new Set([...r.rows.map((x) => x.user_id), ...extra])].map((i) => 'user:' + i);
    if (rooms.length) io.to(rooms).emit('groups-changed');
  }

  app.post('/api/groups', auth, wrap(async (req, res) => {
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Введи название группы' });
    const ids = cleanIds((req.body || {}).members).slice(0, 49);
    const found = await q('SELECT id FROM users WHERE id = ANY($1::int[])', [ids]);
    const members = [req.user.id, ...found.rows.map((r) => r.id).filter((i) => i !== req.user.id)];
    if (members.length < 2) return res.status(400).json({ error: 'Добавь хотя бы одного участника' });
    const g = await q('INSERT INTO chat_groups (name, owner_id) VALUES ($1, $2) RETURNING id', [name, req.user.id]);
    const id = g.rows[0].id;
    await q('INSERT INTO group_members (group_id, user_id) SELECT $1::int, unnest($2::int[])', [id, members]);
    await notify(id);
    res.json({ id: -id });
  }));

  app.get('/api/groups/:id/members', auth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !(await isMember(id, req.user.id))) return res.status(404).json({ error: 'Группа не найдена' });
    const m = await q(
      `SELECT u.id, u.username, u.avatar_v, (u.avatar IS NOT NULL) AS has_avatar
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 ORDER BY gm.joined_at, u.username`,
      [id]
    );
    res.json({ owner_id: await ownerOf(id), members: m.rows });
  }));

  app.post('/api/groups/:id/members', auth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || (await ownerOf(id)) !== req.user.id) return res.status(403).json({ error: 'Добавлять участников может только владелец' });
    const ids = cleanIds((req.body || {}).userIds);
    const count = (await q('SELECT count(*)::int AS n FROM group_members WHERE group_id = $1', [id])).rows[0].n;
    if (count + ids.length > 50) return res.status(400).json({ error: 'В группе не больше 50 участников' });
    await q('INSERT INTO group_members (group_id, user_id) SELECT $1::int, id FROM users WHERE id = ANY($2::int[]) ON CONFLICT DO NOTHING', [id, ids]);
    await notify(id);
    res.json({ ok: true });
  }));

  app.put('/api/groups/:id', auth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!Number.isInteger(id) || (await ownerOf(id)) !== req.user.id) return res.status(403).json({ error: 'Переименовать может только владелец' });
    if (!name) return res.status(400).json({ error: 'Введи название группы' });
    await q('UPDATE chat_groups SET name = $1 WHERE id = $2', [name, id]);
    await notify(id);
    res.json({ ok: true });
  }));

  // Убрать участника (владелец) или выйти самому
  app.delete('/api/groups/:id/members/:uid', auth, wrap(async (req, res) => {
    const id = Number(req.params.id), uid = Number(req.params.uid);
    if (!Number.isInteger(id) || !Number.isInteger(uid)) return res.status(400).json({ error: 'Неверный запрос' });
    const owner = await ownerOf(id);
    if (uid !== req.user.id && owner !== req.user.id) return res.status(403).json({ error: 'Убирать участников может только владелец' });
    if (!(await isMember(id, uid))) return res.status(404).json({ error: 'Участник не найден' });
    await q('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [id, uid]);
    const next = await q('SELECT user_id FROM group_members WHERE group_id = $1 ORDER BY joined_at LIMIT 1', [id]);
    if (!next.rowCount) {   // вышел последний: группа удаляется вместе с перепиской
      await q('DELETE FROM messages WHERE group_id = $1', [id]);
      await q('DELETE FROM chat_groups WHERE id = $1', [id]);
    } else if (owner === uid) {
      await q('UPDATE chat_groups SET owner_id = $1 WHERE id = $2', [next.rows[0].user_id, id]);
    }
    await notify(id, [uid]);
    res.json({ ok: true });
  }));
};
