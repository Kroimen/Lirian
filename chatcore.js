// Отправка сообщений: личные чаты и группы (у групп в клиенте отрицательный id: -номер группы)
module.exports = function ({ q, io }) {
  async function send(from, to, text, image) {
    let row, rooms;
    if (to < 0) {
      const gid = -to;
      const members = await q('SELECT user_id FROM group_members WHERE group_id = $1', [gid]);
      if (!members.rows.some((m) => m.user_id === from)) return null;
      const r = await q(
        `INSERT INTO messages (from_id, to_id, group_id, text, image) VALUES ($1, 0, $2, $3, $4)
         RETURNING id, from_id, -group_id AS to_id, group_id, text, created_at, (image IS NOT NULL) AS has_image`,
        [from, gid, text, image]
      );
      row = r.rows[0];
      row.from_name = (await q('SELECT username FROM users WHERE id = $1', [from])).rows[0].username;
      rooms = members.rows.map((m) => 'user:' + m.user_id);
    } else {
      if (to < 1 || !(await q('SELECT 1 FROM users WHERE id = $1', [to])).rowCount) return null;
      const r = await q(
        `INSERT INTO messages (from_id, to_id, text, image) VALUES ($1, $2, $3, $4)
         RETURNING id, from_id, to_id, NULL::int AS group_id, text, created_at, (image IS NOT NULL) AS has_image`,
        [from, to, text, image]
      );
      row = r.rows[0];
      rooms = ['user:' + to, 'user:' + from];
    }
    io.to(rooms).emit('message', row);
    return row;
  }
  return { send };
};
