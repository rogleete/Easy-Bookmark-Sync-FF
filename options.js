const clientIdInput = document.getElementById('clientIdInput');
const clientSecretInput = document.getElementById('clientSecretInput');
const saveButton = document.getElementById('saveButton');
const saveMessage = document.getElementById('saveMessage');
const redirectUriText = document.getElementById('redirectUriText');
const copyRedirectButton = document.getElementById('copyRedirectButton');
const fullInstructionsLink = document.getElementById('fullInstructionsLink');
const deviceLabelInput = document.getElementById('deviceLabelInput');
const saveDeviceLabelButton = document.getElementById('saveDeviceLabelButton');
const deviceLabelMessage = document.getElementById('deviceLabelMessage');

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function loadDeviceLabel() {
  const state = await send({ type: 'getState' });
  deviceLabelInput.value = state.deviceLabel || '';
  deviceLabelInput.placeholder = state.deviceLabel || "e.g. Sam's Laptop";
}

saveDeviceLabelButton.addEventListener('click', async () => {
  const label = deviceLabelInput.value.trim();
  await send({ type: 'setDeviceLabel', label });
  deviceLabelMessage.textContent = label ? 'Saved.' : 'Cleared - a default will be used instead.';
  deviceLabelMessage.classList.remove('hidden');
  setTimeout(() => deviceLabelMessage.classList.add('hidden'), 2000);
  await loadDeviceLabel();
});

loadDeviceLabel();

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
