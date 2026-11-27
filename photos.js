// Фото в чате: сжатие в браузере, загрузка картинок с авторизацией, уведомления
const photoCache = new Map();

async function compressImage(file, maxSide = 1280) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('Не удалось открыть изображение. Попробуйте JPG или PNG'); }
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}

// Фото приватные, поэтому качаем с токеном и показываем через blob-ссылку
function photoUrl(id) {
  if (!photoCache.has(id)) {
    photoCache.set(id, fetch('/api/photo/' + id, { headers: { Authorization: 'Bearer ' + token } })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then((b) => URL.createObjectURL(b))
      .catch((e) => { photoCache.delete(id); throw e; }));
  }
  return photoCache.get(id);
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}
// END
