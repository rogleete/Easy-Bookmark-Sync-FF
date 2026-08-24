const clientIdInput = document.getElementById('clientIdInput');
const clientSecretInput = document.getElementById('clientSecretInput');
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

async function loadCredentials() {
  const { googleClientId, googleClientSecret } = await chrome.storage.local.get([
    'googleClientId',
    'googleClientSecret'
  ]);
  if (googleClientId) {
    clientIdInput.value = googleClientId;
  }
  if (googleClientSecret) {
    clientSecretInput.value = googleClientSecret;
  }
}

saveButton.addEventListener('click', async () => {
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();
  await chrome.storage.local.set({ googleClientId: clientId, googleClientSecret: clientSecret });
  saveMessage.textContent = clientId || clientSecret ? 'Saved.' : 'Cleared.';
  saveMessage.classList.remove('hidden');
  setTimeout(() => saveMessage.classList.add('hidden'), 2000);
});

loadCredentials();
