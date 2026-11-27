// Обои чата: готовые фиолетовые узоры и своё фото
const svgUrl = (body) => 'url("data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140">' + body + '</svg>') + '")';
const tf = (x, y, s) => 'transform="translate(' + x + ' ' + y + ') scale(' + s + ')"';
const spark = (x, y, s, o) => '<path ' + tf(x, y, s) + ' d="M0-8Q0 0 8 0Q0 0 0 8Q0 0-8 0Q0 0 0-8Z" fill="#fff" fill-opacity="' + o + '"/>';
const heart = (x, y, s, c, o) => '<path ' + tf(x, y, s) + ' d="M0 3C-6-4-12 2 0 12C12 2 6-4 0 3Z" fill="' + c + '" fill-opacity="' + o + '"/>';
const moon = (x, y, s, o) => '<path ' + tf(x, y, s) + ' d="M6-10A12 12 0 1 0 6 10A9 9 0 1 1 6-10Z" fill="#fff" fill-opacity="' + o + '"/>';
const dot = (x, y, r, c, o) => '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + c + '" fill-opacity="' + o + '"/>';
const flower = (x, y, s, c, o) => {
  let p = '';
  for (let i = 0; i < 5; i++) {
    const a = (i * 72 * Math.PI) / 180;
    p += '<circle cx="' + (5 * Math.sin(a)).toFixed(1) + '" cy="' + (-5 * Math.cos(a)).toFixed(1) + '" r="4.2" fill="' + c + '" fill-opacity="' + o + '"/>';
  }
  return '<g ' + tf(x, y, s) + '>' + p + '<circle r="2.2" fill="#fff" fill-opacity="' + o + '"/></g>';
};

const WALLPAPERS = [
  { id: '', name: 'Обычные', css: '' },
  { id: 'aurora', name: 'Аврора', css: 'radial-gradient(circle at 15% 12%, rgba(168,85,247,.55), transparent 45%), radial-gradient(circle at 88% 30%, rgba(34,211,238,.32), transparent 42%), radial-gradient(circle at 50% 98%, rgba(236,72,153,.45), transparent 52%), linear-gradient(180deg, #160a33, #0b0620)' },
  { id: 'sparkles', name: 'Искры', css: svgUrl(spark(20, 25, 1, .3) + spark(95, 60, .7, .24) + spark(50, 105, .9, .27) + spark(120, 125, .6, .22) + dot(75, 18, 2, '#fff', .22) + dot(15, 80, 1.6, '#fff', .2) + dot(110, 100, 2, '#fff', .2)) + ', linear-gradient(160deg, #3b1a78, #1a0b3d)' },
  { id: 'hearts', name: 'Сердечки', css: svgUrl(heart(25, 25, 1.1, '#ff7ac8', .3) + heart(92, 50, .8, '#ff9ad5', .24) + heart(55, 100, 1, '#ff7ac8', .27) + heart(122, 115, .7, '#c084fc', .34) + dot(18, 70, 2, '#fff', .2) + dot(75, 20, 1.6, '#fff', .2)) + ', linear-gradient(160deg, #4a1d7a, #241046)' },
  { id: 'moon', name: 'Лунная ночь', css: svgUrl(moon(30, 30, 1, .27) + spark(95, 25, .6, .32) + spark(70, 78, .8, .27) + moon(112, 108, .7, .22) + dot(20, 100, 2, '#fff', .28) + dot(126, 62, 1.5, '#fff', .28)) + ', linear-gradient(170deg, #2a1769, #0d0829)' },
  { id: 'flowers', name: 'Алые розы', css: svgUrl(flower(32, 32, 1.3, '#ff3b5c', .3) + flower(102, 78, 1, '#ff3b5c', .26) + flower(45, 112, .8, '#c084fc', .3) + dot(88, 20, 2, '#fff', .2) + dot(125, 30, 1.5, '#fff', .2)) + ', linear-gradient(160deg, #3d1252, #1a0624)' },
  { id: 'confetti', name: 'Конфетти', css: svgUrl(dot(20, 20, 4, '#ec4899', .4) + dot(70, 40, 2.5, '#22d3ee', .4) + dot(115, 25, 3.5, '#fff', .22) + dot(40, 80, 3, '#facc15', .34) + dot(95, 95, 4, '#a855f7', .55) + dot(130, 125, 2.5, '#ec4899', .34) + dot(15, 125, 3, '#22d3ee', .34) + dot(75, 130, 2, '#fff', .27)) + ', linear-gradient(160deg, #3a1a72, #1c0c40)' },
  { id: 'grid', name: 'Неон', css: 'linear-gradient(rgba(168,85,247,.25) 1px, transparent 1px) 0 0 / 32px 32px, linear-gradient(90deg, rgba(168,85,247,.25) 1px, transparent 1px) 0 0 / 32px 32px, radial-gradient(circle at 50% 112%, rgba(236,72,153,.55), transparent 58%), linear-gradient(#12062b, #0a0418)' },
];

let wallUrl = null, wallV = -1;

async function loadCustomWall() {
  if (me.wallpaper !== 'custom' || (wallUrl && wallV === me.wallpaper_v)) return;
  const r = await fetch('/api/wallpaper-image', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return;
  wallUrl = URL.createObjectURL(await r.blob());
  wallV = me.wallpaper_v;
}

function wallCss(id) {
  if (id === 'custom') return wallUrl ? 'linear-gradient(rgba(8,5,20,.45), rgba(8,5,20,.45)), center / cover url(' + wallUrl + ')' : '';
  const w = WALLPAPERS.find((x) => x.id === id);
  return w ? w.css : '';
}

async function applyWallpaper() {
  try { await loadCustomWall(); } catch { /* останутся прежние обои */ }
  document.querySelector('.messages').style.background = wallCss(me.wallpaper || '');
}

function renderWallGrid() {
  const grid = $('wallGrid');
  grid.innerHTML = '';
  const tiles = WALLPAPERS.map((w) => ({ id: w.id, name: w.name, css: w.css }));
  if (me.has_wallpaper_img) tiles.push({ id: 'custom', name: 'Моё фото', css: wallCss('custom') });
  tiles.forEach((w) => {
    const t = el('div', 'wall-tile' + ((me.wallpaper || '') === w.id ? ' sel' : ''));
    if (w.css) t.style.background = w.css;
    t.append(el('span', null, w.name));
    t.onclick = () => setWallpaper(w.id);
    grid.append(t);
  });
  const add = el('div', 'wall-tile wall-add', '＋');
  add.append(el('span', null, 'Своё фото'));
  add.onclick = () => $('wallFile').click();
  grid.append(add);
}

function saveMe() { store.set('me', JSON.stringify(me)); }

async function setWallpaper(id) {
  $('wallErr').textContent = '';
  try {
    await api('wallpaper', { method: 'PUT', body: { wallpaper: id } });
    me.wallpaper = id; saveMe();
    await applyWallpaper();
    renderWallGrid();
  } catch (e) { $('wallErr').textContent = e.message; }
}

function initWallpapers() {
  $('openWall').onclick = () => { closeProfile(); $('wallErr').textContent = ''; renderWallGrid(); $('wallModal').classList.remove('hidden'); };
  $('closeWall').onclick = () => $('wallModal').classList.add('hidden');
  $('wallModal').addEventListener('click', (e) => { if (e.target.id === 'wallModal') $('wallModal').classList.add('hidden'); });
  $('wallFile').onchange = async () => {
    const f = $('wallFile').files[0];
    $('wallFile').value = '';
    if (!f) return;
    $('wallErr').textContent = 'Загружаю…';
    try {
      const blob = await compressImage(f, 1600);
      const r = await fetch('/api/wallpaper-image', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + token }, body: blob });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Ошибка сервера (' + r.status + ')');
      Object.assign(me, { wallpaper: 'custom', wallpaper_v: d.wallpaper_v, has_wallpaper_img: true });
      saveMe(); wallUrl = null;
      await applyWallpaper();
      renderWallGrid();
      $('wallErr').textContent = '';
    } catch (e) { $('wallErr').textContent = e.message; }
  };
}
// END
