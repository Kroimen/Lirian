// Группы: создание, участники, переименование, выход
let pickMode = null, groupInfo = null;
const plural = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? ' участник'
  : ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? ' участника' : ' участников'));

function openPicker(mode, candidates) {
  pickMode = mode;
  $('pickTitle').textContent = mode.gid ? 'Добавить участников' : 'Новая группа';
  $('nameWrap').classList.toggle('hidden', !!mode.gid);
  $('groupName').value = '';
  $('pickErr').textContent = '';
  const box = $('pickList');
  box.innerHTML = '';
  if (!candidates.length) box.append(el('div', 'list-empty', 'Некого добавлять'));
  candidates.forEach((u) => {
    const row = el('label', 'pick-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = u.id;
    row.append(cb, makeAvatar(u, false), el('span', 'n', u.username));
    box.append(row);
  });
  $('pickModal').classList.remove('hidden');
}

async function submitPicker() {
  const ids = [...$('pickList').querySelectorAll('input:checked')].map((c) => Number(c.value));
  const err = $('pickErr');
  err.textContent = '';
  try {
    if (!pickMode.gid) {
      const name = $('groupName').value.trim();
      if (!name) { err.textContent = 'Введи название группы'; return; }
      if (!ids.length) { err.textContent = 'Выбери хотя бы одного участника'; return; }
      const g = await api('groups', { method: 'POST', body: { name, members: ids } });
      $('pickModal').classList.add('hidden');
      await loadUsers();
      const gu = users.find((x) => x.id === g.id);
      if (gu) openChat(gu);
    } else {
      if (!ids.length) { err.textContent = 'Выбери участников'; return; }
      await api('groups/' + pickMode.gid + '/members', { method: 'POST', body: { userIds: ids } });
      $('pickModal').classList.add('hidden');
      await loadUsers();
      openGroupInfo();
    }
  } catch (e) { err.textContent = e.message; }
}

async function openGroupInfo() {
  if (!peer || peer.id >= 0) return;
  const gid = -peer.id;
  try { groupInfo = await api('groups/' + gid + '/members'); }
  catch (e) { toast(e.message); return; }
  const mine = groupInfo.owner_id === me.id;
  $('gName').textContent = peer.username;
  $('gErr').textContent = '';
  const box = $('gMembers');
  box.innerHTML = '';
  groupInfo.members.forEach((u) => {
    const row = el('div', 'pick-row');
    const tag = (u.id === groupInfo.owner_id ? ' · владелец' : '') + (u.id === me.id ? ' (ты)' : '');
    row.append(makeAvatar(u, false), el('span', 'n', u.username + tag));
    if (mine && u.id !== me.id) {
      const x = el('button', 'member-x', '✕');
      x.title = 'Убрать из группы';
      x.onclick = async () => {
        if (!confirm('Убрать ' + u.username + ' из группы?')) return;
        try { await api('groups/' + gid + '/members/' + u.id, { method: 'DELETE' }); await loadUsers(); openGroupInfo(); }
        catch (e) { $('gErr').textContent = e.message; }
      };
      row.append(x);
    }
    box.append(row);
  });
  $('gAdd').classList.toggle('hidden', !mine);
  $('gRename').classList.toggle('hidden', !mine);
  $('groupModal').classList.remove('hidden');
}

function initGroups() {
  $('newGroup').onclick = () => openPicker({}, users.filter((u) => u.id > 0 && !isSelf(u)));
  $('pickOk').onclick = submitPicker;
  $('pickCancel').onclick = () => $('pickModal').classList.add('hidden');
  $('gClose').onclick = () => $('groupModal').classList.add('hidden');
  $('gAdd').onclick = () => {
    const have = new Set(groupInfo.members.map((m) => m.id));
    $('groupModal').classList.add('hidden');
    openPicker({ gid: -peer.id }, users.filter((u) => u.id > 0 && !isSelf(u) && !have.has(u.id)));
  };
  $('gRename').onclick = async () => {
    const name = (prompt('Новое название группы', peer.username) || '').trim();
    if (!name) return;
    try { await api('groups/' + (-peer.id), { method: 'PUT', body: { name } }); await loadUsers(); openGroupInfo(); }
    catch (e) { $('gErr').textContent = e.message; }
  };
  $('gLeave').onclick = async () => {
    if (!confirm('Выйти из группы «' + peer.username + '»?')) return;
    try {
      await api('groups/' + (-peer.id) + '/members/' + me.id, { method: 'DELETE' });
      $('groupModal').classList.add('hidden');
      await loadUsers();
    } catch (e) { $('gErr').textContent = e.message; }
  };
  document.querySelector('.header-info').onclick = openGroupInfo;
  ['pickModal', 'groupModal'].forEach((id) => $(id).addEventListener('click', (e) => { if (e.target.id === id) $(id).classList.add('hidden'); }));
}
// END
