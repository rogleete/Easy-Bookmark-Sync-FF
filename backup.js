const createButton = document.getElementById('createButton');
const createMessage = document.getElementById('createMessage');
const backupList = document.getElementById('backupList');
const emptyMessage = document.getElementById('emptyMessage');
const restoreSelect = document.getElementById('restoreSelect');
const restoreButton = document.getElementById('restoreButton');
const restoreMessage = document.getElementById('restoreMessage');
const destinationNotice = document.getElementById('destinationNotice');

let isMaster = false;

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function checkRole() {
  const state = await send({ type: 'getState' });
  isMaster = state.role === 'master';
  destinationNotice.classList.toggle('hidden', isMaster);
  restoreSelect.classList.toggle('hidden', !isMaster);
  if (!isMaster) {
    restoreButton.classList.add('hidden');
  }
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function showMessage(el, text, isError) {
  el.textContent = text;
  el.classList.remove('hidden');
  el.classList.toggle('errorText', Boolean(isError));
  el.classList.toggle('successText', !isError);
}

function hideMessage(el) {
  el.classList.add('hidden');
}

async function loadBackups() {
  backupList.innerHTML = '<p class="loading">Loading...</p>';
  const res = await send({ type: 'listBackups' });
  if (!res.ok) {
    backupList.innerHTML = '';
    showMessage(createMessage, res.error || 'Could not load backups', true);
    return;
  }
  renderBackups(res.backups);
}

function renderBackups(backups) {
  backupList.innerHTML = '';
  restoreSelect.innerHTML = '';

  if (!backups.length) {
    emptyMessage.classList.remove('hidden');
    restoreButton.disabled = true;
    return;
  }
  emptyMessage.classList.add('hidden');
  restoreButton.disabled = false;

  for (const backup of backups) {
    const countLabel = backup.bookmarkCount !== null ? `${backup.bookmarkCount} bookmarks` : 'unknown count';

    const row = document.createElement('div');
    row.className = 'backupRow';

    const info = document.createElement('div');
    info.className = 'backupInfo';
    const dateEl = document.createElement('strong');
    dateEl.textContent = formatDate(backup.createdTime);
    const countEl = document.createElement('span');
    countEl.textContent = countLabel;
    info.appendChild(dateEl);
    info.appendChild(countEl);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'linkButton dangerText';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteBackup(backup.id));

    row.appendChild(info);
    row.appendChild(deleteBtn);
    backupList.appendChild(row);

    const option = document.createElement('option');
    option.value = backup.id;
    option.textContent = `${formatDate(backup.createdTime)} - ${countLabel}`;
    restoreSelect.appendChild(option);
  }
}

createButton.addEventListener('click', async () => {
  hideMessage(createMessage);
  createButton.disabled = true;
  createButton.textContent = 'Generating...';
  const res = await send({ type: 'createBackup' });
  createButton.disabled = false;
  createButton.textContent = 'Generate a separate Backup';

  if (!res.ok) {
    showMessage(createMessage, res.error || 'Could not create backup', true);
    return;
  }
  showMessage(createMessage, `Backup created: ${res.backup.bookmarkCount} bookmarks saved`, false);
  loadBackups();
});

async function deleteBackup(fileId) {
  if (!confirm('Delete this backup permanently? This cannot be undone.')) {
    return;
  }
  const res = await send({ type: 'deleteBackup', fileId });
  if (!res.ok) {
    showMessage(createMessage, res.error || 'Could not delete backup', true);
    return;
  }
  loadBackups();
}

restoreButton.addEventListener('click', async () => {
  const fileId = restoreSelect.value;
  if (!fileId) {
    return;
  }
  const label = restoreSelect.options[restoreSelect.selectedIndex].textContent;
  if (!confirm(`Restore "${label}"? This replaces every bookmark currently in this browser and can't be undone.`)) {
    return;
  }

  hideMessage(restoreMessage);
  restoreButton.disabled = true;
  restoreButton.textContent = 'Restoring...';
  const res = await send({ type: 'restoreBackup', fileId });
  restoreButton.disabled = false;
  restoreButton.textContent = 'Restore selected backup';

  if (!res.ok) {
    showMessage(restoreMessage, res.error || 'Could not restore backup', true);
    return;
  }
  showMessage(restoreMessage, `Restored ${res.result.synced}/${res.result.total} bookmarks`, false);
});

loadBackups();
checkRole();
