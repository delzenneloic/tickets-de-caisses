'use strict';
const APP_VERSION = '2026.10.15.1';

// Identifiant public repris de l'application Muscu fournie. Aucun secret à ajouter.
const CLIENT_ID = '4855509636-ivkbqfrh8q2f7orpj50e7cgltkfm2vda.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const { naming, merchantId, filterMerchants, fileInfo, Drive, ROOT_NAME } = TicketCore;
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const byteSize = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} Ko` : `${(bytes / 1024 / 1024).toLocaleString('fr-BE', { maximumFractionDigits: 1 })} Mo`;
const DB_NAME = 'tickets-de-caisses:' + new URL('./', location.href).pathname;
let db, records = [], token = null, account = null, tokenClient = null;
let busy = false, adding = false, connecting = false, ready = false, activeId = null, progressValue = 0;
let currentView = 'add', rootFolderId = null, lastTimestamp = 0;
let previewUrl = null;
let merchants = [], selectedMerchant = null, merchantsReady = false, loadingMerchants = false, creatingMerchant = false;
let merchantLoadVersion = 0, activeMerchantIndex = -1;
let serviceWorkerRegistration, updateAvailable = false;
const thumbnails = new Map();
const channel = 'BroadcastChannel' in window ? new BroadcastChannel(DB_NAME) : null;
const drive = new Drive({ getToken: () => token && token.expires > Date.now() + 10000 ? token.value : null, onExpired: () => { token = null; renderConnection(); } });

function notify(message, kind = '') {
  $('message').textContent = message; $('message').className = 'notice' + (kind ? ' ' + kind : ''); $('message').hidden = !message;
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('receipts', { keyPath: 'id' });
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => notify('Fermez les autres onglets de cette application, puis rechargez la page.', 'error');
  });
}
function storage(operation, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('receipts', operation === 'getAll' || operation === 'get' ? 'readonly' : 'readwrite');
    const store = tx.objectStore('receipts');
    const request = value === undefined ? store[operation]() : store[operation](value);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error || request.error);
    tx.onabort = () => reject(tx.error || new Error('Enregistrement local interrompu.'));
  });
}
async function save(item) {
  try { await storage('put', item); }
  catch { throw new Error('Impossible d’enregistrer le ticket sur cet appareil. Libérez de l’espace et réessayez.'); }
}
async function refresh() { records = await storage('getAll'); render(); }
function broadcast() { channel?.postMessage('changed'); }
channel?.addEventListener('message', () => { if (!busy && !adding && ready) refresh().catch(() => {}); });

function renderConnection() {
  const valid = !!token && token.expires > Date.now() + 10000;
  const button = $('connect');
  button.textContent = connecting ? 'Connexion…' : valid && account ? 'Drive connecté' : account ? 'Reconnecter Google Drive' : 'Connecter Google Drive';
  button.title = valid && account ? `${account.emailAddress || account.displayName} — cliquer pour déconnecter` : 'Se connecter à Google Drive';
  button.classList.toggle('connected', valid && !!account);
  button.disabled = busy || connecting || adding || creatingMerchant;
}
function closeMerchantOptions() {
  $('merchant-options').hidden = true; $('merchant-search').setAttribute('aria-expanded', 'false');
  $('merchant-search').removeAttribute('aria-activedescendant'); activeMerchantIndex = -1;
}
function renderMerchantOptions() {
  const matches = filterMerchants(merchants, $('merchant-search').value);
  $('merchant-options').innerHTML = matches.length ? matches.map((item, index) => `<li id="merchant-option-${item.id}" role="option" aria-selected="${index === activeMerchantIndex}" data-merchant="${item.id}"><strong>${esc(item.name)}</strong><span>${merchantId(item.id)} · ${esc(item.address)}</span></li>`).join('') : '<li class="no-match" role="presentation">Aucune enseigne correspondante. Utilisez « Nouvelle enseigne ».</li>';
  return matches;
}
function renderMerchants() {
  const disabled = busy || adding || connecting || creatingMerchant || loadingMerchants || !ready;
  $('merchant-search').disabled = disabled || !merchantsReady || !account;
  $('new-merchant').disabled = disabled || !account || !navigator.onLine;
  $('refresh-merchants').disabled = disabled || !account || !navigator.onLine;
  $('merchant-help').textContent = loadingMerchants ? 'Chargement des enseignes depuis Google Drive…' : !account ? 'Connectez Google Drive pour retrouver vos enseignes sur tous vos appareils.' : !merchantsReady ? 'Le répertoire est indisponible. Actualisez les enseignes pour réessayer.' : 'Tapez une partie du nom, puis sélectionnez une enseigne. Les nouveaux tickets du lot lui seront associés.';
  $('merchant-selection').textContent = selectedMerchant ? `${merchantId(selectedMerchant.id)} · ${selectedMerchant.name} · ${selectedMerchant.address} · TVA ${selectedMerchant.vatNumber}` : 'Aucune enseigne sélectionnée.';
  if (disabled) closeMerchantOptions();
}
function selectMerchant(item) {
  selectedMerchant = item; $('merchant-search').value = item.name; closeMerchantOptions(); render();
}
async function loadMerchants() {
  if (!account) return;
  const version = ++merchantLoadVersion, accountId = account.permissionId;
  loadingMerchants = true; merchantsReady = false; render();
  try {
    const list = await drive.merchants();
    if (version !== merchantLoadVersion || account?.permissionId !== accountId) return;
    merchants = list; merchantsReady = true;
    if (selectedMerchant) {
      selectedMerchant = list.find(item => item.id === selectedMerchant.id) || null;
      $('merchant-search').value = selectedMerchant?.name || '';
    }
  } catch (error) {
    if (version === merchantLoadVersion) { selectedMerchant = null; merchants = []; notify(error.message, 'error'); }
  } finally { if (version === merchantLoadVersion) { loadingMerchants = false; render(); } }
}
function resetMerchants() {
  merchantLoadVersion++; merchants = []; selectedMerchant = null; merchantsReady = false; loadingMerchants = false;
  $('merchant-search').value = ''; closeMerchantOptions();
}
function thumbnail(item) {
  if (item.mimeType.startsWith('image/') && !/hei[cf]|tiff/.test(item.mimeType)) {
    if (!thumbnails.has(item.id)) thumbnails.set(item.id, URL.createObjectURL(item.blob));
    return `<img src="${thumbnails.get(item.id)}" alt="" loading="lazy">`;
  }
  return item.extension.toUpperCase();
}
function render() {
  renderUpdate();
  const now = new Date();
  $('current-month').textContent = now.toLocaleDateString('fr-BE', { month: 'long', year: 'numeric' });
  $('folder-month').textContent = naming(now, '').month;
  const pending = records.filter(item => item.status !== 'done').sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  const currentIds = new Set(pending.map(item => item.id));
  for (const [id, url] of thumbnails) if (!currentIds.has(id)) { URL.revokeObjectURL(url); thumbnails.delete(id); }
  $('queue-count').textContent = pending.length;
  $('tab-count').textContent = pending.length;
  $('tab-count').hidden = !pending.length;
  $('queue-list').innerHTML = pending.length ? pending.map(item => {
    const active = activeId === item.id;
    const wrongAccount = account && item.accountId && item.accountId !== account.permissionId;
    return `<article class="ticket"><button type="button" class="thumbnail" data-preview="${item.id}" aria-label="Aperçu de ${esc(item.originalName)}">${thumbnail(item)}</button><div class="ticket-content"><p class="ticket-name">${esc(item.originalName)}</p><p class="ticket-meta">${byteSize(item.size)} · ${active ? `Envoi ${progressValue} %` : item.status === 'error' ? 'À réessayer' : 'Prêt à envoyer'}</p>${item.name ? `<p class="ticket-detail">${esc(item.merchantName || 'Enseigne à choisir')} · ${esc(item.month)}/A traiter/${esc(item.name)}</p>` : ''}${wrongAccount ? `<p class="ticket-error">À envoyer avec ${esc(item.accountEmail || 'le compte du premier envoi')}.</p>` : item.error ? `<p class="ticket-error">${esc(item.error)}</p>` : ''}${active ? `<progress max="100" value="${progressValue}" aria-label="Progression de l’envoi"></progress>` : ''}</div><button type="button" class="remove" data-remove="${item.id}" aria-label="Retirer ${esc(item.originalName)} de la liste d’envoi" ${busy || adding ? 'disabled' : ''}>×</button></article>`;
  }).join('') : '<div class="empty"><p>Aucun ticket en attente</p><p class="sub">Les tickets ajoutés apparaîtront ici avant l’envoi.</p></div>';
  $('queue-list').querySelectorAll('img').forEach(img => { img.onerror = () => { img.replaceWith(document.createTextNode('PHOTO')); }; });
  $('send-bar').hidden = !pending.length;
  $('send').textContent = busy ? 'Envoi en cours…' : `Envoyer ${pending.length > 1 ? `les ${pending.length} tickets` : 'le ticket'} vers Drive`;
  $('send').disabled = busy || adding || connecting || creatingMerchant || loadingMerchants || !ready || !navigator.onLine || !merchantsReady || !selectedMerchant;
  $('send-note').textContent = !navigator.onLine ? 'Hors ligne. Vos tickets restent sur cet appareil.' : !selectedMerchant ? 'Sélectionnez une enseigne pour pouvoir envoyer les tickets.' : 'Conservés sur cet appareil jusqu’à confirmation de Google Drive.';
  $('camera-button').disabled = !ready || busy || adding;
  $('files-button').disabled = !ready || busy || adding;
  renderConnection(); renderMerchants(); renderHistory();
}
function renderHistory() {
  $('open-folder').hidden = !rootFolderId || !account;
  if (rootFolderId) $('open-folder').href = `https://drive.google.com/drive/folders/${encodeURIComponent(rootFolderId)}`;
  if (!account) {
    $('history-list').innerHTML = '<div class="history-lock"><p>Connectez Google Drive pour afficher l’historique de votre compte sur cet appareil.</p></div>';
    return;
  }
  const sent = records.filter(item => item.status === 'done' && item.accountId === account.permissionId).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  let month = '';
  $('history-list').innerHTML = sent.length ? sent.map(item => {
    const heading = month !== item.month ? `<h2 class="month-heading">${esc(item.month)}</h2>` : '';
    month = item.month;
    const date = new Date(item.sentAt).toLocaleString('fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `${heading}<article class="ticket"><div class="thumbnail" aria-hidden="true">${esc(item.extension.toUpperCase())}</div><div class="ticket-content"><p class="ticket-name">${esc(item.name)}</p><p class="ticket-meta ticket-success">Enregistré · ${esc(date)}</p><p class="ticket-detail">${item.merchantName ? esc(item.merchantName) + ' · ' : ''}${esc(item.originalName)} · ${byteSize(item.size)}</p></div><a class="ticket-link" href="https://drive.google.com/file/d/${encodeURIComponent(item.driveId)}/view" target="_blank" rel="noopener noreferrer" aria-label="Ouvrir ${esc(item.name)} dans Google Drive">↗</a></article>`;
  }).join('') : '<div class="empty"><p>Aucun ticket envoyé depuis cet appareil</p><p class="sub">Vos prochains envois apparaîtront ici.</p></div>';
}
function showView(view) {
  currentView = view;
  $('add-view').hidden = view !== 'add'; $('history-view').hidden = view !== 'history';
  for (const key of ['add', 'history']) {
    $('tab-' + key).classList.toggle('active', key === view);
    if (key === view) $('tab-' + key).setAttribute('aria-current', 'page'); else $('tab-' + key).removeAttribute('aria-current');
  }
  render(); window.scrollTo(0, 0);
}
async function addFiles(files) {
  if (busy || adding || !ready) return;
  adding = true; render();
  const errors = []; let added = 0;
  for (const file of files) {
    try {
      const info = fileInfo(file);
      const item = { id: crypto.randomUUID(), originalName: file.name, size: file.size, ...info, blob: file, addedAt: new Date().toISOString(), status: 'ready' };
      await save(item); records.push(item); added++;
    } catch (error) { errors.push(`${file.name} : ${error.message}`); }
  }
  adding = false; showView('add'); broadcast();
  notify([added ? `${added} ticket${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''}. Prêt${added > 1 ? 's' : ''} à envoyer.` : '', ...errors].filter(Boolean).join(' '), errors.length ? 'error' : '');
  if (added) navigator.storage?.persist?.().catch(() => {});
}

window.gsiLoaded = function () {
  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPE, include_granted_scopes: false,
      callback: async response => {
        if (response.error || !response.access_token || !google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) {
          connecting = false; render(); notify('L’accès à Google Drive n’a pas été accordé. Vous pouvez réessayer.', 'error'); return;
        }
        token = { value: response.access_token, expires: Date.now() + Number(response.expires_in) * 1000 };
        try {
          const user = await drive.account();
          if (account?.permissionId !== user.permissionId) resetMerchants();
          account = user; rootFolderId = null; drive.folders.clear();
          connecting = false; render(); notify(`Google Drive connecté : ${user.emailAddress || user.displayName}.`);
          await loadMerchants();
        } catch (error) { token = null; connecting = false; render(); notify(error.message, 'error'); }
      },
      error_callback: error => {
        connecting = false; render();
        notify(error.type === 'popup_closed' ? 'La fenêtre Google a été fermée. Vous pouvez vous reconnecter quand vous le souhaitez.' : 'La fenêtre Google n’a pas pu s’ouvrir. Autorisez les fenêtres de connexion puis réessayez.', 'error');
      }
    });
    renderConnection();
  } catch { window.gsiFailed(); }
};
window.gsiFailed = () => { connecting = false; notify('La connexion Google n’a pas pu charger. Vérifiez internet puis rechargez la page ; vos tickets restent disponibles.', 'error'); renderConnection(); };
function connect() {
  if (busy || connecting || adding || creatingMerchant) return;
  if (!navigator.onLine) { notify('Connectez-vous à internet pour accéder à Google Drive.', 'error'); return; }
  if (!tokenClient) { window.gsiFailed(); return; }
  connecting = true; render();
  try { tokenClient.requestAccessToken({ prompt: 'select_account' }); }
  catch { connecting = false; render(); notify('Impossible d’ouvrir la connexion Google. Rechargez la page puis réessayez.', 'error'); }
}
$('connect').addEventListener('click', () => {
  if (token && token.expires > Date.now() + 10000 && account) {
    token = null; account = null; rootFolderId = null; drive.folders.clear(); resetMerchants(); render(); notify('Google Drive déconnecté sur cet appareil.');
  } else connect();
});

async function uploadBatch() {
  if (busy || adding || connecting || creatingMerchant || loadingMerchants || !ready) return;
  if (!selectedMerchant || !merchantsReady) { notify('Sélectionnez une enseigne avant d’envoyer le ticket.', 'error'); return; }
  if (!navigator.onLine) { notify('Hors ligne. Reconnectez-vous à internet pour envoyer les tickets.', 'error'); return; }
  if (!token || token.expires <= Date.now() + 10000 || !account) {
    connect(); notify('Connectez Google Drive, puis touchez de nouveau « Envoyer vers Drive ».'); return;
  }
  const run = async lock => {
    if (lock === null) { notify('Un envoi est déjà en cours dans un autre onglet.', 'error'); return; }
    busy = true; render(); notify('Envoi vers Google Drive. Gardez l’application ouverte.');
    let sent = 0, failed = 0, blocked = 0;
    try {
      await refresh();
      const chosenMerchant = selectedMerchant;
      const currentMerchants = await drive.merchants();
      if (!currentMerchants.some(item => item.id === chosenMerchant.id)) throw new Error('L’enseigne sélectionnée n’est plus disponible. Actualisez le répertoire.');
      // Actualiser les dossiers à chaque lot : un dossier supprimé n'est pas conservé en mémoire.
      drive.folders.clear();
      rootFolderId = null;
      const batch = records.filter(item => item.status !== 'done');
      for (const item of batch) {
        if (item.accountId && item.accountId !== account.permissionId) { blocked++; continue; }
        activeId = item.id; progressValue = 0; item.error = ''; render();
        try {
          if (item.merchantId && !currentMerchants.some(merchant => merchant.id === item.merchantId)) throw new Error('L’enseigne de ce ticket est introuvable dans le répertoire Drive.');
          if (!item.merchantId) {
            item.merchantId = chosenMerchant.id; item.merchantName = chosenMerchant.name;
            item.accountId = account.permissionId; item.accountEmail = account.emailAddress || account.displayName;
            if (item.name) { item.name = `${merchantId(item.merchantId)}.${item.name}`; item.folderId = null; item.sessionUrl = null; }
            await save(item);
          }
          if (!rootFolderId) rootFolderId = await drive.folder(ROOT_NAME);
          if (!item.name) {
            const milliseconds = Math.max(Date.now(), lastTimestamp + 1);
            lastTimestamp = milliseconds;
            Object.assign(item, naming(new Date(milliseconds), item.extension, item.merchantId), { firstAttemptAt: new Date(milliseconds).toISOString(), accountId: account.permissionId, accountEmail: account.emailAddress || account.displayName });
            await save(item);
          }
          if (!item.folderId) { item.folderId = await drive.receiptFolder(item.month, rootFolderId); await save(item); }
          const result = await drive.upload(item, save, percent => {
            progressValue = percent;
            const progress = $('queue-list').querySelector('progress');
            if (progress) { progress.value = percent; progress.closest('.ticket-content').querySelector('.ticket-meta').textContent = `${byteSize(item.size)} · Envoi ${percent} %`; }
          });
          if (result.id !== item.driveId || Number(result.size) !== item.size) throw new Error('La confirmation de Google est incomplète. Relancez l’envoi pour la vérifier.');
          // La copie locale n'est libérée qu'après confirmation distante et écriture locale réussie.
          const complete = { ...item, status: 'done', sentAt: new Date().toISOString(), error: '', rootFolderId };
          delete complete.blob; delete complete.sessionUrl;
          await save(complete);
          records[records.findIndex(record => record.id === item.id)] = complete;
          sent++; broadcast();
        } catch (error) {
          item.status = 'error'; item.error = error.message; failed++;
          try { await save(item); } catch { item.error += ' La copie locale précédente reste conservée.'; }
          if (!token || !navigator.onLine) break;
        }
        activeId = null; render();
      }
      const remaining = records.filter(item => item.status !== 'done').length;
      const parts = [];
      if (sent) parts.push(`${sent} ticket${sent > 1 ? 's' : ''} enregistré${sent > 1 ? 's' : ''} dans Google Drive.`);
      if (remaining) parts.push(`${remaining} ticket${remaining > 1 ? 's restent' : ' reste'} sur cet appareil.`);
      if (blocked) parts.push('Certains tickets nécessitent le compte Google utilisé lors du premier envoi.');
      if (!token) parts.push('Reconnectez Google Drive pour continuer.');
      notify(parts.join(' ') || 'Aucun ticket à envoyer.', failed || blocked ? 'error' : sent ? 'success' : '');
    } catch (error) { notify(error.message, 'error'); }
    finally { busy = false; activeId = null; render(); broadcast(); }
  };
  if (navigator.locks) await navigator.locks.request(DB_NAME + ':upload', { ifAvailable: true }, run);
  else await run(undefined);
}
$('send').addEventListener('click', () => uploadBatch().catch(error => notify(error.message, 'error')));
$('merchant-search').addEventListener('focus', () => {
  activeMerchantIndex = -1; renderMerchantOptions(); $('merchant-options').hidden = false; $('merchant-search').setAttribute('aria-expanded', 'true');
});
$('merchant-search').addEventListener('input', () => {
  selectedMerchant = null; activeMerchantIndex = -1; $('merchant-search').removeAttribute('aria-activedescendant'); render();
  renderMerchantOptions(); $('merchant-options').hidden = false; $('merchant-search').setAttribute('aria-expanded', 'true');
});
$('merchant-search').addEventListener('keydown', event => {
  if (event.key === 'Escape' || event.key === 'Tab') { closeMerchantOptions(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
  if (event.key === 'Enter' && $('merchant-options').hidden) return;
  event.preventDefault();
  const matches = filterMerchants(merchants, $('merchant-search').value);
  if (event.key === 'Enter') { if (matches[activeMerchantIndex]) selectMerchant(matches[activeMerchantIndex]); return; }
  activeMerchantIndex = matches.length ? (activeMerchantIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : -1;
  renderMerchantOptions(); $('merchant-options').hidden = false; $('merchant-search').setAttribute('aria-expanded', 'true');
  if (matches[activeMerchantIndex]) {
    const id = 'merchant-option-' + matches[activeMerchantIndex].id;
    $('merchant-search').setAttribute('aria-activedescendant', id); $(id).scrollIntoView({ block: 'nearest' });
  }
});
$('merchant-options').addEventListener('mousedown', event => event.preventDefault());
$('merchant-options').addEventListener('click', event => {
  const option = event.target.closest('[data-merchant]');
  if (option) { selectMerchant(merchants.find(item => item.id === Number(option.dataset.merchant))); $('merchant-search').focus(); closeMerchantOptions(); }
});
document.addEventListener('click', event => { if (!event.target.closest('.combobox')) closeMerchantOptions(); });
$('merchant-search').addEventListener('blur', closeMerchantOptions);
$('refresh-merchants').addEventListener('click', loadMerchants);
$('new-merchant').addEventListener('click', () => {
  $('merchant-form').reset(); $('merchant-name').value = selectedMerchant ? '' : $('merchant-search').value.trim();
  $('merchant-error').textContent = ''; $('merchant-dialog').showModal(); $('merchant-name').focus();
});
$('cancel-merchant').addEventListener('click', () => $('merchant-dialog').close());
$('merchant-dialog').addEventListener('cancel', event => { if (creatingMerchant) event.preventDefault(); });
$('merchant-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (creatingMerchant || !account) return;
  creatingMerchant = true; render(); $('merchant-error').textContent = '';
  const fields = { name: $('merchant-name').value, address: $('merchant-address').value, vatNumber: $('merchant-vat').value };
  for (const control of $('merchant-form').elements) control.disabled = true;
  $('save-merchant').textContent = 'Enregistrement…';
  try {
    const create = () => drive.createMerchant(fields);
    const item = navigator.locks ? await navigator.locks.request(DB_NAME + ':merchants:' + account.permissionId, create) : await create();
    merchants = [...merchants.filter(merchant => merchant.id !== item.id), item]; merchantsReady = true;
    selectMerchant(item); $('merchant-dialog').close(); notify(`Enseigne ${item.name} enregistrée sous le numéro ${merchantId(item.id)}.`, 'success');
  } catch (error) { $('merchant-error').textContent = error.message; }
  finally {
    creatingMerchant = false; for (const control of $('merchant-form').elements) control.disabled = false;
    $('save-merchant').textContent = 'Créer et sélectionner'; render();
  }
});
$('camera-button').addEventListener('click', () => $('camera-input').click());
$('files-button').addEventListener('click', () => $('files-input').click());
for (const id of ['camera-input', 'files-input']) $(id).addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; addFiles(files).catch(error => notify(error.message, 'error')); });
$('tab-add').addEventListener('click', () => showView('add'));
$('tab-history').addEventListener('click', () => showView('history'));
$('queue-list').addEventListener('click', async event => {
  const remove = event.target.closest('[data-remove]');
  const preview = event.target.closest('[data-preview]');
  try {
    if (remove && !busy && !adding) {
      const item = records.find(record => record.id === remove.dataset.remove);
      if (!item || !confirm('Retirer ce ticket de la liste sur cet appareil ? Cette action ne supprime aucun fichier de Google Drive.')) return;
      await storage('delete', item.id); await refresh(); broadcast();
    } else if (preview) openPreview(records.find(item => item.id === preview.dataset.preview));
  } catch (error) { notify(error.message, 'error'); }
});
function openPreview(item) {
  if (!item?.blob) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(item.blob);
  $('preview-name').textContent = item.originalName;
  $('preview-content').replaceChildren();
  const fallback = () => {
    const link = document.createElement('a'); link.href = previewUrl; link.download = item.originalName; link.className = 'preview-download'; link.textContent = 'Télécharger le ticket pour le consulter';
    $('preview-content').replaceChildren(link);
  };
  if (item.mimeType === 'application/pdf') {
    const frame = document.createElement('iframe'); frame.src = previewUrl; frame.title = 'Aperçu du PDF'; $('preview-content').append(frame);
    const link = document.createElement('a'); link.href = previewUrl; link.download = item.originalName; link.textContent = 'Télécharger le PDF'; $('preview-content').append(link);
  } else {
    const img = document.createElement('img'); img.src = previewUrl; img.alt = 'Aperçu du ticket sélectionné'; img.onerror = fallback; $('preview-content').append(img);
  }
  $('preview-dialog').showModal();
}
$('close-preview').addEventListener('click', () => $('preview-dialog').close());
$('preview-dialog').addEventListener('close', () => { $('preview-content').replaceChildren(); if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; });
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); if (!busy && !adding) $('drop-zone').classList.add('dragging'); });
$('drop-zone').addEventListener('dragleave', event => { if (!$('drop-zone').contains(event.relatedTarget)) $('drop-zone').classList.remove('dragging'); });
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); addFiles([...event.dataTransfer.files]).catch(error => notify(error.message, 'error')); });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
window.addEventListener('offline', () => { render(); if (!busy) notify('Hors ligne. Vous pouvez ajouter des tickets ; l’envoi sera possible au retour d’internet.'); });
window.addEventListener('online', () => { render(); if (!busy) notify('Connexion rétablie. Vous pouvez envoyer vos tickets en attente.'); });
window.addEventListener('beforeunload', event => { if (busy || adding || creatingMerchant) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy && !adding && ready) refresh().catch(() => {}); });

function renderUpdate() {
  const pendingWork = busy || adding || creatingMerchant || connecting || !ready;
  $('apply-update').disabled = pendingWork;
  $('update-help').textContent = pendingWork ? 'La mise à jour sera possible une fois l’opération en cours terminée.' : 'Terminez ou fermez une fiche en cours avant de recharger. Une reconnexion à Google Drive sera nécessaire.';
}
function receiveVersion(event) {
  if (event.source !== navigator.serviceWorker.controller || event.data?.type !== 'APP_VERSION') return;
  updateAvailable = event.data.version !== APP_VERSION;
  $('update-notice').hidden = !updateAvailable;
  $('update-status').textContent = updateAvailable ? 'Nouvelle version disponible.' : 'Vous utilisez la dernière version installée.';
  renderUpdate();
}
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) { $('check-update').hidden = true; return; }
  const askVersion = () => navigator.serviceWorker.controller?.postMessage({ type: 'GET_VERSION' });
  navigator.serviceWorker.addEventListener('message', receiveVersion);
  navigator.serviceWorker.addEventListener('controllerchange', askVersion);
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    askVersion();
  } catch { $('update-status').textContent = 'Mise à jour indisponible. Réessayez avec une connexion internet.'; }
}
$('apply-update').addEventListener('click', () => {
  if (!updateAvailable || busy || adding || creatingMerchant || connecting || !ready) return;
  if ($('merchant-dialog').open) { $('update-help').textContent = 'Terminez ou fermez la fiche enseigne avant de recharger.'; return; }
  location.replace(new URL('./', location.href).href);
});
$('check-update').addEventListener('click', async () => {
  $('check-update').disabled = true; $('update-status').textContent = 'Recherche de mise à jour…';
  try {
    if (!navigator.onLine) throw new Error('offline');
    if (!serviceWorkerRegistration) await registerServiceWorker();
    if (!serviceWorkerRegistration) throw new Error('unavailable');
    await serviceWorkerRegistration.update();
    if (serviceWorkerRegistration.installing) $('update-status').textContent = 'Téléchargement de la nouvelle version…';
    else navigator.serviceWorker.controller?.postMessage({ type: 'GET_VERSION' });
  } catch { $('update-status').textContent = 'Vérification impossible. Réessayez avec une connexion internet.'; }
  finally { $('check-update').disabled = false; }
});

async function init() {
  render();
  if (location.protocol === 'file:') { notify('Ouvrez cette application depuis une adresse web HTTPS, comme votre suivi musculation. Le guide LIRE-MOI explique la mise en place.', 'error'); return; }
  try { db = await openDatabase(); records = await storage('getAll'); ready = true; render(); }
  catch { notify('Le stockage de ce navigateur est indisponible. Essayez dans une fenêtre normale ou un autre navigateur.', 'error'); return; }
  if (!navigator.onLine) notify('Hors ligne. Vos tickets restent sur cet appareil jusqu’à leur envoi.');
  registerServiceWorker();
}
init();
