const clientIdInput = document.getElementById('clientIdInput');
const saveButton = document.getElementById('saveButton');
const saveMessage = document.getElementById('saveMessage');
const redirectUriText = document.getElementById('redirectUriText');
const copyRedirectButton = document.getElementById('copyRedirectButton');
const fullInstructionsLink = document.getElementById('fullInstructionsLink');

redirectUriText.textContent = chrome.identity.getRedirectURL();
fullInstructionsLink.href = chrome.runtime.getURL('install.html');

copyRedirectButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(redirectUriText.textContent);
  const original = copyRedirectButton.textContent;
  copyRedirectButton.textContent = 'Copied';
  setTimeout(() => { copyRedirectButton.textContent = original; }, 1500);
});

async function loadClientId() {
  const { googleClientId } = await chrome.storage.local.get('googleClientId');
  if (googleClientId) {
    clientIdInput.value = googleClientId;
  }
}

saveButton.addEventListener('click', async () => {
  const value = clientIdInput.value.trim();
  await chrome.storage.local.set({ googleClientId: value });
  saveMessage.textContent = value ? 'Saved.' : 'Cleared.';
  saveMessage.classList.remove('hidden');
  setTimeout(() => saveMessage.classList.add('hidden'), 2000);
});

loadClientId();
