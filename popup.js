const setupView = document.getElementById('setupView');
const mainView = document.getElementById('mainView');
const masterCheckbox = document.getElementById('masterCheckbox');
const destinationCheckbox = document.getElementById('destinationCheckbox');
const connectButton = document.getElementById('connectButton');
const setupError = document.getElementById('setupError');
const roleLabel = document.getElementById('roleLabel');
const statusLine = document.getElementById('statusLine');
const statsLine = document.getElementById('statsLine');
const syncButton = document.getElementById('syncButton');
const intervalSelect = document.getElementById('intervalSelect');
const changeSettingsButton = document.getElementById('changeSettingsButton');
const signOutButton = document.getElementById('signOutButton');
const openOptionsButton = document.getElementById('openOptionsButton');
const openOptionsButtonBottom = document.getElementById('openOptionsButtonBottom');
const clientIdNotice = document.getElementById('clientIdNotice');
const manualBackupLink = document.getElementById('manualBackupLink');

manualBackupLink.href = chrome.runtime.getURL('backup.html');

openOptionsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

openOptionsButtonBottom.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function checkClientIdConfigured() {
  const { googleClientId } = await chrome.storage.local.get('googleClientId');
  const configured = Boolean(googleClientId && googleClientId.trim());
  clientIdNotice.classList.toggle('hidden', configured);
  return configured;
}

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function pickedRole() {
  if (masterCheckbox.checked) return 'master';
  if (destinationCheckbox.checked) return 'destination';
  return null;
}

masterCheckbox.addEventListener('change', () => {
  if (masterCheckbox.checked) destinationCheckbox.checked = false;
  connectButton.disabled = !pickedRole();
});

destinationCheckbox.addEventListener('change', () => {
  if (destinationCheckbox.checked) masterCheckbox.checked = false;
  connectButton.disabled = !pickedRole();
});

connectButton.addEventListener('click', async () => {
  const role = pickedRole();
  if (!role) return;
  setupError.classList.add('hidden');
  connectButton.disabled = true;
  connectButton.textContent = 'Connecting...';

  const connectResult = await send({ type: 'connectGoogle' });
  if (!connectResult.ok) {
    setupError.textContent = connectResult.error || 'Could not connect to Google. Check config.js has a valid client ID.';
    setupError.classList.remove('hidden');
    connectButton.disabled = false;
    connectButton.textContent = 'Connect Google Account';
    return;
  }

  await send({ type: 'setRole', role });
  await render();
});

syncButton.addEventListener('click', async () => {
  syncButton.disabled = true;
  syncButton.textContent = 'Syncing...';
  await send({ type: 'manualSync' });
  syncButton.disabled = false;
  syncButton.textContent = 'Sync now';
  await render();
});

intervalSelect.addEventListener('change', async () => {
  await send({ type: 'setInterval', interval: intervalSelect.value });
});

changeSettingsButton.addEventListener('click', async () => {
  const state = await send({ type: 'getState' });
  masterCheckbox.checked = state.role === 'master';
  destinationCheckbox.checked = state.role === 'destination';
  connectButton.disabled = !pickedRole();
  connectButton.textContent = 'Connect Google Account';
  mainView.classList.add('hidden');
  setupView.classList.remove('hidden');
  checkClientIdConfigured();
});

signOutButton.addEventListener('click', async () => {
  await send({ type: 'resetSetup' });
  await render();
});

function fillIntervalOptions() {
  intervalSelect.innerHTML = '';
  for (const option of SYNC_INTERVAL_OPTIONS) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    intervalSelect.appendChild(el);
  }
}

async function render() {
  const state = await send({ type: 'getState' });

  if (!state.setupComplete) {
    setupView.classList.remove('hidden');
    mainView.classList.add('hidden');
    checkClientIdConfigured();
    return;
  }

  setupView.classList.add('hidden');
  mainView.classList.remove('hidden');

  roleLabel.textContent = state.role === 'master' ? 'Master Sync Source' : 'Destination Sync';

  statusLine.textContent = state.status === 'syncing' ? 'Syncing...' : state.lastSyncMessage;
  const stats = state.lastStats || { synced: 0, total: 0 };
  statsLine.textContent = `${stats.total} bookmarks total, synced ${stats.synced}/${stats.total}`;

  intervalSelect.value = state.syncInterval;
}

fillIntervalOptions();
render();

// keep the popup in sync if a background sync finishes while it's open
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'stateChanged') {
    render();
  }
});
