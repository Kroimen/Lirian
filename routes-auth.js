// Вход по коду из письма и выход на всех устройствах
const crypto = require('crypto');

module.exports = function ({ app, io, q, auth, wrap, sign, SECRET }) {
// ---- Вход по коду из письма ----
const normEmail = (e) => {
  const v = String(e || '').trim().toLowerCase();
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : '';
};
const hashCode = (email, code) => crypto.createHmac('sha256', SECRET).update(email + ':' + code).digest('hex');
const safeEqual = (x, y) => x.length === y.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y));

// Лимиты, чтобы никто не спамил письмами: раз в минуту и 5 в час на адрес, 10 в час с одного IP
const mailHits = new Map();
function mailLimit(email, ip) {
  const now = Date.now();
  if (mailHits.size > 5000) mailHits.clear();
  const hits = (k) => { const a = (mailHits.get(k) || []).filter((t) => now - t < 3600e3); mailHits.set(k, a); return a; };
  const e = hits('e:' + email), i = hits('i:' + ip);
  if (e.length && now - e[e.length - 1] < 60e3) return 'Подожди минуту и запроси код снова';
  if (e.length >= 5 || i.length >= 10) return 'Слишком много запросов. Попробуй через час';
  e.push(now); i.push(now);
  return '';
}

// Письма уходят через HTTPS-API почтового сервиса (SMTP на бесплатном Render закрыт).
// Подойдёт любой из трёх: Brevo, SMTP2GO или Mailjet. Какой ключ задан в Render, тот и работает.
// Без ключей код пишется в логи Render: это режим для проверки.
async function sendMail(to, subject, text) {
  const env = process.env;
  const from = env.MAIL_FROM;
  const json = (obj, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(obj) });
  let r;
  if (env.BREVO_API_KEY || env.SMTP2GO_API_KEY || env.MAILJET_API_KEY) {
    if (!from) throw new Error('Не задана переменная MAIL_FROM (адрес отправителя)');
  }
  if (env.BREVO_API_KEY) {
    r = await fetch('https://api.brevo.com/v3/smtp/email', json(
      { sender: { name: 'Lirian', email: from }, to: [{ email: to }], subject, textContent: text },
      { 'api-key': env.BREVO_API_KEY }));
  } else if (env.SMTP2GO_API_KEY) {
    r = await fetch('https://api.smtp2go.com/v3/email/send', json(
      { api_key: env.SMTP2GO_API_KEY, to: [to], sender: 'Lirian <' + from + '>', subject, text_body: text }));
  } else if (env.MAILJET_API_KEY && env.MAILJET_SECRET_KEY) {
    r = await fetch('https://api.mailjet.com/v3.1/send', json(
      { Messages: [{ From: { Email: from, Name: 'Lirian' }, To: [{ Email: to }], Subject: subject, TextPart: text }] },
      { Authorization: 'Basic ' + Buffer.from(env.MAILJET_API_KEY + ':' + env.MAILJET_SECRET_KEY).toString('base64') }));
  } else {
    console.log('[КОД ВХОДА, почта не настроена]', to, text);
    return;
  }
  if (!r.ok) throw new Error('Почтовый сервис ответил ' + r.status + ': ' + (await r.text()));
}

app.post('/api/auth/request', wrap(async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  if (!email) return res.status(400).json({ error: 'Введи правильный адрес почты' });
  const limit = mailLimit(email, req.ip);
  if (limit) return res.status(429).json({ error: limit });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await q(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts)
     VALUES ($1, $2, now() + interval '10 minutes', 0)
     ON CONFLICT (email) DO UPDATE SET code_hash = $2, expires_at = now() + interval '10 minutes', attempts = 0`,
    [email, hashCode(email, code)]
  );
  try {
    await sendMail(email, 'Код входа в Lirian: ' + code, 'Твой код входа в Lirian: ' + code + '\n\nОн действует 10 минут. Никому его не сообщай. Если это был не ты, просто проигнорируй письмо.');
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'Не удалось отправить письмо. Попробуй позже' });
  }
  res.json({ ok: true });
}));

app.post('/api/auth/verify', wrap(async (req, res) => {
  const body = req.body || {};
  const email = normEmail(body.email);
  const code = String(body.code || '').replace(/\D/g, '');
  const username = String(body.username || '').trim();
  if (!email || code.length !== 6) return res.status(400).json({ error: 'Введи почту и 6 цифр из письма' });
  const c = (await q('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = $1', [email])).rows[0];
  if (!c || new Date(c.expires_at) < new Date()) return res.status(400).json({ error: 'Код устарел. Запроси новый' });
  if (c.attempts >= 5) {
    await q('DELETE FROM login_codes WHERE email = $1', [email]);
    return res.status(429).json({ error: 'Слишком много попыток. Запроси новый код' });
  }
  if (!safeEqual(hashCode(email, code), c.code_hash)) {
    await q('UPDATE login_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
    return res.status(400).json({ error: 'Неверный код' });
  }
  let u = (await q(
    'SELECT id, username, token_v, avatar_v, (avatar IS NOT NULL) AS has_avatar FROM users WHERE email = $1', [email]
  )).rows[0];
  if (!u) {   // первый вход: создаём аккаунт, нужно имя
    if (!/^[\p{L}\d_.-]{3,20}$/u.test(username)) {
      return res.status(400).json({ needUsername: true, error: 'Придумай имя: 3–20 символов (буквы, цифры, _ . -)' });
    }
    try {
      u = (await q(
        'INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id, username, token_v, avatar_v, false AS has_avatar',
        [username, email]
      )).rows[0];
      io.emit('users-changed');
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ needUsername: true, error: 'Это имя уже занято, придумай другое' });
      throw e;
    }
  }
  await q('DELETE FROM login_codes WHERE email = $1', [email]);
  res.json({ token: sign(u), user: { id: u.id, username: u.username, has_avatar: u.has_avatar, avatar_v: u.avatar_v } });
}));

// Выйти на всех устройствах (текущее остаётся: возвращаем ему новый токен)
app.post('/api/logout-all', auth, wrap(async (req, res) => {
  const u = await q('UPDATE users SET token_v = token_v + 1 WHERE id = $1 RETURNING id, username, token_v', [req.user.id]);
  io.in('user:' + req.user.id).disconnectSockets(true);
  res.json({ token: sign(u.rows[0]) });
}));
};
