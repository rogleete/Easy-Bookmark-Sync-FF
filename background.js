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
  backupsFolderId: null
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

async function createBackupFile(token) {
  const backupsFolderId = await getOrCreateBackupsFolder(token);
  const tree = await getSerializedTree();
  const total = countUrls(tree);
  const jsonString = JSON.stringify(tree);

  const now = new Date();
  const stamp = now.toISOString().replace(/:/g, '-').split('.')[0];
  const name = `Backup ${stamp} (${total} bookmarks).json`;

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

  // if this is the master browser, the local tree just changed underneath
  // the live sync file - flag it dirty so the restored state gets pushed
  // back up to the cloud on the next sync instead of getting overwritten
  const state = await getState();
  if (state.role === 'master') {
    await setState({ dirty: true });
  }

  return result;
}

async function deleteBackupFile(token, fileId) {
  await driveFetch(token, `/drive/v3/files/${fileId}`, { method: 'DELETE' });
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

// ---------- sync orchestration ----------

async function updateStatus(patch) {
  await setState(patch);
  chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {
    // popup probably isn't open, that's fine
  });
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
      const fileId = state.fileId || (await findFile(token, folderId));
      const newFileId = await uploadBookmarksJson(token, folderId, fileId, jsonString);
      await updateStatus({
        status: 'idle',
        fileId: newFileId,
        dirty: false,
        lastSyncMessage: 'Synced to cloud complete',
        lastSyncTime: Date.now(),
        lastStats: { synced: total, total }
      });
    } else if (state.role === 'destination') {
      const fileId = state.fileId || (await findFile(token, folderId));
      if (!fileId) {
        await updateStatus({
          status: 'error',
          lastSyncMessage: 'No bookmarks found in the cloud yet - sync the master browser first'
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
      await updateStatus({
        status: 'idle',
        fileId,
        lastRemoteModifiedTime: meta.modifiedTime,
        lastSyncMessage: 'Synced from cloud complete',
        lastSyncTime: Date.now(),
        lastStats: result
      });
    }
  } catch (err) {
    await updateStatus({ status: 'error', lastSyncMessage: `Sync failed: ${err.message}` });
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
  if (await isSyncLocked()) {
    return;
  }
  const state = await getState();
  if (!state.setupComplete || state.role !== 'master') {
    return;
  }
  await setState({ dirty: true });
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
});

chrome.runtime.onStartup.addListener(() => {
  applyAlarmSchedule();
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
          await getOrCreateFolder(await getValidToken(true));
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
          const backup = await createBackupFile(token);
          sendResponse({ ok: true, backup });
        } catch (err) {
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
        if (currentState.role !== 'master') {
          sendResponse({ ok: false, error: 'Restoring a backup is only available on the Master Sync Source browser' });
          break;
        }
        if (!(await acquireSyncLock())) {
          sendResponse({ ok: false, error: 'A sync is currently in progress - try again in a moment' });
          break;
        }
        try {
          const token = await getValidToken(true);
          const result = await restoreBackupFile(token, message.fileId);
          sendResponse({ ok: true, result });
        } catch (err) {
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
      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true; // keep the message channel open for the async response
});
