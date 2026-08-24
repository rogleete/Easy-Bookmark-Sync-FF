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
   <img width="650" height="1119" alt="install14-clientid" src="https://github.com/user-attachments/assets/3eefe644-78fc-4af0-97bd-b0dbfeddd58f" /><br>
3. Under **Authorized redirect URIs**, add both of these exact URIs (one
   per line) - they're fixed permanently now, tied to the published
   listings, so this step won't need revisiting later:<br><br>
   `https://ohgafdieafmgfcahebkcbnpbnjopglfp.chromiumapp.org/` (Chrome Web Store)<br>
   `https://iplgoihgbngdhmcbacjakppljbeepchk.chromiumapp.org/` (Edge Add-ons)<br>
   `https://1dbba077862f3a0e4781d873ee0b7bdc66670fb4.extensions.allizom.org/` (Firefox)<br><br>
   Add both now even if you're only using one browser today - it saves
   coming back to add the other one later. (If you're loading the
   extension unpacked in Developer mode instead of installing it from a
   store, its ID - and redirect URI - will be different; the extension's
   Options page always shows the exact one to use for whatever copy
   you're running.)
4. One Client ID can hold multiple redirect URIs, so both of the above
   (plus any unpacked dev ID) can live on this same OAuth client - no need
   for separate Client IDs per browser.
5. Save, then copy the Client ID (ends in `.apps.googleusercontent.com`).<br><br>
<img width="586" height="312" alt="install15-clientidvalue" src="https://github.com/user-attachments/assets/f1752d22-0aff-44c2-98dc-c0c1c44241f0" /><br>

## Part 4: Load the extension

**Chrome:** go to `chrome://extensions`, turn on Developer mode, click
**Load unpacked**, select the `easy-bookmark-sync` folder.

**Edge:** go to `edge://extensions`, turn on Developer mode, click **Load
unpacked**, select the same folder.

## Part 5: Paste the Client ID<br>

1. Right-click the toolbar icon → **Options** (or open it from the popup's
   setup screen).
2. The redirect URI shown there should already match one of the two URIs
   you added in Part 3 (Chrome Web Store or Edge Add-ons) - nothing more
   to add there if so.
3. Paste the Client ID from Part 3 into the field on the Options page and
   click **Save**.
4. Repeat on a second browser if you're using one - same Client ID, since
   both stores' redirect URIs are already on that OAuth client from
   Part 3.<br><br>
<img width="373" height="343" alt="install16-menu" src="https://github.com/user-attachments/assets/e461a559-f6cb-40e5-9449-b4ec6fe0e163" /><br>
<img width="371" height="467" alt="install17-settings" src="https://github.com/user-attachments/assets/bf126b6f-27b0-4c7b-9f38-3d364df39d6e" /><br>
<img width="662" height="747" alt="install18-setup" src="https://github.com/user-attachments/assets/29503f09-8a44-421f-ae9c-5afc7e9abf8b" /><br>

## Part 6: First run

Do this on your **master** computer first (the one with the bookmarks you
already have):

1. Click the extension icon.
2. Check **Master Sync Source**.
3. Click **Connect Google Account** and approve access.
4. It creates an `EasyBookmarkSync` folder in Drive and does an initial
   upload.

Then on any other computer you want to pull bookmarks down to:

1. Load the extension there too (repeat Parts 4-5 for that browser if
   needed).
2. Click the extension icon, check **Destination Sync**.
3. Click **Connect Google Account**, sign in with the *same* Google
   account.
4. It pulls down whatever the master last uploaded, replacing local
   bookmarks.

## How syncing behaves

- **Master, Realtime**: a bookmark change triggers a sync a few seconds
  later, plus a once-a-minute backstop check.
- **Destination, Realtime**: checks the cloud roughly once a minute - true
  instant push needs a server watching for changes, this is the closest
  practical equivalent.
- Every sync fully replaces the target, no merging.
- Only asks for permission to see files it creates in Drive
  (`drive.file` scope), not your whole Drive.

## Manual backups

Separate from the automatic sync, click **Manual Backup** at the bottom of
the popup to open a page where you can:

- Click **Generate a separate Backup** to save a timestamped snapshot of
  every bookmark in this browser right now, into its own `Backups` folder
  inside `EasyBookmarkSync` - untouched by the regular automatic sync.
- Browse past backups (date and bookmark count shown for each) and delete
  individual ones you don't need anymore.
- Pick one from the dropdown and click **Restore selected backup** to
  replace every current local bookmark with that snapshot. This is only
  available on the **Master Sync Source** browser, and asks for
  confirmation first since it can't be undone.<br>
  <img width="676" height="680" alt="settings-manualbackup" src="https://github.com/user-attachments/assets/42945640-a62e-43c1-9388-f3ecfaba2f99" />


## Troubleshooting

- **Error 400: redirect_uri_mismatch** - the redirect URI on the Options
  page doesn't exactly match one of the Authorized redirect URIs on your
  OAuth client. Check for a missing trailing slash or http vs https.
- **"No Google Client ID set yet"** - paste one into the extension's
  Options page.
- **Asks to sign in every time** - usually a mismatched redirect URI, or a
  browser profile blocking third-party cookies for accounts.google.com.
- **"No bookmarks found in the cloud yet"** on a destination browser - the
  master browser hasn't completed its first sync yet.
