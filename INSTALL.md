# Easy Bookmark Sync - Setup Guide

This extension talks directly to your own Google Drive, there's no server in
the middle. That means before it can work, you need a (free) Google Cloud
OAuth Client ID. About ten minutes, one time only, and no code editing -
everything gets pasted into the extension's Options page once it's loaded.

(Once the extension is loaded, this same guide is also available in-app:
right click the toolbar icon → Options → "View full setup instructions".)

## Part 1: Google Cloud project

1. Go to https://console.cloud.google.com/ and sign in with the Google
   account you want to sync bookmarks through.
2. Create a new project (top left project dropdown → New Project). Name it
   whatever you like, e.g. "Bookmark Sync".
3. Search the top bar for **Google Drive API** and click **Enable**.<br><br>

   <img width="950" height="203" alt="install1-newproject" src="https://github.com/user-attachments/assets/d2f9bc23-407a-4f56-abe8-753f7ad16955" /><br>
   <img width="640" height="510" alt="setup2-NewProject" src="https://github.com/user-attachments/assets/cf424cad-c894-4894-9a76-b8e9daef5641" /><br>
   <img width="455" height="55" alt="install3-selectproject" src="https://github.com/user-attachments/assets/a26aee56-e729-461c-9249-e67cd8bb3143" /><br>
   <img width="598" height="164" alt="install4-driveapi" src="https://github.com/user-attachments/assets/36c7a462-453e-4f39-b2cd-97db00b99ad1" /><br>
   <img width="528" height="235" alt="install4-driveapienable" src="https://github.com/user-attachments/assets/68acb464-b3be-4f6c-9ada-ac9c5b25c77d" /><br>


## Part 2: OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.<br><br>
<img width="318" height="305" alt="install6-oauthconsent" src="https://github.com/user-attachments/assets/c60c3d2b-d70a-4dc8-b8b7-17304d9b8d4d" /><br>

   
2. User type: **External** (Internal is fine too if you have a Workspace
   account).
3. Fill in an app name and your email for the support/developer contact
   fields. Everything else can stay blank.<br><br>
   <img width="667" height="711" alt="install7-appinfo" src="https://github.com/user-attachments/assets/bbab2554-1297-4157-bdd1-1722014ee144" /><br>
   <img width="641" height="495" alt="install8-audience" src="https://github.com/user-attachments/assets/3cb5a150-40c1-48db-9e51-f2f8b800bcc6" /><br>
   <img width="639" height="219" alt="install9-contact" src="https://github.com/user-attachments/assets/2ebb8369-c40c-45ec-8805-87b19becbf26" /><br>
5. Scopes step: nothing to add manually.
6. Test users step: add the Google account email you'll actually use with
   the extension. While the app is in "Testing" mode, only accounts on this
   list can sign in - normal for a personal tool.<br><br>
   <img width="638" height="275" alt="install12-testusers" src="https://github.com/user-attachments/assets/cde73a31-d30d-4a29-9899-6be27a44e7dd" /><br>


## Part 3: OAuth Client ID

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth
   client ID**.<br><br>
   <img width="308" height="409" alt="install13-clients" src="https://github.com/user-attachments/assets/c7b91294-e3f5-4257-ab0e-64931def25d8" /><br>

2. Application type: **Web application** (not "Chrome Extension" - that
   older client type isn't needed).<br><br>
   
3. Under **Authorized redirect URIs**, add all three of these exact URIs
   (one per line) - they're fixed permanently now, tied to the published
   listings, so this step won't need revisiting later:<br><br>
   `https://ohgafdieafmgfcahebkcbnpbnjopglfp.chromiumapp.org/` (Chrome Web Store)<br>
   `https://iplgoihgbngdhmcbacjakppljbeepchk.chromiumapp.org/` (Edge Add-ons)<br>
   `https://1dbba077862f3a0e4781d873ee0b7bdc66670fb4.extensions.allizom.org/` (Firefox)<br><br>
   Add all three now even if you're only using one browser today - it
   saves coming back to add the others later. (If you're loading the
   extension unpacked in Developer mode instead of installing it from a
   store, its ID - and redirect URI - will be different; the extension's
   Options page always shows the exact one to use for whatever copy
   you're running.)
4. One Client ID can hold multiple redirect URIs, so all three of the
   above (plus any unpacked dev ID) can live on this same OAuth client -
   no need for separate Client IDs per browser.
5. Save, then copy both the Client ID (ends in `.apps.googleusercontent.com`)
   and the Client Secret (starts with `GOCSPX-`) Google generated
   alongside it - both get pasted into the extension's Options page. Save both these keys in a password manager or someplace you can reference them easily for future installs and setting up on other computers/browsers.<br><br>
<img width="605" height="810" alt="setup-oauth" src="https://github.com/user-attachments/assets/3163db62-3c6a-4bcb-8be3-abeaf64c3c77" />
<br>

## Part 4: Install the extension

Most people should just install this from the store for their browser -
Chrome Web Store, Edge Add-ons, or Firefox Add-ons - the normal way, with
one click. Nothing below in this section applies to you if you did that;
skip straight to Part 5.

**Only if you downloaded the code directly from GitHub instead** (for
development, testing, or before it's published) do you need to load it
manually:

**Chrome:** go to `chrome://extensions`, turn on Developer mode, click
**Load unpacked**, select the `easy-bookmark-sync` folder.

**Edge:** go to `edge://extensions`, turn on Developer mode, click **Load
unpacked**, select the same folder.

**Firefox:** go to `about:debugging#/runtime/this-firefox`, click **Load
Temporary Add-on**, select `manifest.json` from the
[Easy-Bookmark-Sync-FF](https://github.com/rogleete/Easy-Bookmark-Sync-FF)
repo folder (Firefox needs its own manifest, different from the
Chrome/Edge one). This only lasts until Firefox closes - it needs
reloading each session unless it's actually installed from
addons.mozilla.org.

## Part 5: Paste the Client ID and Client Secret<br>

1. Right-click the toolbar icon → **Options** (or open it from the popup's
   setup screen).
2. The redirect URI shown there should already match one of the three
   URIs you added in Part 3 (Chrome Web Store, Edge Add-ons, or Firefox) -
   nothing more to add there if so.
3. Paste both the Client ID and Client Secret from Part 3 into the fields
   on the Options page and click **Save**.
4. Repeat on a second browser if you're using one - same Client ID and
   Secret, since both stores' redirect URIs are already on that OAuth
   client from Part 3.<br><br>
<img width="379" height="394" alt="dropdown1-changesettings" src="https://github.com/user-attachments/assets/ed813cad-a8a0-4017-bbe2-17f2a8c97d07" /><br>
<img width="628" height="1218" alt="setupoptions" src="https://github.com/user-attachments/assets/7a7e3bc4-83bd-4f21-b401-d76278dfa9b1" /><br>

## Part 6: First run

**If you want one computer to be the "real" copy (Master / Destination):**

Do this on your **master** computer first (the one with the bookmarks you
already have):

1. Click the extension icon.
2. Check **Master Sync Source**.<br>
3. Click **Connect Google Account** and approve access.<br>
<img width="555" height="601" alt="setup-google-verifyapp" src="https://github.com/user-attachments/assets/34d5f22c-5516-486d-8ce5-eb7f767c0299" /><br>
<img width="565" height="1014" alt="setup-google-verifyapp-continue" src="https://github.com/user-attachments/assets/c4bb7915-7221-4ad0-81a6-1d5e26bdb784" />

4. It creates an `EasyBookmarkSync` folder in Drive, takes an automatic
   "Initial Backup" as a safety net, and does an initial upload.

Then on any other computer you want to pull bookmarks down to:

1. Load the extension there too (repeat Parts 4-5 for that browser if
   needed).
2. Click the extension icon, check **Destination Sync**.
3. Click **Connect Google Account**, sign in with the *same* Google
   account.
4. It pulls down whatever the master last uploaded, replacing local
   bookmarks.

**If you want every computer to stay in sync both ways instead (Merge):**

1. Click the extension icon on each computer you want in the group.
2. Check **Merge (Two-Way)**.<br>
<img width="379" height="648" alt="dropdown4-settings" src="https://github.com/user-attachments/assets/d91516cc-6d83-4542-ad4f-efe81d342b9c" /><br>

3. Click **Connect Google Account**, sign in with the *same* Google
   account on each one.
4. The first computer to connect seeds the shared group with its current
   bookmarks. Every computer after that takes a "Pre-Merge Backup" first,
   then joins by matching what it already has against the group - exact
   matches merge together quietly, and anything that's the same bookmark
   but filed or titled differently on each side shows up in the popup's
   Conflicts tab for you to resolve once.

From then on, any change on any Merge computer - adding, editing, moving,
or deleting a bookmark or folder - shows up on the others on their next
sync.

## How syncing behaves

- **Master, Realtime**: a bookmark change triggers a sync a few seconds
  later, plus a once-a-minute backstop check.
- **Destination, Realtime**: checks the cloud roughly once a minute - true
  instant push needs a server watching for changes, this is the closest
  practical equivalent.
- **Master/Destination**: every sync fully replaces the target, no
  merging.
- **Merge**: every sync compares what changed locally against what's
  changed in the shared file since this device's last sync, then applies
  whichever side is genuinely new on each individual bookmark or folder.
  Deletions are tracked (not just a disappearance), so a computer that
  hasn't synced in a while won't bring something back that was deleted
  elsewhere. If the same item changed on two computers before either
  synced, it's held back and shown in the popup's Conflicts tab instead
  of guessing which side should win.
- Only asks for permission to see files it creates in Drive
  (`drive.file` scope), not your whole Drive.

## Manual backups

Separate from the automatic sync, click **Manual Backup** at the bottom of
the popup to open a page where you can:

- Click **Generate a separate Backup** to save a timestamped snapshot of
  every bookmark in this browser right now, into its own `Backups` folder
  inside `EasyBookmarkSync` - untouched by the regular automatic sync.
  Named with this device's label (set on the Options page) so it's easy
  to tell which computer a backup came from.
- Browse past backups (name, date, and bookmark count shown for each) and
  delete individual ones you don't need anymore.
- Pick one from the dropdown and click **Restore selected backup** to
  replace every current local bookmark with that snapshot. This asks for
  confirmation first since it can't be undone. Available on **Master Sync
  Source** and **Merge (Two-Way)** - not Destination Sync, since that's
  just a mirror and would get overwritten by the next pull anyway.
  Restoring on a Merge device resets that device's sync tracking so it
  safely re-joins the group on its next sync, same as a brand new device.
- **Keep at most** sets a retention limit (default 15, editable, or
  "Unlimited") - the oldest backups auto-prune once you're over it.<br><br>
  <img width="664" height="1057" alt="manualbackups" src="https://github.com/user-attachments/assets/99ff2f6d-4452-4245-961c-2c3d89b2dc2f" />


Two backups also happen automatically, no action needed: an **Initial
Backup** the very first time you ever connect a Google account, and a
**Pre-Merge Backup** whenever a device joins an existing Merge group,
right before it reconciles against what's already there.

## Merge (Two-Way) extras

Two things only show up in the popup when a device is set to Merge:

- **Conflicts tab** - appears (with a count badge) whenever something
  changed differently on two computers before they synced. Each entry
  shows both versions with options to keep one, keep the other, or keep
  both. The toolbar icon shows an amber dot whenever anything's pending
  here, ahead of the usual green "synced" dot.<br>
  
- **Troubleshooting tab** - has a "Reset merge tracking" button for if
  this device's sync tracking ever seems off. It doesn't touch or delete
  any bookmarks - it clears this device's local bookkeeping and has it
  safely re-join the group on the next sync, the same way a brand new
  device would.<br>
  <img width="379" height="471" alt="dropdown3-troubleshooting" src="https://github.com/user-attachments/assets/bd424c15-5c08-4a63-9ed1-5bbe9483be3e" />



## Troubleshooting setup/sign-in issues

(For Merge sync tracking issues specifically, use the Troubleshooting tab
inside the extension's popup instead - see above.)

- **Error 400: redirect_uri_mismatch** - the redirect URI on the Options
  page doesn't exactly match one of the Authorized redirect URIs on your
  OAuth client. Check for a missing trailing slash or http vs https.
- **"No Google Client ID set yet"** - paste one into the extension's
  Options page.
- **Asks to sign in every time** - usually a mismatched redirect URI, or a
  browser profile blocking third-party cookies for accounts.google.com.
- **"No bookmarks found in the cloud yet"** on a destination browser - the
  master browser hasn't completed its first sync yet.
