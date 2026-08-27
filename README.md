![GitHub all releases](https://img.shields.io/github/downloads/rogleete/Easy-Bookmark-Sync-FF/total)
# Easy Bookmark Sync 
(open the [INSTALL.md](./INSTALL.md) for first run instructions)

A browser extension for Chrome, Edge, and Firefox that syncs bookmarks between your
own computers through your own Google Drive. Pick one of two setups per computer:

- **Master / Destination** - one computer is the **Master Sync Source**
  (bookmarks get pushed up from here), and any number of others are a
  **Destination Sync** (bookmarks get pulled down and replace whatever's
  local). Simple, one-directional, good when one computer is the "real"
  copy.
- **Merge (Two-Way)** - any number of computers stay in sync both ways: add
  a bookmark on one, it shows up on the others; delete one, it's gone
  everywhere. Uses its own separate file in Drive, so it never conflicts
  with a Master/Destination setup running on other computers at the same
  time.

There's no server in the middle - this extension talks directly to Google
Drive using a Google Cloud OAuth Client ID that **you** create yourself.
Nobody's bookmark data or Google account access ever passes through the
extension's developer. See [PrivacyPolicy.md](./PrivacyPolicy.md) for the
full details.

## Features

- Syncs through a single `EasyBookmarkSync` folder created in your Drive
- Three modes: Master Sync Source, Destination Sync, or Merge (Two-Way)
- Sync frequency: Manual only, Realtime, or a fixed interval (10/20/30/45/60 min)
- Realtime mode reacts to bookmark changes within a few seconds, with a
  once-a-minute backstop check
- Toolbar icon shows a small status dot at a glance - green when synced,
  red on error, a spinner while syncing, amber if a Merge conflict needs
  your attention - no need to open the popup to check
- Status, stats, and a short Activity log (recent syncs, backups, and any
  errors) right in the popup
- Merge (Two-Way) also gets a Conflicts tab when something changed
  differently on two computers before they synced, and a Troubleshooting
  tab with a one-click way to safely re-derive this device's sync
  tracking if it ever seems off
- Automatic safety backups: an "Initial Backup" the first time you connect
  Google, and a "Pre-Merge Backup" whenever a device joins an existing
  Merge group - both count toward the same backup limit as manual ones
- Manual backups: separate, timestamped snapshots you create on demand,
  labeled with this device's name so they're easy to tell apart, stored in
  their own `Backups` folder untouched by the regular sync - browse them,
  restore one, or delete individual ones any time. A backup retention
  limit (editable, default 15, or unlimited) auto-prunes the oldest ones
- Only asks for the `drive.file` Google scope - it can only see files and
  folders it creates itself, not your whole Drive

## Setup Guide

This extension needs a (free) Google Cloud OAuth Client ID before it can
sign in to Google Drive. It's about ten minutes, one time only, and you
don't need to touch any code - everything gets pasted into the extension's
Options page.

### Part 1: Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   sign in with the Google account you want to sync bookmarks through.
2. Create a new project (top left project dropdown → New Project). Name it
   whatever you like, e.g. "Bookmark Sync".
3. Search the top bar for **Google Drive API** and click **Enable**.

### Part 2: OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. User type: **External** (Internal is fine too if you have a Workspace
   account).
3. Fill in an app name and your email for the support/developer contact
   fields. Everything else can stay blank.
4. Scopes step: nothing to add manually.
5. Test users step: add the Google account email you'll actually use with
   the extension. While the app is in "Testing" mode, only accounts on
   this list can sign in - that's expected for a personal tool.

### Part 3: OAuth Client ID

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth
   client ID**.
2. Application type: **Web application** (not "Chrome Extension" - that
   older client type isn't needed and just adds confusion).
3. Under **Authorized redirect URIs**, add all three of these exact URIs
   (one per line) - they're fixed permanently now, tied to the published
   listings, so this step won't need revisiting later:
   - `https://ohgafdieafmgfcahebkcbnpbnjopglfp.chromiumapp.org/` (Chrome Web Store)
   - `https://iplgoihgbngdhmcbacjakppljbeepchk.chromiumapp.org/` (Edge Add-ons)
   - `https://1dbba077862f3a0e4781d873ee0b7bdc66670fb4.extensions.allizom.org/` (Firefox)

   Add all three now even if you're only using one browser today. (If
   you're loading the extension unpacked in Developer mode instead of
   installing it from a store, its ID - and redirect URI - will be
   different; the extension's Options page always shows the exact one to
   use for whatever copy you're running.)
4. One Client ID can hold multiple redirect URIs, so all three of the
   above (plus any unpacked dev ID) can live on this same OAuth client -
   no need for separate Client IDs per browser.
5. Save, then copy both the Client ID (ends in `.apps.googleusercontent.com`)
   and the Client Secret (starts with `GOCSPX-`) Google generated
   alongside it - both get pasted into the extension's Options page.

### Part 4: Install the extension

Most people should just install this from the store for their browser -
Chrome Web Store, Edge Add-ons, or Firefox Add-ons - the normal way,
with one click. Nothing below in this section applies to you if you did
that; skip straight to Part 5.

**Only if you downloaded the code directly from GitHub instead** (for
development, testing, or before it's published) do you need to load it
manually:

**Chrome:** go to `chrome://extensions`, turn on Developer mode, click
**Load unpacked**, select this repo's folder.

**Edge:** go to `edge://extensions`, turn on Developer mode, click **Load
unpacked**, select the same folder.

**Firefox:** go to `about:debugging#/runtime/this-firefox`, click **Load
Temporary Add-on**, select `manifest.json` inside the
[Easy-Bookmark-Sync-FF](https://github.com/rogleete/Easy-Bookmark-Sync-FF)
repo folder (Firefox needs its own manifest, different from the
Chrome/Edge one in this repo). Note this only lasts until Firefox closes -
it needs reloading each session unless it's actually installed from
addons.mozilla.org.

### Part 5: Paste the Client ID and Client Secret

1. Right-click the toolbar icon → **Options**.
2. The redirect URI shown there should already match one of the three
   URIs you added in Part 3 (Chrome Web Store, Edge Add-ons, or Firefox) -
   nothing more to add there if so.
3. Paste both the Client ID and Client Secret from Part 3 into the fields
   on the Options page and click **Save**.
4. Repeat on a second browser if you're using one - same Client ID and
   Secret, since both stores' redirect URIs are already on that OAuth
   client from Part 3.

### Part 6: First run

**If you want one computer to be the "real" copy (Master / Destination):**

Do this on your **master** computer first (the one with the bookmarks you
already have):

1. Click the extension icon.
2. Check **Master Sync Source**.
3. Click **Connect Google Account** and approve access.
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
2. Check **Merge (Two-Way)**.
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

- **Manual**: nothing happens automatically - only the "Sync now" button
  in the popup triggers a sync.
- **Master, Realtime**: a real bookmark change (add/remove/edit/move)
  triggers a sync within a few seconds, plus a once-a-minute backstop
  check in case a change happened while the browser was closed.
- **Destination, Realtime**: checks the cloud roughly once a minute. True
  instant push would need a server watching for changes, so this is the
  closest practical equivalent.
- **Master/Destination**: every sync fully replaces the target - no
  merging. Master overwrites the cloud copy; destination overwrites local
  bookmarks. Checks that find nothing new don't touch Drive or your
  bookmarks at all - a sync only actually happens when something real
  changed.
- **Merge**: every sync compares what changed locally against what's
  changed in the shared file since this device's last sync, then applies
  whichever side is genuinely new on each individual bookmark or folder.
  A deletion is tracked (not just a disappearance), so a computer that
  hasn't synced in a while won't accidentally bring something back that
  was deleted elsewhere. If the *same* item changed on two computers
  before either synced, it's held back and shown in the Conflicts tab
  instead of guessing which side should win.

## Backups

Separate from the regular automatic sync, "Manual Backup" in the popup
footer opens a full page where you can:

- **Generate a separate Backup** - captures every bookmark in this browser
  right now, uploaded as its own timestamped file in a `Backups` folder
  inside `EasyBookmarkSync`, alongside a bookmark count. Named with this
  device's label (set in Options) so it's easy to tell which computer a
  backup came from once more than one is involved.
- **Browse and delete** - see every backup you've taken, with its name,
  date, and count, and delete individual ones permanently.
- **Restore** - pick a backup from the dropdown and restore it. This
  replaces every current local bookmark with what's in that snapshot and
  can't be undone, so it asks for confirmation first. Available on
  **Master Sync Source** and **Merge (Two-Way)** - not on Destination Sync,
  since a destination browser is just a mirror and would get overwritten
  by the next pull anyway. Restoring on Master flags the restored state to
  push up on the next sync. Restoring on a Merge device resets that
  device's sync tracking, so it safely re-joins the group from scratch on
  its next sync, the same way a brand new device would.
- **Keep at most** - a retention limit (default 15, editable, or
  "Unlimited") that auto-prunes the oldest backups once you're over it.
  Manual backups and the automatic ones below share this same pool.

Two backups happen automatically, no action needed:

- **Initial Backup** - taken once, the very first time you ever connect a
  Google account on any device, before any sync has touched anything.
- **Pre-Merge Backup** - taken automatically whenever a device joins an
  existing Merge group, right before it reconciles its bookmarks against
  what's already there.

These backups are completely separate from the live sync files (the
Master/Destination `bookmarks.json` and the Merge `bookmarks-merge.json`)
- creating, restoring, or deleting one never affects regular syncing, and
vice versa.

## Merge (Two-Way) extras

Two things only show up in the popup when a device is set to Merge:

- **Conflicts tab** - appears (with a count badge) whenever something
  changed differently on two computers before they synced. Each entry
  shows both versions side by side with options to keep one, keep the
  other, or keep both as separate items. The toolbar icon shows an amber
  dot whenever anything's pending here, which takes priority over the
  usual green "synced" dot.
- **Troubleshooting tab** - has a "Reset merge tracking" button for if this
  device's sync tracking ever seems off. It doesn't touch or delete any
  bookmarks - it just clears this device's local bookkeeping and has it
  safely re-join the group on the next sync, the same way a brand new
  device would (Pre-Merge Backup included).

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

## Privacy

Each person who installs this extension connects it to their own Google
Cloud project - see [PrivacyPolicy.md](./PrivacyPolicy.md) for details on
what data is accessed and where it goes (short version: only to your own
Google Drive, nowhere else).
