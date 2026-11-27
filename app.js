const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ничего */ } },
  clear() { try { localStorage.clear(); } catch { /* ничего */ } },
};
let token = store.get('token');
let me = null;
try { me = JSON.parse(store.get('me') || 'null'); } catch { me = null; }
let socket = null, peer = null, users = [], lastDay = '';
const unread = new Map();   // id собеседника -> число непрочитанных
const online = new Set();   // id пользователей в сети

const GRADS = [['#5d33b0', '#9b6dff'], ['#e11d48', '#fb7185'], ['#0891b2', '#22d3ee'],
               ['#ca8a04', '#facc15'], ['#059669', '#34d399'], ['#db2777', '#f472b6']];
const gradient = (id) => `linear-gradient(135deg, ${GRADS[id % GRADS.length][0]}, ${GRADS[id % GRADS.length][1]})`;

const toDate = (s) => new Date(s);
const fmtTime = (d) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const daysAgo = (d) => Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);

function fmtList(d) {
  const n = daysAgo(d);
  if (n <= 0) return fmtTime(d);
  if (n === 1) return 'вчера';
  if (n < 7) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}
function fmtDay(d) {
  const n = daysAgo(d);
  if (n <= 0) return 'Сегодня';
  if (n === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch('/api/' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз');
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== 'login') logout();   // токен устарел или аккаунта больше нет
  if (!r.ok) throw new Error(data.error || 'Ошибка сервера (' + r.status + ')');
  return data;
}

/* ---------- вход ---------- */
async function authenticate(kind) {
  const name = $('username').value.trim(), pass = $('password').value;
  const err = $('err');
  err.style.color = '';
  if (!name || !pass) { err.textContent = 'Введите имя и пароль'; return; }
  err.style.color = 'var(--text-muted)';
  err.textContent = 'Отправляю запрос…';
  const btns = [$('login'), $('register')];
  btns.forEach((b) => (b.disabled = true));
  const slow = setTimeout(() => {
    err.style.color = 'var(--text-muted)';
    err.textContent = 'Сервер просыпается, это может занять до минуты…';
  }, 3000);
  try {
    const data = await api(kind, { method: 'POST', body: { username: name, password: pass } });
    token = data.token; me = data.user;
    store.set('token', token);
    store.set('me', JSON.stringify(me));
    start();
  } catch (e) {
    err.style.color = '';
    err.textContent = e.message;
  } finally {
    clearTimeout(slow);
    btns.forEach((b) => (b.disabled = false));
  }
}
$('login').onclick = () => authenticate('login');
$('register').onclick = () => authenticate('register');
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') authenticate('login'); });

/* ---------- профиль и аватарка ---------- */
function renderMe() {
  $('menu').replaceChildren(makeAvatar(me, false));
  $('profAvatar').replaceChildren(makeAvatar(me, false));
  $('profName').textContent = me.username;
  $('removePhoto').classList.toggle('hidden', !me.has_avatar);
}
function setMyAvatar(has, v) {
  me.has_avatar = has; me.avatar_v = v;
  store.set('me', JSON.stringify(me));
  renderMe(); renderUsers();
}
async function toSquareJpeg(file, size = 256) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('Не удалось открыть это изображение. Попробуйте JPG или PNG'); }
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}
function openProfile() { $('profErr').textContent = ''; renderMe(); $('profile').classList.remove('hidden'); }
function closeProfile() { $('profile').classList.add('hidden'); }
$('menu').onclick = openProfile;
$('closeProfile').onclick = closeProfile;
$('profile').addEventListener('click', (e) => { if (e.target.id === 'profile') closeProfile(); });
$('logoutBtn').onclick = () => { if (confirm('Выйти из аккаунта?')) logout(); };
$('pickPhoto').onclick = () => $('file').click();
$('file').onchange = async () => {
  const f = $('file').files[0];
  $('file').value = '';
  if (!f) return;
  const err = $('profErr');
  err.style.color = 'var(--text-muted)';
  err.textContent = 'Загружаю…';
  try {
    const blob = await toSquareJpeg(f);
    const r = await fetch('/api/avatar', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + token }, body: blob });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Ошибка сервера (' + r.status + ')');
    setMyAvatar(true, data.avatar_v);
    err.textContent = '';
  } catch (e) { err.style.color = ''; err.textContent = e.message; }
};
$('removePhoto').onclick = async () => {
  try { const d = await api('avatar', { method: 'DELETE' }); setMyAvatar(false, d.avatar_v); }
  catch (e) { $('profErr').textContent = e.message; }
};
function logout() { store.clear(); location.reload(); }

/* ---------- старт ---------- */
function loadSocketIo() {
  return new Promise((resolve, reject) => {
    if (window.io) return resolve();
    const s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('не загрузился socket.io, обновите страницу'));
    document.head.append(s);
  });
}

async function start() {
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  await loadSocketIo();
  socket = io({ auth: { token } });
  socket.on('connect_error', (err) => { if (err.message === 'unauthorized') logout(); });
  socket.on('message', onMessage);
  socket.on('online', (ids) => { online.clear(); ids.forEach((i) => online.add(i)); renderUsers(); updateHeader(); });
  socket.on('presence', ({ id, online: on }) => { on ? online.add(id) : online.delete(id); renderUsers(); updateHeader(); });
  socket.on('users-changed', loadUsers);
  socket.on('wallpaper-changed', async () => {
    try { me = await api('me'); store.set('me', JSON.stringify(me)); applyWallpaper(); } catch { /* ничего */ }
  });
  socket.on('avatar-changed', ({ id, has, v }) => {
    if (id === me.id) { setMyAvatar(has, v); return; }
    const u = users.find((x) => x.id === id);
    if (!u) return;
    u.has_avatar = has; u.avatar_v = v;
    if (peer && peer.id === id) { peer = u; updateHeader(); }
    renderUsers();
  });
  try { me = await api('me'); store.set('me', JSON.stringify(me)); renderMe(); applyWallpaper(); } catch { /* при 401 api() сам разлогинит */ }
  try { await loadUsers(); } catch { logout(); }
}

async function loadUsers() {
  users = await api('users');
  if (peer) peer = users.find((x) => x.id === peer.id) || peer;
  renderUsers();
}

/* ---------- список чатов ---------- */
const isSelf = (u) => u.id === me.id;
const displayName = (u) => (isSelf(u) ? 'Избранное' : u.username);
const noteAvatar = () => el('div', 'avatar fav', '★');

function makeAvatar(u, withStatus) {
  const a = el('div', 'avatar');
  if (u.has_avatar) a.style.background = 'center / cover url(/api/avatar/' + u.id + '?v=' + (u.avatar_v || 0) + ')';
  else { a.style.background = gradient(u.id); a.textContent = u.username[0].toUpperCase(); }
  if (withStatus && online.has(u.id)) a.append(el('span', 'status'));
  return a;
}

function renderUsers() {
  const q = $('search').value.trim().toLowerCase();
  const box = $('chatList');
  box.innerHTML = '';
  const list = users.filter((u) => displayName(u).toLowerCase().includes(q))
    .sort((a, b) => isSelf(b) - isSelf(a));   // «Избранное» всегда сверху
  if (!list.length) box.append(el('div', 'list-empty', 'Никого не найдено'));
  list.forEach((u) => {
    const item = el('div', 'chat-item' + (peer && peer.id === u.id ? ' active' : ''));
    const info = el('div', 'chat-info');
    const top = el('div', 'chat-top');
    top.append(el('div', 'chat-name', displayName(u)));
    if (u.last_at) top.append(el('div', 'chat-time', fmtList(toDate(u.last_at))));
    const bottom = el('div', 'chat-bottom');
    const prev = el('div', 'chat-preview');
    if (u.last_text || u.last_image) {
      if (u.last_from === me.id && !isSelf(u)) prev.append(el('span', 'you', 'Вы · '));
      prev.append(document.createTextNode((u.last_image ? '📷 ' : '') + (u.last_text || (u.last_image ? 'Фото' : ''))));
    } else prev.textContent = isSelf(u) ? 'Заметки, ссылки и фото для себя' : 'Нет сообщений';
    bottom.append(prev);
    if (unread.get(u.id)) bottom.append(el('div', 'badge', String(unread.get(u.id))));
    info.append(top, bottom);
    item.append(isSelf(u) ? noteAvatar() : makeAvatar(u, true), info);
    item.onclick = () => openChat(u);
    box.append(item);
  });
  if (users.length === 1 && !q) box.append(el('div', 'list-empty', 'Пока здесь больше никого нет. Пригласи друга создать аккаунт'));
}
$('search').addEventListener('input', renderUsers);

/* ---------- чат ---------- */
function updateHeader() {
  if (!peer) return;
  $('headAvatar').replaceChildren(isSelf(peer) ? noteAvatar() : makeAvatar(peer, true));
  $('headName').textContent = displayName(peer);
  if (isSelf(peer)) {
    $('headStatus').textContent = 'видишь только ты';
    $('headStatus').classList.add('off');
    return;
  }
  const on = online.has(peer.id);
  $('headStatus').textContent = on ? 'в сети' : 'не в сети';
  $('headStatus').classList.toggle('off', !on);
}

async function openChat(u) {
  peer = u;
  unread.delete(u.id);
  lastDay = '';
  $('placeholder').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  $('app').classList.add('in-chat');
  $('messages').innerHTML = '';
  updateHeader();
  renderUsers();
  try {
    const msgs = await api('messages/' + u.id);
    if (peer && peer.id === u.id) {
      msgs.forEach(addMessage);
      if (!msgs.length && isSelf(u)) $('messages').append(el('div', 'empty-note', 'Здесь можно хранить заметки, ссылки и фото для себя. Видишь их только ты'));
    }
  } catch (e) { /* оставим пустой чат */ }
  if (window.matchMedia('(min-width: 761px)').matches) $('text').focus();
}
$('back').onclick = () => { $('app').classList.remove('in-chat'); peer = null; renderUsers(); };

function addMessage(m) {
  const d = toDate(m.created_at);
  const day = d.toDateString();
  const box = $('messages');
  const hint = box.querySelector('.empty-note');
  if (hint) hint.remove();
  if (day !== lastDay) { box.append(el('div', 'date-pill', fmtDay(d))); lastDay = day; }
  const out = m.from_id === me.id;
  const msg = el('div', 'message ' + (out ? 'out' : 'in'));
  const bubble = el('div', 'bubble');
  const meta = el('div', 'bubble-meta');
  meta.append(el('span', null, fmtTime(d)));
  if (out) meta.append(el('span', 'checks', '✓'));
  if (m.has_image) {
    const img = el('img', 'msg-img');
    img.alt = 'Фото';
    img.style.minHeight = '140px';
    img.onload = () => { img.style.minHeight = ''; box.scrollTop = box.scrollHeight; };
    photoUrl(m.id)
      .then((u) => { img.src = u; img.onclick = () => openLightbox(u); })
      .catch(() => img.replaceWith(el('div', 'bubble-text', '📷 Фото недоступно')));
    bubble.append(img);
  }
  if (m.text) bubble.append(el('div', 'bubble-text', m.text));
  bubble.append(meta);
  msg.append(bubble);
  box.append(msg);
  box.scrollTop = box.scrollHeight;
}

function onMessage(m) {
  const otherId = m.from_id === me.id ? m.to_id : m.from_id;
  const u = users.find((x) => x.id === otherId);
  if (u) {
    u.last_text = m.text; u.last_from = m.from_id; u.last_at = m.created_at; u.last_image = m.has_image;
    users.sort((a, b) => (b.last_at || '').localeCompare(a.last_at || '') || a.username.localeCompare(b.username));
  } else { loadUsers(); }
  if (peer && peer.id === otherId) addMessage(m);
  else if (m.from_id !== me.id) unread.set(otherId, (unread.get(otherId) || 0) + 1);
  renderUsers();
}

/* ---------- фото ---------- */
function openLightbox(url) { $('lightImg').src = url; $('lightbox').classList.remove('hidden'); }
$('lightbox').onclick = () => { $('lightbox').classList.add('hidden'); $('lightImg').src = ''; };
$('attach').onclick = () => { if (peer) $('photoFile').click(); };
$('photoFile').onchange = async () => {
  const files = [...$('photoFile').files].slice(0, 10);
  $('photoFile').value = '';
  if (!files.length || !peer) return;
  const to = peer.id;
  $('attach').disabled = true;
  try {
    for (const f of files) {
      const caption = $('text').value.trim();
      const blob = await compressImage(f);
      const r = await fetch('/api/photo/' + to + '?caption=' + encodeURIComponent(caption), {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + token }, body: blob,
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Ошибка сервера (' + r.status + ')'); }
      $('text').value = '';
      $('text').style.height = 'auto';
    }
  } catch (e) { toast(e.message); }
  $('attach').disabled = false;
};

/* ---------- отправка ---------- */
function send() {
  const text = $('text').value.trim();
  if (!text || !peer || !socket) return;
  socket.emit('message', { to: peer.id, text });
  $('text').value = '';
  $('text').style.height = 'auto';
  $('text').focus();
}
$('send').onclick = send;
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('text').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 110) + 'px';
});

initWallpapers();
$('ver').textContent = 'версия 9 · готово';
if (token && me) start();
// END
