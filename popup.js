const setupView = document.getElementById('setupView');
const mainView = document.getElementById('mainView');
const masterCheckbox = document.getElementById('masterCheckbox');
const destinationCheckbox = document.getElementById('destinationCheckbox');
const mergeCheckbox = document.getElementById('mergeCheckbox');
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
const statusTabButton = document.getElementById('statusTabButton');
const activityTabButton = document.getElementById('activityTabButton');
const troubleshootingTabButton = document.getElementById('troubleshootingTabButton');
const conflictsTabButton = document.getElementById('conflictsTabButton');
const conflictsCount = document.getElementById('conflictsCount');
const statusTab = document.getElementById('statusTab');
const activityTab = document.getElementById('activityTab');
const troubleshootingTab = document.getElementById('troubleshootingTab');
const conflictsTab = document.getElementById('conflictsTab');
const activityList = document.getElementById('activityList');
const activityEmpty = document.getElementById('activityEmpty');
const conflictsList = document.getElementById('conflictsList');
const conflictsEmpty = document.getElementById('conflictsEmpty');
const resetTrackingButton = document.getElementById('resetTrackingButton');
const resetTrackingMessage = document.getElementById('resetTrackingMessage');

function showTab(tabName) {
  statusTab.classList.toggle('hidden', tabName !== 'status');
  activityTab.classList.toggle('hidden', tabName !== 'activity');
  troubleshootingTab.classList.toggle('hidden', tabName !== 'troubleshooting');
  conflictsTab.classList.toggle('hidden', tabName !== 'conflicts');
  statusTabButton.classList.toggle('active', tabName === 'status');
  activityTabButton.classList.toggle('active', tabName === 'activity');
  troubleshootingTabButton.classList.toggle('active', tabName === 'troubleshooting');
  conflictsTabButton.classList.toggle('active', tabName === 'conflicts');
}

statusTabButton.addEventListener('click', () => showTab('status'));
activityTabButton.addEventListener('click', () => showTab('activity'));
troubleshootingTabButton.addEventListener('click', () => showTab('troubleshooting'));
conflictsTabButton.addEventListener('click', () => showTab('conflicts'));

const ACTIVITY_SOURCE_LABELS = { master: 'Push', destination: 'Pull', backup: 'Backup', restore: 'Restore' };

function formatLogTime(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function renderActivity(log) {
  activityList.innerHTML = '';
  if (!log || !log.length) {
    activityEmpty.classList.remove('hidden');
    return;
  }
  activityEmpty.classList.add('hidden');

  for (const entry of log) {
    const row = document.createElement('div');
    row.className = entry.ok === false ? 'activityRow activityError' : 'activityRow';

    const top = document.createElement('div');
    top.className = 'activityTop';
    const source = document.createElement('span');
    source.className = 'activitySource';
    source.textContent = ACTIVITY_SOURCE_LABELS[entry.source] || entry.source || 'Sync';
    const time = document.createElement('span');
    time.className = 'activityTime';
    time.textContent = formatLogTime(entry.time);
    top.appendChild(source);
    top.appendChild(time);

    const message = document.createElement('div');
    message.className = 'activityMessage';
    let text = entry.message || '';
    if (entry.ok !== false && typeof entry.total === 'number') {
      text += ` (${entry.synced}/${entry.total})`;
    }
    message.textContent = text;

    row.appendChild(top);
    row.appendChild(message);
    activityList.appendChild(row);
  }
}

function conflictLocationText(side) {
  if (!side) return '';
  const folder = side.displayPath ? side.displayPath.replace(/#/g, '') : '(top level)';
  return `${side.title || '(no title)'} - in ${folder}`;
}

// builds "<strong>label</strong><br>detail" without ever touching
// innerHTML - label/detail come from synced data (device labels, bookmark
// titles) which could contain arbitrary text from another device, so
// this has to go through textContent/DOM nodes rather than a template
// string, or a malicious title could inject markup into the popup.
function appendVersionLine(container, label, detail) {
  const strong = document.createElement('strong');
  strong.textContent = label;
  container.appendChild(strong);
  container.appendChild(document.createElement('br'));
  container.appendChild(document.createTextNode(detail));
}

function renderConflicts(conflicts) {
  conflictsList.innerHTML = '';
  const list = conflicts || [];
  conflictsTabButton.classList.toggle('hidden', list.length === 0);
  conflictsCount.textContent = list.length ? ` (${list.length})` : '';

  if (!list.length) {
    conflictsEmpty.classList.remove('hidden');
    return;
  }
  conflictsEmpty.classList.add('hidden');

  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'conflictRow';

    const kindEl = document.createElement('div');
    kindEl.className = 'conflictUrl';
    kindEl.textContent = c.kind === 'folder' ? `Folder` : c.url || '';
    row.appendChild(kindEl);

    const versions = document.createElement('div');
    versions.className = 'conflictVersions';

    const mine = document.createElement('div');
    mine.className = 'conflictVersion';
    const buttons = document.createElement('div');
    buttons.className = 'conflictButtons';

    if (c.type === 'edit-delete') {
      const deletedHere = Boolean(c.local && c.local.deletedAt);
      if (deletedHere) {
        appendVersionLine(mine, 'This computer', 'Deleted');
      } else {
        appendVersionLine(mine, c.remote.deviceLabel || 'Other device', conflictLocationText(c.remote));
      }
      versions.appendChild(mine);

      const keepDeleteBtn = document.createElement('button');
      keepDeleteBtn.className = 'primary danger';
      keepDeleteBtn.textContent = 'Delete it';
      keepDeleteBtn.addEventListener('click', () => resolve(c.id, 'delete'));

      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'primary';
      restoreBtn.textContent = 'Keep the edited version';
      restoreBtn.addEventListener('click', () => resolve(c.id, 'restore'));

      buttons.appendChild(keepDeleteBtn);
      buttons.appendChild(restoreBtn);
    } else {
      appendVersionLine(mine, 'This computer', conflictLocationText(c.local));
      const theirs = document.createElement('div');
      theirs.className = 'conflictVersion';
      appendVersionLine(theirs, c.remote.deviceLabel || 'Other device', conflictLocationText(c.remote));
      versions.appendChild(mine);
      versions.appendChild(theirs);

      const keepMineBtn = document.createElement('button');
      keepMineBtn.className = 'linkButton';
      keepMineBtn.textContent = 'Keep mine';
      keepMineBtn.addEventListener('click', () => resolve(c.id, 'local'));

      const keepTheirsBtn = document.createElement('button');
      keepTheirsBtn.className = 'linkButton';
      keepTheirsBtn.textContent = 'Keep theirs';
      keepTheirsBtn.addEventListener('click', () => resolve(c.id, 'remote'));

      const keepBothBtn = document.createElement('button');
      keepBothBtn.className = 'primary';
      keepBothBtn.textContent = 'Keep both';
      keepBothBtn.addEventListener('click', () => resolve(c.id, 'both'));

      buttons.appendChild(keepMineBtn);
      buttons.appendChild(keepTheirsBtn);
      buttons.appendChild(keepBothBtn);
    }

    row.appendChild(versions);
    row.appendChild(buttons);
    conflictsList.appendChild(row);
  }
}

async function resolve(conflictId, resolution) {
  await send({ type: 'resolveConflict', conflictId, resolution });
  await render();
}

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
  if (mergeCheckbox.checked) return 'merge';
  return null;
}

function uncheckOthers(keep) {
  for (const box of [masterCheckbox, destinationCheckbox, mergeCheckbox]) {
    if (box !== keep) box.checked = false;
  }
}

masterCheckbox.addEventListener('change', () => {
  if (masterCheckbox.checked) uncheckOthers(masterCheckbox);
  connectButton.disabled = !pickedRole();
});

destinationCheckbox.addEventListener('change', () => {
  if (destinationCheckbox.checked) uncheckOthers(destinationCheckbox);
  connectButton.disabled = !pickedRole();
});

mergeCheckbox.addEventListener('change', () => {
  if (mergeCheckbox.checked) uncheckOthers(mergeCheckbox);
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
  mergeCheckbox.checked = state.role === 'merge';
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

resetTrackingButton.addEventListener('click', async () => {
  if (
    !confirm(
      "Reset this device's merge tracking? It will re-join the shared group on the next sync, starting with a safety backup. No bookmarks are deleted by this."
    )
  ) {
    return;
  }
  resetTrackingButton.disabled = true;
  resetTrackingButton.textContent = 'Resetting...';
  const res = await send({ type: 'resetMergeTracking' });
  resetTrackingButton.disabled = false;
  resetTrackingButton.textContent = 'Reset merge tracking';

  if (!res.ok) {
    resetTrackingMessage.textContent = res.error || 'Could not reset tracking';
    resetTrackingMessage.classList.remove('hidden');
    resetTrackingMessage.classList.add('errorText');
    return;
  }
  resetTrackingMessage.textContent = 'Done - will re-join the group on the next sync.';
  resetTrackingMessage.classList.remove('hidden', 'errorText');
  render();
});

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

  const roleLabels = { master: 'Master Sync Source', destination: 'Destination Sync', merge: 'Merge (Two-Way)' };
  roleLabel.textContent = roleLabels[state.role] || state.role;

  statusLine.textContent = state.status === 'syncing' ? 'Syncing...' : state.lastSyncMessage;
  const stats = state.lastStats || { synced: 0, total: 0 };
  statsLine.textContent = `${stats.total} bookmarks total, synced ${stats.synced}/${stats.total}`;

  intervalSelect.value = state.syncInterval;

  troubleshootingTabButton.classList.toggle('hidden', state.role !== 'merge');
  if (state.role !== 'merge' && !troubleshootingTab.classList.contains('hidden')) {
    showTab('status');
  }

  renderActivity(state.syncLog);
  renderConflicts(state.conflicts);
}

fillIntervalOptions();
render();

// keep the popup in sync if a background sync finishes while it's open
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'stateChanged') {
    render();
  }
});
