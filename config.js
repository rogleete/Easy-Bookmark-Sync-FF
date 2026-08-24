// Google OAuth Client ID now lives in chrome.storage.local (set from the
// extension's Options page) instead of being hardcoded here - that way
// nobody has to open a text editor to configure this thing.

// Only asking for access to files/folders this extension itself creates.
// That keeps it out of the rest of whatever is sitting in someone's Drive.
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const DRIVE_FOLDER_NAME = 'EasyBookmarkSync';
const DRIVE_FILE_NAME = 'bookmarks.json';

// Chrome enforces a 1 minute floor on alarms once an extension is packed,
// so "realtime" really means "check almost every minute" rather than
// instantaneous. Bookmark change events themselves fire immediately for
// the master browser, this constant is just the polling backstop.
const REALTIME_POLL_MINUTES = 1;

const SYNC_INTERVAL_OPTIONS = [
  { value: 'manual', label: 'Manual only' },
  { value: 'realtime', label: 'Realtime' },
  { value: '10', label: 'Every 10 minutes' },
  { value: '20', label: 'Every 20 minutes' },
  { value: '30', label: 'Every 30 minutes' },
  { value: '45', label: 'Every 45 minutes' },
  { value: '60', label: 'Every 60 minutes' }
];
