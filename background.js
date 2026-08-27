// Chrome/Edge load this as a service worker, where importScripts is how a
// second file gets pulled in. Firefox runs this as a plain background
// script instead (no service worker support), and already loads config.js
// as its own separate entry via the manifest's "scripts" array - calling
// importScripts there would throw, since it doesn't exist outside a
// service worker. Guarding it lets the same file work in both.
if (typeof importScripts === 'function') {
  importScripts('config.js');
}

// Everything the extension needs to remember lives in chrome.storage.local.
// Keeping it local (not storage.sync) on purpose - the role of "master" or
// "destination" is a property of this specific computer, not something that
// should follow the person's Chrome profile around.
const DEFAULT_STATE = {
  setupComplete: false,
  role: null, // 'master' or 'destination'
  accessToken: null,
  tokenExpiresAt: 0,
  refreshToken: null,
  folderId: null,
  fileId: null,
  syncInterval: 'realtime',
  status: 'idle', // 'idle' | 'syncing' | 'error'
  lastSyncMessage: 'Not synced yet',
  lastSyncTime: null,
  lastStats: { synced: 0, total: 0 },
  dirty: false, // master only - true means a real bookmark change happened since the last upload
  lastRemoteModifiedTime: null, // Drive's modifiedTime for the file as of the last real download
  backupsFolderId: null,
  initialBackupDone: false, // true once the one-time "Initial Backup" attempt has happened, success or not
  backupLimit: DEFAULT_BACKUP_LIMIT,
  backupLimitUnlimited: false,
  syncLog: [], // short scrollable activity history shown in the popup's Activity tab

  // ---- Merge (Two-Way) only ----
  deviceLabel: '', // editable in Options; also baked into every backup's filename
  mergeFileId: null,
  mergeBootstrapped: false, // true once this device has done its one-time seed/join pass
  // keyed by this device's own local bookmark id (stable across restarts,
  // only changes if the bookmark itself is deleted) -> { stableId, url,
  // title, parentPath, localModified, lastSyncedModified }
  mergeIndex: {},
  // keyed by stableId -> { deletedAt, deviceLabel }. Kept even after the
  // matching local entry is gone, so a slower device catching up later
  // still learns the bookmark was deleted rather than re-creating it.
  tombstones: {},
  // pending items that changed on two devices in incompatible ways since
  // they last agreed - shown in the popup's Conflicts tab.
  conflicts: []
};

let debounceTimer = null;

// a plain in-memory flag doesn't survive the service worker being killed
// and restarted (which Chrome does after ~30s idle) - if that happened
// mid-sync, a second trigger could start overlapping with one still in
// flight and cause duplicate bookmarks. persisting the lock in storage
// with a timestamp survives restarts; the staleness check keeps a crashed
// run from wedging things shut forever.
const SYNC_LOCK_STALE_MS = 3 * 60 * 1000;

async function acquireSyncLock() {
  const { syncLock } = await chrome.storage.local.get('syncLock');
  const now = Date.now();
  if (syncLock && now - syncLock < SYNC_LOCK_STALE_MS) {
    return false;
  }
  await chrome.storage.local.set({ syncLock: now });
  return true;
}

async function releaseSyncLock() {
  await chrome.storage.local.remove('syncLock');
}

async function isSyncLocked() {
  const { syncLock } = await chrome.storage.local.get('syncLock');
  return Boolean(syncLock && Date.now() - syncLock < SYNC_LOCK_STALE_MS);
}

// ---------- storage helpers ----------

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_STATE, (items) => resolve(items));
  });
}

function setState(patch) {
  return new Promise((resolve) => {
    chrome.storage.local.set(patch, resolve);
  });
}

// ---------- toolbar icon badge ----------
//
// A small status dot drawn directly onto the icon, bottom-right, the same
// spot a notification count would sit. chrome.action.setBadgeText only
// ever produces a text/rect badge and can't be pinned to a corner like
// this, so instead a copy of the icon is drawn onto an OffscreenCanvas
// with the dot baked in and pushed with setIcon. OffscreenCanvas is
// available both in the Chrome/Edge service worker and in Firefox's
// plain background script, so this same code runs unmodified in both.

const BADGE_SIZE = 48;
const BADGE_DOT_COLORS = { synced: '#26A65B', error: '#E24B4A', conflict: '#E8A33D' };
const BADGE_SPINNER_TRACK = '#D8DCE1';
const BADGE_SPINNER_ARC = '#378ADD';

let baseIconBitmap = null;
let spinnerTimer = null;
let spinnerAngle = 0;

async function getBaseIconBitmap() {
  if (baseIconBitmap) {
    return baseIconBitmap;
  }
  const res = await fetch(chrome.runtime.getURL('icons/icon128.png'));
  const blob = await res.blob();
  baseIconBitmap = await createImageBitmap(blob);
  return baseIconBitmap;
}

// kind is 'synced' | 'error' | 'syncing'
async function renderBadgeFrame(kind, angle) {
  const bitmap = await getBaseIconBitmap();
  const canvas = new OffscreenCanvas(BADGE_SIZE, BADGE_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, BADGE_SIZE, BADGE_SIZE);

  const r = BADGE_SIZE * 0.2;
  const cx = BADGE_SIZE - r - 1;
  const cy = BADGE_SIZE - r - 1;

  // clear a little disc out of the icon first so the dot reads cleanly
  // against whatever was drawn underneath it
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ring so the dot doesn't blend into a dark toolbar
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  if (kind === 'syncing') {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = BADGE_SPINNER_TRACK;
    ctx.lineWidth = r * 0.45;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + Math.PI * 1.1);
    ctx.strokeStyle = BADGE_SPINNER_ARC;
    ctx.lineWidth = r * 0.45;
    ctx.lineCap = 'round';
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = BADGE_DOT_COLORS[kind] || BADGE_SPINNER_TRACK;
    ctx.fill();
  }

  return ctx.getImageData(0, 0, BADGE_SIZE, BADGE_SIZE);
}

function stopBadgeSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
}

// derives the badge purely from state and pushes the right icon. Safe to
// call any time state changes - it's cheap when nothing needs to change
// and it's the single place that decides what the icon should look like.
async function applyBadge(state) {
  let kind = 'none';
  if (state.setupComplete) {
    if (state.status === 'syncing') {
      kind = 'syncing';
    } else if (state.status === 'error') {
      kind = 'error';
    } else if (state.conflicts && state.conflicts.length) {
      kind = 'conflict';
    } else if (state.lastSyncTime) {
      kind = 'synced';
    }
  }

  if (kind !== 'syncing') {
    stopBadgeSpinner();
  }

  if (kind === 'none') {
    await chrome.action.setIcon({
      path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' }
    });
    return;
  }

  if (kind === 'syncing') {
    if (!spinnerTimer) {
      // note: a bare setInterval like this only keeps ticking while
      // something else (the in-flight Drive fetches during a real sync)
      // is also keeping the service worker alive - fine here since
      // syncing is exactly when that's true.
      spinnerTimer = setInterval(async () => {
        spinnerAngle = (spinnerAngle + 0.5) % (Math.PI * 2);
        try {
          const frame = await renderBadgeFrame('syncing', spinnerAngle);
          await chrome.action.setIcon({ imageData: frame });
        } catch (e) {
          // transient - skip this frame
        }
      }, 120);
    }
    return;
  }

  const frame = await renderBadgeFrame(kind);
  await chrome.action.setIcon({ imageData: frame });
}

async function refreshBadge() {
  await applyBadge(await getState());
}

// ---------- device label ----------
//
// Extensions can't read a computer's actual name (blocked for privacy on
// both Chrome and Firefox), so this is a person-editable label instead,
// defaulted from whatever platform info IS available so it's never
// blank. Used to identify backups once more than one device is involved,
// and to tag which device made which merge change.

async function getOrCreateDeviceLabel() {
  const state = await getState();
  if (state.deviceLabel) {
    return state.deviceLabel;
  }
  let platformName = 'this device';
  try {
    const info = await chrome.runtime.getPlatformInfo();
    const osNames = { mac: 'Mac', win: 'Windows', linux: 'Linux', cros: 'ChromeOS', android: 'Android', openbsd: 'OpenBSD' };
    platformName = osNames[info.os] || info.os;
  } catch (e) {
    // getPlatformInfo not available for some reason - fall back to the generic label above
  }
  const browserName = typeof importScripts === 'function' ? 'Chrome/Edge' : 'Firefox';
  const label = `${browserName} on ${platformName}`;
  await setState({ deviceLabel: label });
  return label;
}

// ---------- auth ----------
//
// Uses the OAuth Authorization Code flow with PKCE instead of the old
// implicit flow. The implicit flow only ever hands back a short-lived
// access token (~1hr) with no way to renew it except redoing an
// interactive or silent browser-based sign-in - and the silent version
// only works if Google's session cookie is still around, which breaks
// down with third-party cookie blocking (Firefox in particular) or if the
// browser's Google session simply expired. This flow instead exchanges
// the authorization code for a genuine refresh token once, up front, and
// every renewal after that is a plain HTTP request straight to Google's
// token endpoint - no cookies, no browser UI, no popups, ever again.
//
// Google requires a client secret for this exchange even with PKCE for
// "Web application" type OAuth clients (PKCE alone isn't enough to skip
// it the way it can for mobile/native app client types). Since each
// person connects their own personal Google Cloud project already, they
// paste their own Client Secret into Options right alongside their
// Client ID - same trust boundary as before, it never leaves their own
// browser talking to Google.

async function getClientCredentials() {
  const { googleClientId, googleClientSecret } = await chrome.storage.local.get([
    'googleClientId',
    'googleClientSecret'
  ]);
  return {
    clientId: (googleClientId || '').trim(),
    clientSecret: (googleClientSecret || '').trim()
  };
}

function base64UrlEncode(buffer) {
  let str = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return base64UrlEncode(array.buffer);
}

async function generateCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

// full interactive sign-in - only ever called from a direct user action
// (Connect, or Sync now with no refresh token available). Always prompts
// for consent so Google reliably hands back a refresh token every time,
// not just on the very first authorization.
async function authorizeWithGoogle() {
  const { clientId, clientSecret } = await getClientCredentials();
  if (!clientId || !clientSecret) {
    throw new Error("Add your Google Client ID and Client Secret on the extension's Options page first");
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authParams = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: GOOGLE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

  const redirectUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (result) => {
      if (chrome.runtime.lastError || !result) {
        reject(chrome.runtime.lastError || new Error('No redirect URL came back'));
        return;
      }
      resolve(result);
    });
  });

  const redirectParams = new URL(redirectUrl).searchParams;
  const authError = redirectParams.get('error');
  if (authError) {
    throw new Error(`Google sign-in was not completed: ${authError}`);
  }
  const code = redirectParams.get('code');
  if (!code) {
    throw new Error('Google did not return an authorization code');
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`Google token exchange failed: ${text}`);
  }

  const data = await tokenRes.json();
  const expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  const patch = { accessToken: data.access_token, tokenExpiresAt: expiresAt };
  if (data.refresh_token) {
    patch.refreshToken = data.refresh_token;
  }
  await setState(patch);
  return data.access_token;
}

// plain HTTP request to Google's token endpoint - no browser UI involved
// at all, so this works regardless of cookies, third-party cookie
// blocking, or whether the browser has an active Google session.
async function refreshAccessToken() {
  const { clientId, clientSecret } = await getClientCredentials();
  const state = await getState();
  if (!clientId || !clientSecret || !state.refreshToken) {
    throw new Error('No refresh token available - reconnect your Google account');
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: state.refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`Token refresh failed: ${text}`);
  }

  const data = await tokenRes.json();
  const expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  await setState({ accessToken: data.access_token, tokenExpiresAt: expiresAt });
  return data.access_token;
}

// Returns a usable token. Tries the cached one first, then a silent
// refresh-token exchange (works regardless of cookies or browser UI),
// and only falls back to a full interactive sign-in - which pops a
// window - when explicitly allowed (i.e. a direct user action, never a
// background-triggered sync).
async function getValidToken(allowInteractive) {
  const state = await getState();
  if (state.accessToken && Date.now() < state.tokenExpiresAt) {
    return state.accessToken;
  }
  if (state.refreshToken) {
    try {
      return await refreshAccessToken();
    } catch (refreshError) {
      if (!allowInteractive) {
        throw refreshError;
      }
      // refresh token itself is no longer valid (revoked, expired from
      // long disuse) - fall through to a full reauthorization below
    }
  }
  if (!allowInteractive) {
    throw new Error('Google sign-in expired');
  }
  return await authorizeWithGoogle();
}

// ---------- Drive REST calls ----------

async function driveFetch(token, path, options = {}) {
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Drive request failed (${res.status}): ${text}`);
  }
  return res;
}

async function findFolder(token) {
  const q = encodeURIComponent(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const res = await driveFetch(token, `/drive/v3/files?q=${q}&fields=files(id,name)`);
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

async function createFolder(token) {
  const res = await driveFetch(token, '/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });
  const data = await res.json();
  return data.id;
}

async function getOrCreateFolder(token) {
  let folderId = await findFolder(token);
  if (!folderId) {
    folderId = await createFolder(token);
  }
  await setState({ folderId });
  return folderId;
}

async function findFile(token, folderId) {
  const q = encodeURIComponent(
    `name='${DRIVE_FILE_NAME}' and '${folderId}' in parents and trashed=false`
  );
  const res = await driveFetch(token, `/drive/v3/files?q=${q}&fields=files(id,name)`);
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

// A cached file id can go stale in a way that doesn't throw: if someone
// deletes the file through Drive's own UI, that moves it to Trash rather
// than removing it outright - same id, same content, still fully
// readable/writable via the API, just invisible in a normal Drive
// listing. A query with trashed=false correctly skips it, but a cached
// id bypasses that query entirely and keeps quietly patching the trashed
// file forever with no error at any point. This checks a cached id is
// still live before trusting it.
async function isFileUsable(token, fileId) {
  try {
    const res = await driveFetch(token, `/drive/v3/files/${fileId}?fields=id,trashed`);
    const data = await res.json();
    return !data.trashed;
  } catch (e) {
    return false;
  }
}

// Same reasoning as isFileUsable above - a cached state.fileId that got
// trashed via Drive's own UI would otherwise keep getting silently
// patched forever without ever surfacing as an error.
async function getLiveFileId(token, cachedFileId, folderId) {
  if (cachedFileId && (await isFileUsable(token, cachedFileId))) {
    return cachedFileId;
  }
  return findFile(token, folderId);
}

async function uploadBookmarksJson(token, folderId, fileId, jsonString) {
  const boundary = 'ebs-boundary-' + Date.now();
  const metadata = fileId ? {} : { name: DRIVE_FILE_NAME, parents: [folderId] };
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    jsonString +
    `\r\n--${boundary}--`;

  const path = fileId
    ? `/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : '/upload/drive/v3/files?uploadType=multipart';

  const res = await driveFetch(token, path, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const data = await res.json();
  return data.id;
}

async function downloadBookmarksJson(token, fileId) {
  const res = await driveFetch(token, `/drive/v3/files/${fileId}?alt=media`);
  return res.text();
}

// ---------- manual backups (separate from the live sync file) ----------
// these live in their own "Backups" subfolder so they never get touched
// by the regular master/destination sync, which only ever reads/writes
// the one live bookmarks.json file

async function findBackupsFolder(token, parentId) {
  const q = encodeURIComponent(
    `name='Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`
  );
  const res = await driveFetch(token, `/drive/v3/files?q=${q}&fields=files(id,name)`);
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

async function createBackupsFolder(token, parentId) {
  const res = await driveFetch(token, '/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Backups', mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const data = await res.json();
  return data.id;
}

async function getOrCreateBackupsFolder(token) {
  const state = await getState();
  if (state.backupsFolderId) {
    return state.backupsFolderId;
  }
  const mainFolderId = state.folderId || (await getOrCreateFolder(token));
  let backupsFolderId = await findBackupsFolder(token, mainFolderId);
  if (!backupsFolderId) {
    backupsFolderId = await createBackupsFolder(token, mainFolderId);
  }
  await setState({ backupsFolderId });
  return backupsFolderId;
}

async function listBackupFiles(token) {
  const backupsFolderId = await getOrCreateBackupsFolder(token);
  const q = encodeURIComponent(`'${backupsFolderId}' in parents and trashed=false`);
  const res = await driveFetch(
    token,
    `/drive/v3/files?q=${q}&fields=files(id,name,createdTime,properties)&orderBy=createdTime desc`
  );
  const data = await res.json();
  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    createdTime: f.createdTime,
    bookmarkCount: f.properties && f.properties.bookmarkCount ? parseInt(f.properties.bookmarkCount, 10) : null
  }));
}

async function createBackupFile(token, options = {}) {
  const backupsFolderId = await getOrCreateBackupsFolder(token);
  const tree = await getSerializedTree();
  const total = countUrls(tree);
  const jsonString = JSON.stringify(tree);

  const now = new Date();
  const stamp = now.toISOString().replace(/:/g, '-').split('.')[0];
  const label = options.label || 'Backup';
  const name = `${label} ${stamp} (${total} bookmarks).json`;

  const metadata = {
    name,
    parents: [backupsFolderId],
    properties: { bookmarkCount: String(total) }
  };

  const boundary = 'ebs-boundary-' + Date.now();
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    jsonString +
    `\r\n--${boundary}--`;

  const res = await driveFetch(token, '/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const data = await res.json();
  return { id: data.id, name, createdTime: now.toISOString(), bookmarkCount: total };
}

async function restoreBackupFile(token, fileId) {
  const jsonString = await downloadBookmarksJson(token, fileId);
  const tree = JSON.parse(jsonString);
  const result = await restoreSerializedTree(tree);

  const state = await getState();
  if (state.role === 'master') {
    // the local tree just changed underneath the live sync file - flag it
    // dirty so the restored state gets pushed back up to the cloud on the
    // next sync instead of getting overwritten
    await setState({ dirty: true });
  } else if (state.role === 'merge') {
    // every local bookmark/folder id the merge index was tracking is now
    // gone (restoreSerializedTree wipes and rebuilds everything), so that
    // index is entirely stale. Rather than try to patch it up, treat this
    // exactly like a device joining the group for the first time - the
    // next sync re-runs the join reconciliation (Pre-Merge Backup, then
    // matching) against whatever's currently in the shared file, which is
    // the safe way to re-derive tracking from a tree that just changed
    // out from under it.
    await setState({ mergeBootstrapped: false, mergeIndex: {} });
  }

  return result;
}

async function deleteBackupFile(token, fileId) {
  await driveFetch(token, `/drive/v3/files/${fileId}`, { method: 'DELETE' });
}

// Manual backups (the timestamped "Backup ..." files) and the automatic
// "Initial Backup" share one pool and one limit. listBackupFiles already
// comes back newest-first, so anything past the limit is the oldest
// overflow.
async function pruneBackupsIfNeeded(token) {
  const state = await getState();
  if (state.backupLimitUnlimited) {
    return;
  }
  const limit = Math.max(1, parseInt(state.backupLimit, 10) || DEFAULT_BACKUP_LIMIT);
  const backups = await listBackupFiles(token);
  if (backups.length <= limit) {
    return;
  }
  for (const backup of backups.slice(limit)) {
    await deleteBackupFile(token, backup.id);
  }
}

// Runs once ever, right after the very first successful Google sign-in,
// so there's always a safety snapshot in Drive before any sync has had a
// chance to touch anything. Only attempted the one time - if it fails
// (network blip, etc.) it's logged to the Activity tab instead of being
// retried on every later sign-in, since retrying would defeat the "very
// first sign-in overall" intent and could surprise someone with a second
// unexpected backup later on.
async function createInitialBackupIfNeeded(token) {
  const state = await getState();
  if (state.initialBackupDone) {
    return;
  }
  try {
    const deviceLabel = await getOrCreateDeviceLabel();
    const backup = await createBackupFile(token, { label: `Initial Backup - ${deviceLabel}` });
    await pruneBackupsIfNeeded(token);
    await appendSyncLog({
      source: 'backup',
      ok: true,
      message: `Initial Backup created: ${backup.bookmarkCount} bookmarks`
    });
  } catch (err) {
    await appendSyncLog({ source: 'backup', ok: false, message: `Initial Backup failed: ${err.message}` });
  } finally {
    await setState({ initialBackupDone: true });
  }
}

// ---------- bookmark tree <-> plain JSON ----------

function serializeNode(node) {
  const out = { title: node.title || '' };
  if (node.url) {
    out.url = node.url;
  }
  if (node.children) {
    out.children = node.children.map(serializeNode);
  }
  return out;
}

// Chrome/Edge and Firefox both expose a handful of special top-level
// bookmark folders (toolbar, "other"/unfiled, mobile, and on Firefox a
// menu folder too), but they don't agree on the order those show up in,
// and Firefox has one more of them than Chromium does. Each browser does
// give these folders the same fixed internal id every time, though, so
// using that instead of raw position is what makes a folder actually
// mean the same thing on both ends instead of just "whatever's third".
function detectFolderRole(node) {
  const id = node.id;
  // Chromium (Chrome, Edge)
  if (id === '1') return 'toolbar';
  if (id === '2') return 'other';
  if (id === '3') return 'mobile';
  // Firefox
  if (id === 'toolbar_____') return 'toolbar';
  if (id === 'menu________') return 'menu';
  if (id === 'unfiled_____') return 'other';
  if (id === 'mobile______') return 'mobile';
  return null;
}

// A protected top-level folder (or the invisible root itself) should
// never end up as the TARGET of an update/move/remove call - those ids
// are only ever meant to be used as a parentId when creating something
// new inside them. If one shows up here, it means a mergeIndex entry got
// built incorrectly somewhere upstream - skip the operation rather than
// let Chrome/Firefox throw and abort the whole sync, and log loudly so
// it's traceable. Checks the actual tree structure, not just the known
// id list, since a browser can have a special folder under an id that
// list doesn't recognize (that gap is what caused this class of bug).
async function isProtectedLocalId(id) {
  if (id === '0') {
    return true;
  }
  if (detectFolderRole({ id })) {
    return true;
  }
  try {
    const roots = await chrome.bookmarks.getTree();
    return roots[0].children.some((n) => n.id === id);
  } catch (e) {
    return false;
  }
}

function warnProtectedId(where, id, extra) {
  console.warn(`[EasyBookmarkSync] refusing to modify protected folder id=${id} at ${where}`, extra || '');
}

async function getSerializedTree() {
  const roots = await chrome.bookmarks.getTree();
  // roots[0] is the invisible root node, its children are the actual
  // top level folders (Bookmarks Bar/Toolbar, Other Bookmarks, etc).
  return roots[0].children.map((node) => {
    const serialized = serializeNode(node);
    const role = detectFolderRole(node);
    if (role) {
      serialized.role = role;
    }
    return serialized;
  });
}

function countUrls(nodes) {
  let count = 0;
  for (const node of nodes) {
    if (node.url) {
      count += 1;
    } else if (node.children) {
      count += countUrls(node.children);
    }
  }
  return count;
}

async function createSubtree(parentId, node) {
  if (node.url) {
    await chrome.bookmarks.create({ parentId, title: node.title, url: node.url });
    return 1;
  }
  const created = await chrome.bookmarks.create({ parentId, title: node.title });
  // only count actual bookmarks toward "synced", folders aren't part of the total either
  let synced = 0;
  if (node.children) {
    for (const child of node.children) {
      synced += await createSubtree(created.id, child);
    }
  }
  return synced;
}

// wipes a single local top-level folder's children and rebuilds them from
// the matching incoming folder, returning how many bookmarks were created
async function applyFolderContents(localFolder, incomingFolder) {
  if (localFolder.children) {
    for (const child of localFolder.children) {
      await chrome.bookmarks.removeTree(child.id);
    }
  }
  let synced = 0;
  if (incomingFolder.children) {
    for (const child of incomingFolder.children) {
      synced += await createSubtree(localFolder.id, child);
    }
  }
  return synced;
}

// Wipes out the children of each top level folder and rebuilds them from
// the JSON pulled down from Drive. The top level folders themselves
// (Bookmarks Bar, Other Bookmarks, etc) are special nodes the browser
// manages - you can't delete or create new ones, only match up to what's
// already there. Matching is done by each folder's role (toolbar, other,
// mobile, menu) rather than raw position, so a Chrome master and a
// Firefox destination (which order and count these folders differently)
// still land bookmarks in the folder that actually corresponds, instead
// of just whichever one happens to be in the same list position.
async function restoreSerializedTree(serializedRoots) {
  const localRoots = await chrome.bookmarks.getTree();
  const localTopLevel = localRoots[0].children;
  let synced = 0;
  const total = countUrls(serializedRoots);

  const localByRole = {};
  for (const node of localTopLevel) {
    const role = detectFolderRole(node);
    if (role) {
      localByRole[role] = node;
    }
  }

  const usedLocalIds = new Set();
  const unmatchedIncoming = [];

  for (const incoming of serializedRoots) {
    const target = incoming.role ? localByRole[incoming.role] : null;
    if (target) {
      synced += await applyFolderContents(target, incoming);
      usedLocalIds.add(target.id);
    } else {
      // no role tag (an older backup made before this existed) or this
      // browser doesn't have a folder for that role (e.g. Firefox's menu
      // folder has no Chrome/Edge equivalent) - fall back to matching
      // whatever local folders are left over, by position, same as before
      unmatchedIncoming.push(incoming);
    }
  }

  const leftoverLocal = localTopLevel.filter((node) => !usedLocalIds.has(node.id));
  const fallbackLimit = Math.min(leftoverLocal.length, unmatchedIncoming.length);
  for (let i = 0; i < fallbackLimit; i++) {
    synced += await applyFolderContents(leftoverLocal[i], unmatchedIncoming[i]);
  }

  return { synced, total };
}

// ---------- Merge (Two-Way) ----------
//
// Master/Destination sync writes and reads a plain bookmark tree with no
// per-item identity - that's what makes it simple and safe, but it also
// means it can't tell "this one thing changed" apart from "the whole
// tree is different." Merge devices need real identity for BOTH
// bookmarks and folders, so this section keeps its own local index
// (mergeIndex) mapping each of THIS device's local bookmark/folder ids
// to a stable id that means the same thing on every device, plus
// deletion tombstones so a delete on one device doesn't get silently
// undone by a slower device that hasn't caught up yet.
//
// Giving folders their own identity (not just a title in a path string)
// matters specifically for renames: with only a title-path, renaming a
// folder on one device makes every device that already has it use a
// path match, fail to find it, and create a second folder under the new
// name instead of renaming the one that's already there. With a stable
// id, a rename is just "this folder's title changed" - the folder
// itself, and everything already filed in it, aren't touched at all.
//
// Merge devices never touch the Master/Destination live file - they sync
// to their own DRIVE_MERGE_FILE_NAME instead, so the two modes can
// coexist on different devices in the same Drive folder without either
// one interfering with the other.

// set to true only while THIS code is applying an incoming remote change
// to the local bookmark tree - the bookmark-event listener checks this
// and skips marking things dirty while it's set. Without this guard, a
// device applying someone else's change would see its own
// chrome.bookmarks events fire, think "local edit, gotta push," and echo
// the same change straight back up - which is exactly the realtime
// re-download loop to avoid.
let applyingRemoteChange = false;

// Walks the live local bookmark tree into a flat list of both bookmarks
// AND folders (top-level folders like Toolbar/Other/Mobile/Menu excepted
// - those are identified by role, never renamed or moved by a person,
// and don't need a stable id of their own). Each item's parentTag is
// either a role string ('#toolbar') or another item's own local id -
// always something already seen earlier in this same list, since the
// walk visits parents before their children.
async function buildLocalMergeSnapshot() {
  const roots = await chrome.bookmarks.getTree();
  const items = [];
  // structural, not id-based: whatever the browser actually put directly
  // under the invisible root is protected, regardless of whether its id
  // matches the handful we know how to name. Relying on id matching
  // alone missed a real special folder on Edge that doesn't use the same
  // id as Chrome, which let it get tracked (and later mutated) as if it
  // were an ordinary folder - exactly the kind of thing Chrome/Edge
  // refuse with "Can't modify the root bookmark folders."
  const topLevelIds = new Set(roots[0].children.map((n) => n.id));

  function walk(node, parentTag, parentPathArr) {
    if (node.url) {
      items.push({
        kind: 'bookmark',
        localId: node.id,
        url: node.url,
        title: node.title || '',
        parentTag,
        bootstrapPath: parentPathArr.join(' / ')
      });
      return;
    }
    const role = detectFolderRole(node);
    const isTopLevel = topLevelIds.has(node.id);
    // a recognized role gets its friendly tag; an unrecognized top-level
    // folder still gets a stable (if not cross-device-portable) tag based
    // on its own id, rather than being tracked as an ordinary folder
    const tag = role ? `#${role}` : isTopLevel ? `#slot-${node.id}` : node.id;
    const label = role ? `#${role}` : isTopLevel ? `#slot-${node.id}` : node.title || '';

    if (!isTopLevel && node.parentId) {
      items.push({
        kind: 'folder',
        localId: node.id,
        title: node.title || '',
        parentTag,
        bootstrapPath: parentPathArr.join(' / ')
      });
    }

    if (node.children) {
      for (const child of node.children) {
        walk(child, tag, [...parentPathArr, label]);
      }
    }
  }

  for (const topNode of roots[0].children) {
    walk(topNode, null, []);
  }
  return items;
}

// Turns a local parentTag (role string or another item's local id) into
// a portable parentRef (role string or that item's stableId) that means
// the same thing on every device. Only safe to call once the parent
// itself has an index entry, which top-down processing order guarantees.
function parentRefFor(parentTag, mergeIndex) {
  if (!parentTag) {
    return null;
  }
  if (parentTag.startsWith('#')) {
    return parentTag;
  }
  const parentEntry = mergeIndex[parentTag];
  return parentEntry ? parentEntry.stableId : null;
}

// The inverse: given a portable ref, finds (or creates, recursively
// creating any missing ancestor folders along the way) the matching
// local folder and returns its local id. folderLocalIdByStableId is a
// cache shared across one sync pass so repeated lookups don't rescan.
async function resolveLocalFolderForRef(ref, mergeIndex, remoteFoldersByStableId, folderLocalIdByStableId, depth = 0) {
  if (depth > 40) {
    // a cyclic parentRef chain would recurse forever otherwise - this
    // should never legitimately happen, but a corrupted shared file is
    // exactly the kind of thing that could produce one, and a stack
    // overflow taking down the whole sync is a worse failure than
    // landing something in the wrong folder
    console.warn('[EasyBookmarkSync] folder reference chain too deep, likely cyclic - falling back to Other Bookmarks', ref);
    return resolveLocalFolderForRef('#other', mergeIndex, remoteFoldersByStableId, folderLocalIdByStableId, 0);
  }

  if (!ref || ref.startsWith('#')) {
    const role = ref ? ref.slice(1) : 'other';
    const roots = await chrome.bookmarks.getTree();
    const match = roots[0].children.find((n) => detectFolderRole(n) === role);
    if (match) {
      return match.id;
    }
    // this device doesn't have a folder for that role at all - most often
    // Firefox's Bookmarks Menu (#menu) syncing to Chrome/Edge, which has
    // no menu-bar equivalent. Route it somewhere predictable (Other
    // Bookmarks) rather than whichever top-level folder happens to be
    // first, so the same content always lands in the same place instead
    // of depending on folder order.
    const other = roots[0].children.find((n) => detectFolderRole(n) === 'other');
    if (other) {
      return other.id;
    }
    const fallback = roots[0].children.find((n) => !n.url) || roots[0].children[0];
    return fallback.id;
  }

  if (folderLocalIdByStableId.has(ref)) {
    return folderLocalIdByStableId.get(ref);
  }

  const def = remoteFoldersByStableId.get(ref);
  if (!def) {
    // unknown reference (shouldn't normally happen) - fall back rather than failing outright
    return resolveLocalFolderForRef('#other', mergeIndex, remoteFoldersByStableId, folderLocalIdByStableId, depth + 1);
  }

  const parentLocalId = await resolveLocalFolderForRef(def.parentRef, mergeIndex, remoteFoldersByStableId, folderLocalIdByStableId, depth + 1);
  const created = await chrome.bookmarks.create({ parentId: parentLocalId, title: def.title });
  mergeIndex[created.id] = {
    stableId: ref,
    kind: 'folder',
    title: def.title,
    parentRef: def.parentRef,
    localModified: def.lastModified,
    lastSyncedModified: def.lastModified
  };
  folderLocalIdByStableId.set(ref, created.id);
  return created.id;
}

// One-time bootstrap-only matching key for a folder: its full path
// including its own title, so "Toolbar / Work" only matches another
// device's "Toolbar / Work". Never used again after bootstrap - ongoing
// sync relies entirely on stable ids by then.
function folderFullPath(item) {
  return item.bootstrapPath ? `${item.bootstrapPath} / ${item.title}` : item.title;
}

function remoteFolderFullPath(stableId, remoteFoldersByStableId) {
  const segments = [];
  let ref = stableId;
  let guard = 0;
  while (ref && !ref.startsWith('#') && guard < 50) {
    const def = remoteFoldersByStableId.get(ref);
    if (!def) {
      break;
    }
    segments.unshift(def.title);
    ref = def.parentRef;
    guard++;
  }
  if (ref && ref.startsWith('#')) {
    segments.unshift(ref);
  }
  return segments.join(' / ');
}

// Friendly "Toolbar / Work" style string for a ref, used only when
// building a conflict entry for display in the popup - checks both this
// device's own index and whatever the remote file knows about, since a
// conflict can reference a folder either side created.
function refDisplayPath(ref, folderInfoByStableId) {
  if (!ref) {
    return '(top level)';
  }
  if (ref.startsWith('#')) {
    return ref.slice(1);
  }
  const segments = [];
  let cur = ref;
  let guard = 0;
  while (cur && !cur.startsWith('#') && guard < 50) {
    const info = folderInfoByStableId.get(cur);
    if (!info) {
      break;
    }
    segments.unshift(info.title);
    cur = info.parentRef;
    guard++;
  }
  if (cur && cur.startsWith('#')) {
    segments.unshift(cur.slice(1));
  }
  return segments.join(' / ') || '(top level)';
}

function buildFolderInfoByStableId(mergeIndex, remoteFoldersByStableId) {
  const map = new Map();
  for (const entry of Object.values(mergeIndex)) {
    if (entry.kind === 'folder') {
      map.set(entry.stableId, { title: entry.title, parentRef: entry.parentRef });
    }
  }
  for (const [stableId, def] of remoteFoldersByStableId) {
    if (!map.has(stableId)) {
      map.set(stableId, { title: def.title, parentRef: def.parentRef });
    }
  }
  return map;
}

// ---------- Merge Drive file ----------

async function getMergeFileId(token) {
  const state = await getState();
  if (state.mergeFileId) {
    if (await isFileUsable(token, state.mergeFileId)) {
      return state.mergeFileId;
    }
    // cached id points at a trashed (or otherwise unusable) file -
    // forget it and look for a real, live one instead
    await setState({ mergeFileId: null });
  }
  const folderId = state.folderId || (await getOrCreateFolder(token));
  const q = encodeURIComponent(`name='${DRIVE_MERGE_FILE_NAME}' and '${folderId}' in parents and trashed=false`);
  const res = await driveFetch(token, `/drive/v3/files?q=${q}&fields=files(id,name)`);
  const data = await res.json();
  const fileId = data.files && data.files.length ? data.files[0].id : null;
  if (fileId) {
    await setState({ mergeFileId: fileId });
  }
  return fileId;
}

async function downloadMergeFile(token, fileId) {
  const text = await downloadBookmarksJson(token, fileId);
  try {
    const parsed = JSON.parse(text);
    return { folders: parsed.folders || [], bookmarks: parsed.bookmarks || [], tombstones: parsed.tombstones || [] };
  } catch (e) {
    return { folders: [], bookmarks: [], tombstones: [] };
  }
}

async function uploadMergeFile(token, folderId, fileId, payload) {
  const jsonString = JSON.stringify(payload);
  const boundary = 'ebs-boundary-' + Date.now();
  const metadata = fileId ? {} : { name: DRIVE_MERGE_FILE_NAME, parents: [folderId] };
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    jsonString +
    `\r\n--${boundary}--`;

  const path = fileId
    ? `/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : '/upload/drive/v3/files?uploadType=multipart';

  const res = await driveFetch(token, path, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const data = await res.json();
  return data.id;
}

function pruneOldTombstones(tombstones) {
  const cutoff = Date.now() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const next = {};
  for (const [stableId, t] of Object.entries(tombstones)) {
    if (t.deletedAt >= cutoff) {
      next[stableId] = t;
    }
  }
  return next;
}

// ---------- Merge sync itself ----------
//
// Runs inside the same lock/token/folder setup as the regular
// performSync - see the 'merge' branch there. Two very different paths:
// the one-time bootstrap (seed the group, or join an existing one with a
// one-time path-matching pass for folders and a URL-matching pass for
// bookmarks), and every sync after that, which is a straightforward
// "diff my local tree against my own last-known state, diff the remote
// file against what I applied last time, apply what's safe, flag the
// rest as conflicts" - folders processed before bookmarks each time, so
// a folder a bookmark needs to land in always exists first.
// A conflict stays pending (its lastSyncedModified deliberately doesn't
// advance) until someone resolves it, which means the same divergence
// would otherwise look "new" again on every subsequent sync. This checks
// whether a stableId already has a pending conflict before adding
// another one, so the list holds one entry per real disagreement rather
// than accumulating a fresh duplicate each time.
function hasPendingConflict(conflicts, stableId) {
  return conflicts.some((c) => c.local?.stableId === stableId || c.remote?.stableId === stableId);
}

async function runMergeSync(token, folderId, state) {
  const deviceLabel = await getOrCreateDeviceLabel();
  let mergeFileId = await getMergeFileId(token);
  let remoteExists = Boolean(mergeFileId);
  let remoteData = { folders: [], bookmarks: [], tombstones: [] };
  let forceReseed = false;

  if (remoteExists) {
    try {
      remoteData = await downloadMergeFile(token, mergeFileId);
    } catch (downloadErr) {
      // the file this device thinks it knows about is gone - most likely
      // someone deleted it in Drive directly. Rather than fail the sync
      // outright, treat it exactly like nobody's ever seeded the group:
      // recreate it from whatever this device currently has.
      remoteExists = false;
      mergeFileId = null;
      forceReseed = true;
      await setState({ mergeFileId: null });
      await appendSyncLog({
        source: 'merge',
        ok: false,
        message: 'The shared merge file was missing in Drive - recreating it from this device'
      });
    }
  }

  const bootstrapNeeded = !state.mergeBootstrapped || forceReseed || !remoteExists;
  const remoteFoldersByStableId = new Map(remoteData.folders.map((f) => [f.stableId, f]));
  const rawSnapshot = await buildLocalMergeSnapshot();
  const currentTopLevelIds = new Set((await chrome.bookmarks.getTree())[0].children.map((n) => n.id));
  const localSnapshot = rawSnapshot.filter((i) => {
    if (i.localId === '0' || currentTopLevelIds.has(i.localId)) {
      console.warn(
        '[EasyBookmarkSync] a protected top-level folder was about to be tracked as a regular item - excluding it:',
        i
      );
      return false;
    }
    return true;
  });
  const mergeIndex = { ...(state.mergeIndex || {}) };
  let tombstones = { ...(state.tombstones || {}) };
  let conflicts = [...(state.conflicts || [])];
  const now = Date.now();
  let pulled = 0;
  let pushed = 0;
  const folderLocalIdByStableId = new Map();

  if (bootstrapNeeded) {
    if (!remoteExists) {
      // nobody else is in the group yet - this device's current library becomes the seed
      for (const item of localSnapshot) {
        const parentRef = parentRefFor(item.parentTag, mergeIndex);
        mergeIndex[item.localId] = {
          stableId: crypto.randomUUID(),
          kind: item.kind,
          url: item.url,
          title: item.title,
          parentRef,
          localModified: now,
          lastSyncedModified: now
        };
        if (item.kind === 'folder') {
          folderLocalIdByStableId.set(mergeIndex[item.localId].stableId, item.localId);
        }
        if (item.kind === 'bookmark') {
          pushed++;
        }
      }
    } else {
      // joining an existing group - snapshot first, then reconcile
      try {
        const backup = await createBackupFile(token, { label: `Pre-Merge Backup - ${deviceLabel}` });
        await pruneBackupsIfNeeded(token);
        await appendSyncLog({ source: 'backup', ok: true, message: `Pre-Merge Backup created: ${backup.bookmarkCount} bookmarks` });
      } catch (backupErr) {
        await appendSyncLog({ source: 'backup', ok: false, message: `Pre-Merge Backup failed: ${backupErr.message}` });
      }

      // folders first, matched by full path (one-time only - never used again)
      const remoteFolderPathToId = new Map();
      for (const f of remoteData.folders) {
        remoteFolderPathToId.set(remoteFolderFullPath(f.stableId, remoteFoldersByStableId), f.stableId);
      }
      const matchedRemoteFolderIds = new Set();
      for (const item of localSnapshot) {
        if (item.kind !== 'folder') {
          continue;
        }
        const parentRef = parentRefFor(item.parentTag, mergeIndex);
        const matchedStableId = remoteFolderPathToId.get(folderFullPath(item));
        if (matchedStableId && !matchedRemoteFolderIds.has(matchedStableId)) {
          matchedRemoteFolderIds.add(matchedStableId);
          const def = remoteFoldersByStableId.get(matchedStableId);
          mergeIndex[item.localId] = {
            stableId: matchedStableId,
            kind: 'folder',
            title: item.title,
            parentRef,
            localModified: def.lastModified,
            lastSyncedModified: def.lastModified
          };
          folderLocalIdByStableId.set(matchedStableId, item.localId);
        } else {
          const stableId = crypto.randomUUID();
          mergeIndex[item.localId] = {
            stableId,
            kind: 'folder',
            title: item.title,
            parentRef,
            localModified: now,
            lastSyncedModified: 0
          };
          folderLocalIdByStableId.set(stableId, item.localId);
        }
      }
      // any remote folder nothing local matched still needs to exist
      // locally - but if the shared file has more than one entry for the
      // same path (a duplicate from earlier corruption), alias every
      // duplicate onto whichever local folder is already there instead of
      // creating a new folder per duplicate
      const handledFolderPaths = new Map();
      for (const [localId, entry] of Object.entries(mergeIndex)) {
        if (entry.kind === 'folder' && matchedRemoteFolderIds.has(entry.stableId)) {
          handledFolderPaths.set(remoteFolderFullPath(entry.stableId, remoteFoldersByStableId), localId);
        }
      }
      applyingRemoteChange = true;
      try {
        for (const f of remoteData.folders) {
          const path = remoteFolderFullPath(f.stableId, remoteFoldersByStableId);
          const existingLocalId = handledFolderPaths.get(path);
          if (existingLocalId) {
            folderLocalIdByStableId.set(f.stableId, existingLocalId);
            continue;
          }
          const localId = await resolveLocalFolderForRef(f.stableId, mergeIndex, remoteFoldersByStableId, folderLocalIdByStableId);
          handledFolderPaths.set(path, localId);
        }
      } finally {
        applyingRemoteChange = false;
      }

      // now bookmarks, matched by URL
      const remoteByUrl = new Map();
      for (const r of remoteData.bookmarks) {
        if (!remoteByUrl.has(r.url)) {
          remoteByUrl.set(r.url, []);
        }
        remoteByUrl.get(r.url).push(r);
      }
      const folderInfoByStableId = buildFolderInfoByStableId(mergeIndex, remoteFoldersByStableId);

      const matchedRemoteBookmarkIds = new Set();
      for (const item of localSnapshot) {
        if (item.kind !== 'bookmark') {
          continue;
        }
        const parentRef = parentRefFor(item.parentTag, mergeIndex);
        const candidates = (remoteByUrl.get(item.url) || []).filter((r) => !matchedRemoteBookmarkIds.has(r.stableId));
        if (candidates.length) {
          const remoteItem = candidates[0];
          matchedRemoteBookmarkIds.add(remoteItem.stableId);
          const sameEverything =
            remoteItem.title === item.title &&
            (remoteItem.parentRef === parentRef ||
              refDisplayPath(remoteItem.parentRef, folderInfoByStableId) === refDisplayPath(parentRef, folderInfoByStableId));
          if (sameEverything) {
            mergeIndex[item.localId] = {
              stableId: remoteItem.stableId,
              kind: 'bookmark',
              url: item.url,
              title: item.title,
              parentRef,
              localModified: remoteItem.lastModified,
              lastSyncedModified: remoteItem.lastModified
            };
          } else {
            const newStableId = crypto.randomUUID();
            mergeIndex[item.localId] = {
              stableId: newStableId,
              kind: 'bookmark',
              url: item.url,
              title: item.title,
              parentRef,
              localModified: now,
              lastSyncedModified: 0
            };
            if (!hasPendingConflict(conflicts, remoteItem.stableId)) {
              conflicts.push({
                id: crypto.randomUUID(),
                kind: 'bookmark',
                type: 'edit-edit',
                url: item.url,
                local: { stableId: newStableId, localId: item.localId, title: item.title, displayPath: refDisplayPath(parentRef, folderInfoByStableId) },
                remote: {
                  stableId: remoteItem.stableId,
                  title: remoteItem.title,
                  displayPath: refDisplayPath(remoteItem.parentRef, folderInfoByStableId),
                  deviceLabel: remoteItem.deviceLabel
                },
                detectedAt: now
              });
            }
          }
        } else {
          mergeIndex[item.localId] = {
            stableId: crypto.randomUUID(),
            kind: 'bookmark',
            url: item.url,
            title: item.title,
            parentRef,
            localModified: now,
            lastSyncedModified: 0
          };
          pushed++;
        }
      }

      // URLs already accounted for locally - either matched above, or about
      // to be pulled down below. If the shared file has more than one
      // entry for the same URL (which can happen after repeated resets),
      // only the first one is ever pulled down, so duplicates already
      // sitting in the shared file stop multiplying instead of each
      // becoming another local copy.
      const handledUrls = new Set(localSnapshot.filter((i) => i.kind === 'bookmark').map((i) => i.url));

      applyingRemoteChange = true;
      try {
        for (const r of remoteData.bookmarks) {
          if (matchedRemoteBookmarkIds.has(r.stableId) || handledUrls.has(r.url)) {
            continue;
          }
          handledUrls.add(r.url);
          const parentId = await resolveLocalFolderForRef(r.parentRef, mergeIndex, remoteFoldersByStableId, folderLocalIdByStableId);
          const created = await chrome.bookmarks.create({ parentId, title: r.title, url: r.url });
          mergeIndex[created.id] = {
            stableId: r.stableId,
            kind: 'bookmark',
            url: r.url,
            title: r.title,
            parentRef: r.parentRef,
            localModified: r.lastModified,
            lastSyncedModified: r.lastModified
          };
          pulled++;
        }
      } finally {
        applyingRemoteChange = false;
      }
    }

    await setState({ mergeBootstrapped: true, mergeIndex, tombstones, conflicts });
  } else {
    // ---- ongoing sync: diff local vs stored index, diff remote vs what we last applied ----

    const localByLocalId = new Map(localSnapshot.map((i) => [i.localId, i]));

    // 1) local creates/edits since the last walk - top-down order means a
    // parent's index entry always exists by the time a child needs it
    for (const item of localSnapshot) {
      const existing = mergeIndex[item.localId];
      const parentRef = parentRefFor(item.parentTag, mergeIndex);
      if (!existing) {
        mergeIndex[item.localId] = {
          stableId: crypto.randomUUID(),
          kind: item.kind,
          url: item.url,
          title: item.title,
          parentRef,
          localModified: now,
          lastSyncedModified: 0
        };
      } else {
        const changed = existing.title !== item.title || existing.parentRef !== parentRef || (item.kind === 'bookmark' && existing.url !== item.url);
        if (changed) {
          existing.title = item.title;
          existing.parentRef = parentRef;
          if (item.kind === 'bookmark') {
            existing.url = item.url;
          }
          existing.localModified = now;
        }
      }
      if (item.kind === 'folder') {
        folderLocalIdByStableId.set(mergeIndex[item.localId].stableId, item.localId);
      }
    }

    // 2) local deletions - an indexed item whose local id no longer exists
    for (const [localId, entry] of Object.entries(mergeIndex)) {
      if (!localByLocalId.has(localId)) {
        tombstones[entry.stableId] = { deletedAt: now, deviceLabel };
        delete mergeIndex[localId];
      }
    }

    const byStableId = new Map();
    for (const [localId, entry] of Object.entries(mergeIndex)) {
      byStableId.set(entry.stableId, { localId, entry });
    }
    const folderInfoByStableId = buildFolderInfoByStableId(mergeIndex, remoteFoldersByStableId);

    // maps a folder's rendered "Toolbar / Work" path to whichever local
    // folder entry currently claims it - used below to notice when a
    // remote folder reference is really the SAME folder under a
    // different stable id (the two diverged at some point, e.g. through
    // separate resets on different devices) rather than a genuinely new
    // folder, and heal it instead of creating a duplicate.
    const localFolderByPath = new Map();
    for (const [localId, entry] of Object.entries(mergeIndex)) {
      if (entry.kind === 'folder') {
        localFolderByPath.set(refDisplayPath(entry.stableId, folderInfoByStableId), { localId, entry });
      }
    }
    // stableIds this pass determines were never really in conflict -
    // clears out any stale conflict entries already sitting in state from
    // before this fix existed, not just prevents new ones
    const resolvedIdenticalStableIds = new Set();

    // 3) reconcile against remote - folders first, so any folder a
    // bookmark needs to move into already exists by the time bookmarks run
    applyingRemoteChange = true;
    try {
      for (const remoteList of [remoteData.folders, remoteData.bookmarks]) {
        const isFolder = remoteList === remoteData.folders;
        for (const r of remoteList) {
          let found = byStableId.get(r.stableId);
          const myTombstone = tombstones[r.stableId];

          if (isFolder && !found && !myTombstone) {
            const remotePath = refDisplayPath(r.stableId, folderInfoByStableId);
            const existingByPath = localFolderByPath.get(remotePath);
            if (existingByPath) {
              // same real folder, different id - converge both devices onto
              // whichever id sorts first, deterministically, so every
              // device reaches the same answer independently without
              // needing to coordinate. Bookmarks inside pick up the
              // corrected reference automatically on the next local walk,
              // since they look their parent folder's stableId up fresh
              // each sync rather than caching it.
              const winner = existingByPath.entry.stableId < r.stableId ? existingByPath.entry.stableId : r.stableId;
              if (existingByPath.entry.stableId !== winner) {
                existingByPath.entry.stableId = winner;
                existingByPath.entry.lastSyncedModified = Math.max(existingByPath.entry.lastSyncedModified, r.lastModified);
              }
              byStableId.set(winner, existingByPath);
              byStableId.set(r.stableId, existingByPath);
              folderLocalIdByStableId.set(winner, existingByPath.localId);
              folderLocalIdByStableId.set(r.stableId, existingByPath.localId);
              localFolderByPath.set(remotePath, existingByPath);
              found = existingByPath;
            }
          }

          if (myTombstone) {
            if (r.lastModified > myTombstone.deletedAt && !hasPendingConflict(conflicts, r.stableId)) {
              conflicts.push({
                id: crypto.randomUUID(),
                kind: isFolder ? 'folder' : 'bookmark',
                type: 'edit-delete',
                url: isFolder ? undefined : r.url,
                local: { stableId: r.stableId, deletedAt: myTombstone.deletedAt },
                remote: {
                  stableId: r.stableId,
                  title: r.title,
                  displayPath: refDisplayPath(r.parentRef, folderInfoByStableId),
                  deviceLabel: r.deviceLabel
                },
                detectedAt: now
              });
            }
            continue;
          }

          if (!found) {
            const parentId = await resolveLocalFolderForRef(r.parentRef, mergeIndex, remoteFoldersByStableId, folderLocalIdByStableId);
            const created = isFolder
              ? await chrome.bookmarks.create({ parentId, title: r.title })
              : await chrome.bookmarks.create({ parentId, title: r.title, url: r.url });
            mergeIndex[created.id] = {
              stableId: r.stableId,
              kind: isFolder ? 'folder' : 'bookmark',
              url: isFolder ? undefined : r.url,
              title: r.title,
              parentRef: r.parentRef,
              localModified: r.lastModified,
              lastSyncedModified: r.lastModified
            };
            if (isFolder) {
              folderLocalIdByStableId.set(r.stableId, created.id);
            }
            if (!isFolder) {
              pulled++;
            }
            continue;
          }

          const { localId, entry } = found;
          const remoteChangedSinceSync = r.lastModified > entry.lastSyncedModified;
          const localChangedSinceSync = entry.localModified > entry.lastSyncedModified;
          const parentMatches =
            entry.parentRef === r.parentRef ||
            refDisplayPath(entry.parentRef, folderInfoByStableId) === refDisplayPath(r.parentRef, folderInfoByStableId);
          const contentIdentical = entry.title === r.title && parentMatches && (isFolder || entry.url === r.url);

          if (contentIdentical) {
            // both sides show a change since we last agreed, but the actual
            // data is the same - nothing to resolve, just bring the
            // bookkeeping back in line rather than bothering anyone with a
            // conflict over nothing
            entry.lastSyncedModified = Math.max(entry.lastSyncedModified, r.lastModified, entry.localModified);
            resolvedIdenticalStableIds.add(entry.stableId);
            resolvedIdenticalStableIds.add(r.stableId);
          } else if (remoteChangedSinceSync && localChangedSinceSync) {
            if (!hasPendingConflict(conflicts, r.stableId)) {
              conflicts.push({
                id: crypto.randomUUID(),
                kind: isFolder ? 'folder' : 'bookmark',
                type: 'edit-edit',
                url: isFolder ? undefined : r.url,
                local: { stableId: r.stableId, localId, title: entry.title, displayPath: refDisplayPath(entry.parentRef, folderInfoByStableId) },
                remote: {
                  stableId: r.stableId,
                  title: r.title,
                  displayPath: refDisplayPath(r.parentRef, folderInfoByStableId),
                  deviceLabel: r.deviceLabel
                },
                detectedAt: now
              });
            }
          } else if (remoteChangedSinceSync) {
            if (await isProtectedLocalId(localId)) {
              warnProtectedId('ongoing sync remote update', localId, { stableId: r.stableId, title: r.title });
            } else {
              // updating in place - the point of stable folder ids: this
              // renames/moves the SAME local folder rather than creating a new one
              if (entry.title !== r.title || (!isFolder && entry.url !== r.url)) {
                await chrome.bookmarks.update(localId, isFolder ? { title: r.title } : { title: r.title, url: r.url });
              }
              if (entry.parentRef !== r.parentRef) {
                const parentId = await resolveLocalFolderForRef(r.parentRef, mergeIndex, remoteFoldersByStableId, folderLocalIdByStableId);
                await chrome.bookmarks.move(localId, { parentId });
              }
            }
            entry.title = r.title;
            entry.parentRef = r.parentRef;
            if (!isFolder) {
              entry.url = r.url;
            }
            entry.localModified = r.lastModified;
            entry.lastSyncedModified = r.lastModified;
            if (isFolder) {
              folderLocalIdByStableId.set(r.stableId, localId);
            }
            if (!isFolder) {
              pulled++;
            }
          }
          // else: only local changed (or nothing changed) - handled by the push below
        }
      }
    } finally {
      applyingRemoteChange = false;
    }

    if (resolvedIdenticalStableIds.size) {
      conflicts = conflicts.filter(
        (c) => !resolvedIdenticalStableIds.has(c.local?.stableId) && !resolvedIdenticalStableIds.has(c.remote?.stableId)
      );
    }

    // remote tombstones for things I still have locally and haven't touched
    for (const rt of remoteData.tombstones || []) {
      const found = byStableId.get(rt.stableId);
      if (!found) {
        continue;
      }
      const { localId, entry } = found;
      if (entry.localModified > entry.lastSyncedModified) {
        if (!hasPendingConflict(conflicts, entry.stableId)) {
          conflicts.push({
            id: crypto.randomUUID(),
            kind: entry.kind,
            type: 'edit-delete',
            url: entry.kind === 'bookmark' ? entry.url : undefined,
            local: { stableId: entry.stableId, localId, title: entry.title, displayPath: refDisplayPath(entry.parentRef, folderInfoByStableId) },
            remote: { stableId: entry.stableId, deletedAt: rt.deletedAt, deviceLabel: rt.deviceLabel },
            detectedAt: now
          });
        }
      } else {
        if (await isProtectedLocalId(localId)) {
          warnProtectedId('tombstone removal', localId, { stableId: entry.stableId, title: entry.title });
        } else {
          applyingRemoteChange = true;
          try {
            await chrome.bookmarks.remove(localId);
          } finally {
            applyingRemoteChange = false;
          }
        }
        delete mergeIndex[localId];
        if (entry.kind === 'bookmark') {
          pulled++;
        }
      }
    }

    const conflictedStableIds = new Set(conflicts.map((c) => c.local?.stableId || c.remote?.stableId));
    for (const entry of Object.values(mergeIndex)) {
      if (!conflictedStableIds.has(entry.stableId) && entry.localModified > entry.lastSyncedModified) {
        entry.lastSyncedModified = entry.localModified;
        if (entry.kind === 'bookmark') {
          pushed++;
        }
      }
    }
  }

  tombstones = pruneOldTombstones(tombstones);

  const conflictedStableIdsFinal = new Set(
    conflicts.filter((c) => c.type === 'edit-edit').map((c) => c.local?.stableId || c.remote?.stableId)
  );
  const payload = {
    folders: Object.values(mergeIndex)
      .filter((e) => e.kind === 'folder' && !conflictedStableIdsFinal.has(e.stableId))
      .map((e) => ({ stableId: e.stableId, title: e.title, parentRef: e.parentRef, lastModified: e.lastSyncedModified, deviceLabel })),
    bookmarks: Object.values(mergeIndex)
      .filter((e) => e.kind === 'bookmark' && !conflictedStableIdsFinal.has(e.stableId))
      .map((e) => ({ stableId: e.stableId, url: e.url, title: e.title, parentRef: e.parentRef, lastModified: e.lastSyncedModified, deviceLabel })),
    tombstones: Object.entries(tombstones).map(([stableId, t]) => ({ stableId, deletedAt: t.deletedAt, deviceLabel: t.deviceLabel }))
  };
  mergeFileId = await uploadMergeFile(token, folderId, mergeFileId, payload);

  await setState({ mergeFileId, mergeIndex, tombstones, conflicts });

  const total = Object.values(mergeIndex).filter((e) => e.kind === 'bookmark').length;
  return { pulled, pushed, total, conflictCount: conflicts.length };
}

// Applies one resolution to one conflict, mutating mergeIndex/tombstones
// in place. Shared by both the single-conflict resolver and the bulk
// resolver below, so "resolve one" and "resolve all of these" always
// behave identically. Returns an error string if this specific item
// couldn't be resolved safely (never touches bookmark-mutation calls
// without the protected-id guard), or null on success.
async function applyConflictResolution(conflict, resolution, mergeIndex, tombstones, deviceLabel) {
  const now = Date.now();
  const isFolder = conflict.kind === 'folder';

  if (conflict.type === 'edit-edit') {
    const localId = conflict.local.localId;
    if (resolution === 'remote') {
      if (await isProtectedLocalId(localId)) {
        warnProtectedId('resolveConflict edit-edit remote', localId, conflict);
        return "That item can't be safely resolved automatically - please check it manually in your bookmarks.";
      }
      await chrome.bookmarks.update(localId, isFolder ? { title: conflict.remote.title } : { title: conflict.remote.title, url: conflict.url });
      mergeIndex[localId] = {
        ...(mergeIndex[localId] || {}),
        stableId: conflict.remote.stableId,
        kind: conflict.kind,
        url: isFolder ? undefined : conflict.url,
        title: conflict.remote.title,
        localModified: now,
        lastSyncedModified: now
      };
    } else if (resolution === 'both') {
      const localNode = await chrome.bookmarks.get(localId).catch(() => null);
      const parentLocalId = localNode && localNode[0] ? localNode[0].parentId : null;
      const created = isFolder
        ? await chrome.bookmarks.create({ parentId: parentLocalId, title: conflict.remote.title })
        : await chrome.bookmarks.create({ parentId: parentLocalId, title: conflict.remote.title, url: conflict.url });
      mergeIndex[created.id] = {
        stableId: conflict.remote.stableId,
        kind: conflict.kind,
        url: isFolder ? undefined : conflict.url,
        title: conflict.remote.title,
        parentRef: mergeIndex[localId] ? mergeIndex[localId].parentRef : null,
        localModified: now,
        lastSyncedModified: now
      };
      if (mergeIndex[localId]) {
        mergeIndex[localId].lastSyncedModified = now;
      }
    } else {
      if (mergeIndex[localId]) {
        mergeIndex[localId].lastSyncedModified = now;
      }
    }
  } else if (conflict.type === 'edit-delete') {
    if (resolution === 'delete') {
      if (conflict.local && conflict.local.localId) {
        if (await isProtectedLocalId(conflict.local.localId)) {
          warnProtectedId('resolveConflict edit-delete', conflict.local.localId, conflict);
          return "That item can't be safely resolved automatically - please check it manually in your bookmarks.";
        }
        await chrome.bookmarks.remove(conflict.local.localId);
        delete mergeIndex[conflict.local.localId];
      }
      tombstones[conflict.remote?.stableId || conflict.local?.stableId] = { deletedAt: now, deviceLabel };
    } else {
      const stableId = conflict.remote?.stableId || conflict.local?.stableId;
      delete tombstones[stableId];
      if (conflict.local && conflict.local.localId && mergeIndex[conflict.local.localId]) {
        mergeIndex[conflict.local.localId].lastSyncedModified = now;
      } else if (conflict.remote) {
        const roots = await chrome.bookmarks.getTree();
        const parentNode = roots[0].children.find((n) => !n.url) || roots[0].children[0];
        const parentRole = detectFolderRole(parentNode);
        const created = isFolder
          ? await chrome.bookmarks.create({ parentId: parentNode.id, title: conflict.remote.title })
          : await chrome.bookmarks.create({ parentId: parentNode.id, title: conflict.remote.title, url: conflict.url });
        mergeIndex[created.id] = {
          stableId,
          kind: conflict.kind,
          url: isFolder ? undefined : conflict.url,
          title: conflict.remote.title,
          parentRef: parentRole ? `#${parentRole}` : null,
          localModified: now,
          lastSyncedModified: now
        };
      }
    }
  }
  return null;
}

// called from the popup when someone resolves an item in the Conflicts tab
async function resolveConflict(conflictId, resolution) {
  const state = await getState();
  const conflict = (state.conflicts || []).find((c) => c.id === conflictId);
  if (!conflict) {
    return { ok: false, error: 'That conflict is no longer pending' };
  }

  const mergeIndex = { ...state.mergeIndex };
  const tombstones = { ...state.tombstones };
  const deviceLabel = await getOrCreateDeviceLabel();

  let error = null;
  applyingRemoteChange = true;
  try {
    error = await applyConflictResolution(conflict, resolution, mergeIndex, tombstones, deviceLabel);
  } finally {
    applyingRemoteChange = false;
  }
  if (error) {
    return { ok: false, error };
  }

  // clears the resolved conflict AND any older duplicates for the same
  // underlying item - repeated syncs before this fix could have stacked
  // more than one entry for the same divergence, and resolving it once
  // should settle all of them, not just whichever copy was clicked
  const resolvedStableId = conflict.local?.stableId || conflict.remote?.stableId;
  const conflicts = (state.conflicts || []).filter((c) => {
    const cStableId = c.local?.stableId || c.remote?.stableId;
    return c.id !== conflictId && cStableId !== resolvedStableId;
  });
  await setState({ mergeIndex, tombstones, conflicts });
  await refreshBadge();
  return { ok: true };
}

// resolves every currently-pending conflict of a given type the same way
// in one pass - the popup's "for all" buttons in the Conflicts tab. Scope
// is always a single conflict type (edit-edit or edit-delete), since
// they don't share meaningful resolution options (there's no "both" for
// a deletion, for instance) - the popup only ever calls this once per
// button, one type at a time.
async function resolveAllConflicts(conflictType, resolution) {
  const state = await getState();
  const targets = (state.conflicts || []).filter((c) => c.type === conflictType);
  if (!targets.length) {
    return { ok: true, count: 0 };
  }

  const mergeIndex = { ...state.mergeIndex };
  const tombstones = { ...state.tombstones };
  const deviceLabel = await getOrCreateDeviceLabel();
  let resolvedCount = 0;
  let lastError = null;

  applyingRemoteChange = true;
  try {
    for (const conflict of targets) {
      const error = await applyConflictResolution(conflict, resolution, mergeIndex, tombstones, deviceLabel);
      if (error) {
        lastError = error; // keep going - one unresolvable item shouldn't block the rest
      } else {
        resolvedCount++;
      }
    }
  } finally {
    applyingRemoteChange = false;
  }

  const resolvedStableIds = new Set();
  for (const c of targets) {
    resolvedStableIds.add(c.local?.stableId || c.remote?.stableId);
  }
  const conflicts = (state.conflicts || []).filter((c) => {
    const cStableId = c.local?.stableId || c.remote?.stableId;
    return !resolvedStableIds.has(cStableId);
  });
  await setState({ mergeIndex, tombstones, conflicts });
  await refreshBadge();
  await appendSyncLog({
    source: 'merge',
    ok: true,
    message: `Bulk-resolved ${resolvedCount} conflict${resolvedCount === 1 ? '' : 's'} (${resolution})`
  });

  return { ok: true, count: resolvedCount, error: lastError };
}

// ---------- sync orchestration ----------

async function updateStatus(patch) {
  await setState(patch);
  const state = await getState();
  await applyBadge(state);
  chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {
    // popup probably isn't open, that's fine
  });
}

// short scrollable history for the popup's Activity tab. Only meaningful
// events go in here (an actual push/pull, a backup, a restore, or an
// error) - routine "nothing changed, skip it" checks are left out on
// purpose so a realtime interval doesn't flood it.
async function appendSyncLog(entry) {
  const state = await getState();
  const next = [{ time: Date.now(), ...entry }, ...(state.syncLog || [])].slice(0, SYNC_LOG_LIMIT);
  await setState({ syncLog: next });
}

async function performSync(reason) {
  if (!(await acquireSyncLock())) {
    return;
  }
  const state = await getState();

  // only a user directly clicking "Sync now" (or Connect, which goes
  // through authorizeWithGoogle() separately) is allowed to pop an
  // interactive sign-in window. Anything background-triggered - the alarm
  // or a bookmark change - only ever tries a silent token refresh, and
  // fails quietly if that doesn't work, instead of surprising someone
  // with a Google sign-in tab they never asked for.
  const allowInteractive = reason === 'manual';

  try {
    await updateStatus({ status: 'syncing' });

    let token;
    try {
      token = await getValidToken(allowInteractive);
    } catch (authError) {
      await updateStatus({
        status: 'error',
        lastSyncMessage: 'Google sign-in expired - open the popup and click Sync now to reconnect'
      });
      await appendSyncLog({ source: state.role, ok: false, message: 'Google sign-in expired' });
      return;
    }

    const folderId = state.folderId || (await getOrCreateFolder(token));

    if (state.role === 'master') {
      // the dirty flag is set directly by chrome.bookmarks events - that's
      // the browser itself telling us something changed, which is a more
      // trustworthy signal than re-reading and diffing the whole tree on
      // every check. nothing dirty means nothing to do, no Drive call at all.
      if (reason !== 'manual' && !state.dirty) {
        await updateStatus({ status: 'idle', lastSyncMessage: 'Already up to date', lastSyncTime: Date.now() });
        return;
      }

      const tree = await getSerializedTree();
      const total = countUrls(tree);
      const jsonString = JSON.stringify(tree);
      const fileId = await getLiveFileId(token, state.fileId, folderId);
      const newFileId = await uploadBookmarksJson(token, folderId, fileId, jsonString);
      await updateStatus({
        status: 'idle',
        fileId: newFileId,
        dirty: false,
        lastSyncMessage: 'Synced to cloud complete',
        lastSyncTime: Date.now(),
        lastStats: { synced: total, total }
      });
      await appendSyncLog({ source: 'master', ok: true, message: 'Synced to cloud', synced: total, total });
    } else if (state.role === 'destination') {
      const fileId = await getLiveFileId(token, state.fileId, folderId);
      if (!fileId) {
        await updateStatus({
          status: 'error',
          lastSyncMessage: 'No bookmarks found in the cloud yet - sync the master browser first'
        });
        await appendSyncLog({
          source: 'destination',
          ok: false,
          message: 'No bookmarks found in the cloud yet'
        });
        return;
      }

      // metadata-only request is cheap - use it to see whether the file
      // actually moved before paying for a full download + bookmark rebuild
      const metaRes = await driveFetch(token, `/drive/v3/files/${fileId}?fields=modifiedTime`);
      const meta = await metaRes.json();

      if (reason !== 'manual' && meta.modifiedTime === state.lastRemoteModifiedTime) {
        await updateStatus({ status: 'idle', fileId, lastSyncMessage: 'Already up to date', lastSyncTime: Date.now() });
        return;
      }

      const jsonString = await downloadBookmarksJson(token, fileId);
      const tree = JSON.parse(jsonString);
      const result = await restoreSerializedTree(tree);

      if (state.mergeBootstrapped) {
        // every local bookmark/folder id the merge index was tracking is
        // gone now that the tree's been replaced wholesale - if this
        // device is ever switched to Merge again, it needs to rejoin
        // fresh rather than operate on ids that no longer exist. Harmless
        // to reset even if it's never switched back.
        await setState({ mergeBootstrapped: false, mergeIndex: {} });
      }

      await updateStatus({
        status: 'idle',
        fileId,
        lastRemoteModifiedTime: meta.modifiedTime,
        lastSyncMessage: 'Synced from cloud complete',
        lastSyncTime: Date.now(),
        lastStats: result
      });
      await appendSyncLog({
        source: 'destination',
        ok: true,
        message: 'Synced from cloud',
        synced: result.synced,
        total: result.total
      });
    } else if (state.role === 'merge') {
      // merge always runs its own diff even on 'alarm'/'bookmarkChange' -
      // unlike master's dirty flag, there's no cheap single boolean that
      // covers "did anything change on either side," so every trigger does
      // a real (but bounded - one tree walk, one small JSON download) check.
      const result = await runMergeSync(token, folderId, state);
      const message =
        result.conflictCount > 0
          ? `Synced (${result.conflictCount} conflict${result.conflictCount === 1 ? '' : 's'} need attention)`
          : 'Synced';
      await updateStatus({
        status: 'idle',
        lastSyncMessage: message,
        lastSyncTime: Date.now(),
        lastStats: { synced: result.pushed + result.pulled, total: result.total }
      });
      await appendSyncLog({
        source: 'merge',
        ok: true,
        message: `Merged (${result.pulled} pulled, ${result.pushed} pushed)`,
        synced: result.pushed + result.pulled,
        total: result.total
      });
    }
  } catch (err) {
    await updateStatus({ status: 'error', lastSyncMessage: `Sync failed: ${err.message}` });
    await appendSyncLog({ source: state.role, ok: false, message: err.message });
  } finally {
    await releaseSyncLock();
  }
}

// ---------- scheduling ----------

async function applyAlarmSchedule() {
  await chrome.alarms.clear('scheduledSync');
  const state = await getState();
  if (!state.setupComplete || state.syncInterval === 'manual') {
    return;
  }
  const minutes = state.syncInterval === 'realtime' ? REALTIME_POLL_MINUTES : parseInt(state.syncInterval, 10);
  chrome.alarms.create('scheduledSync', { periodInMinutes: minutes });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'scheduledSync') {
    performSync('alarm');
  }
});

// bookmark change listeners mark the dirty flag directly - that's the
// authoritative "something changed" signal for the master browser. on
// realtime, also kick off a short debounced sync so it actually goes out
// in the next few seconds instead of waiting for the next scheduled check.
function scheduleDebouncedSync() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => performSync('bookmarkChange'), 3000);
}

async function handleBookmarkEvent() {
  // this device's own merge/restore code makes bookmarks.* calls too -
  // skip those so applying an incoming change doesn't get mistaken for a
  // fresh local edit and echoed straight back up (the realtime loop).
  if (applyingRemoteChange) {
    return;
  }
  if (await isSyncLocked()) {
    return;
  }
  const state = await getState();
  if (!state.setupComplete || (state.role !== 'master' && state.role !== 'merge')) {
    return;
  }
  if (state.role === 'master') {
    await setState({ dirty: true });
  }
  if (state.syncInterval === 'realtime') {
    scheduleDebouncedSync();
  }
}

chrome.bookmarks.onCreated.addListener(handleBookmarkEvent);
chrome.bookmarks.onRemoved.addListener(handleBookmarkEvent);
chrome.bookmarks.onChanged.addListener(handleBookmarkEvent);
chrome.bookmarks.onMoved.addListener(handleBookmarkEvent);

chrome.runtime.onInstalled.addListener(() => {
  applyAlarmSchedule();
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  applyAlarmSchedule();
  refreshBadge();
});

// ---------- messages from the popup ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'getState': {
        sendResponse(await getState());
        break;
      }
      case 'connectGoogle': {
        try {
          await authorizeWithGoogle();
          const token = await getValidToken(true);
          await getOrCreateFolder(token);
          await createInitialBackupIfNeeded(token);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'setRole': {
        const patch = { role: message.role, setupComplete: true };
        if (message.role === 'master') {
          patch.dirty = true; // make sure the very first sync actually goes out
        }
        await setState(patch);
        await applyAlarmSchedule();
        await refreshBadge();
        sendResponse({ ok: true });
        break;
      }
      case 'setInterval': {
        await setState({ syncInterval: message.interval });
        await applyAlarmSchedule();
        sendResponse({ ok: true });
        break;
      }
      case 'manualSync': {
        await performSync('manual');
        sendResponse({ ok: true });
        break;
      }
      case 'resetSetup': {
        await chrome.storage.local.clear();
        await setState(DEFAULT_STATE);
        await chrome.alarms.clear('scheduledSync');
        await refreshBadge();
        sendResponse({ ok: true });
        break;
      }
      case 'setBackupLimit': {
        const limit = Math.max(1, parseInt(message.limit, 10) || DEFAULT_BACKUP_LIMIT);
        await setState({ backupLimit: limit, backupLimitUnlimited: Boolean(message.unlimited) });
        sendResponse({ ok: true });
        break;
      }
      case 'listBackups': {
        try {
          const token = await getValidToken(true);
          const backups = await listBackupFiles(token);
          sendResponse({ ok: true, backups });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'createBackup': {
        if (!(await acquireSyncLock())) {
          sendResponse({ ok: false, error: 'A sync is currently in progress - try again in a moment' });
          break;
        }
        try {
          const token = await getValidToken(true);
          const deviceLabel = await getOrCreateDeviceLabel();
          const backup = await createBackupFile(token, { label: `Backup - ${deviceLabel}` });
          await pruneBackupsIfNeeded(token);
          await appendSyncLog({ source: 'backup', ok: true, message: `Backup created: ${backup.bookmarkCount} bookmarks` });
          sendResponse({ ok: true, backup });
        } catch (err) {
          await appendSyncLog({ source: 'backup', ok: false, message: err.message });
          sendResponse({ ok: false, error: err.message });
        } finally {
          await releaseSyncLock();
        }
        break;
      }
      case 'restoreBackup': {
        if (await isSyncLocked()) {
          sendResponse({ ok: false, error: 'A sync is currently in progress - try again in a moment' });
          break;
        }
        const currentState = await getState();
        if (currentState.role !== 'master' && currentState.role !== 'merge') {
          sendResponse({ ok: false, error: 'Restoring a backup is only available on Master Sync Source or Merge (Two-Way) - Destination Sync just mirrors whatever the group already has' });
          break;
        }
        if (!(await acquireSyncLock())) {
          sendResponse({ ok: false, error: 'A sync is currently in progress - try again in a moment' });
          break;
        }
        try {
          const token = await getValidToken(true);
          const result = await restoreBackupFile(token, message.fileId);
          await appendSyncLog({
            source: 'restore',
            ok: true,
            message: 'Backup restored',
            synced: result.synced,
            total: result.total
          });
          sendResponse({ ok: true, result });
        } catch (err) {
          await appendSyncLog({ source: 'restore', ok: false, message: err.message });
          sendResponse({ ok: false, error: err.message });
        } finally {
          await releaseSyncLock();
        }
        break;
      }
      case 'deleteBackup': {
        try {
          const token = await getValidToken(true);
          await deleteBackupFile(token, message.fileId);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'resetMergeTracking': {
        if (!(await acquireSyncLock())) {
          sendResponse({ ok: false, error: 'A sync is currently in progress - try again in a moment' });
          break;
        }
        try {
          const currentState = await getState();
          if (currentState.role !== 'merge') {
            sendResponse({ ok: false, error: 'This is only available on Merge (Two-Way) devices' });
            break;
          }
          // clears this device's local tracking only - no bookmarks are
          // touched here, and nothing gets deleted. The next sync re-runs
          // the same join reconciliation a brand new device goes through
          // (Pre-Merge Backup, then matching against what's already there).
          await setState({ mergeBootstrapped: false, mergeIndex: {} });
          await appendSyncLog({
            source: 'merge',
            ok: true,
            message: 'Merge tracking reset - will re-join the group on the next sync'
          });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        } finally {
          await releaseSyncLock();
        }
        break;
      }
      case 'resolveConflict': {
        if (!(await acquireSyncLock())) {
          sendResponse({ ok: false, error: 'A sync is currently in progress - try again in a moment' });
          break;
        }
        try {
          const result = await resolveConflict(message.conflictId, message.resolution);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        } finally {
          await releaseSyncLock();
        }
        break;
      }
      case 'resolveAllConflicts': {
        if (!(await acquireSyncLock())) {
          sendResponse({ ok: false, error: 'A sync is currently in progress - try again in a moment' });
          break;
        }
        try {
          const result = await resolveAllConflicts(message.conflictType, message.resolution);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        } finally {
          await releaseSyncLock();
        }
        break;
      }
      case 'setDeviceLabel': {
        const label = (message.label || '').trim();
        if (label) {
          await setState({ deviceLabel: label });
        } else {
          await setState({ deviceLabel: '' });
          await getOrCreateDeviceLabel(); // regenerates and stores a platform-based default
        }
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true; // keep the message channel open for the async response
});

refreshBadge();
