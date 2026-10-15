'use strict';

// Fonctions indépendantes de l'interface, également utilisées par les vérifications.
(function (root) {
  const API = 'https://www.googleapis.com/drive/v3';
  const FOLDER = 'application/vnd.google-apps.folder';
  const ROOT_NAME = 'tickets de caisses';
  const PENDING_NAME = 'A traiter';
  const CATALOG_NAME = 'enseignes.json';
  const MAX_SIZE = 25 * 1024 * 1024;
  const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf', avif: 'image/avif', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff' };
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  function merchantId(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 999999) throw new Error('Choisissez une enseigne valide avant l’envoi.');
    return pad(value, 6);
  }
  function naming(date, extension, id) {
    const month = `${date.getFullYear()}.${pad(date.getMonth() + 1)}`;
    const stamp = `${month}.${pad(date.getDate())}.${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
    return { month, stamp, name: `${id === undefined ? '' : merchantId(id) + '.'}${stamp}.${extension}` };
  }
  const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').trim();
  const filterMerchants = (merchants, query) => merchants.filter(item => normalize(item.name).includes(normalize(query))).sort((a, b) => a.name.localeCompare(b.name, 'fr') || a.id - b.id);
  function merchantFields(value) {
    const result = {};
    for (const [field, label, limit] of [['name', 'nom', 160], ['address', 'adresse', 500], ['vatNumber', 'numéro de TVA', 40]]) {
      result[field] = typeof value[field] === 'string' ? value[field].trim() : '';
      if (!result[field] || result[field].length > limit) throw new Error(`Renseignez le ${label === 'adresse' ? 'champ adresse' : label} (${limit} caractères maximum).`);
    }
    return result;
  }
  function validateCatalog(data) {
    if (data?.schemaVersion !== 1 || !Array.isArray(data.merchants) || !Number.isSafeInteger(data.nextId) || data.nextId < 1 || data.nextId > 1000000) throw new Error('Le répertoire des enseignes est invalide. Restaurez le fichier enseignes.json dans Drive.');
    const ids = new Set();
    for (const item of data.merchants) {
      merchantId(item.id); merchantFields(item);
      if (ids.has(item.id) || item.id >= data.nextId) throw new Error('Le répertoire contient des identifiants incohérents. Vérifiez enseignes.json dans Drive.');
      ids.add(item.id);
    }
    return data;
  }
  function fileInfo(file) {
    if (!file.size) throw new Error('Ce fichier est vide.');
    if (file.size > MAX_SIZE) throw new Error('Ce fichier dépasse la limite de 25 Mo.');
    let extension = (file.name.split('.').pop() || '').toLowerCase();
    if (!TYPES[extension]) extension = Object.keys(TYPES).find(key => TYPES[key] === file.type);
    if (!extension) throw new Error('Choisissez une photo ou un PDF.');
    return { extension, mimeType: TYPES[extension] };
  }
  const queryEscape = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  class DriveError extends Error {
    constructor(status, detail = {}) {
      const reason = detail.error?.errors?.[0]?.reason || '';
      let message = `Google Drive a refusé la demande (${status}). Réessayez.`;
      if (status === 401) message = 'La connexion Google a expiré. Reconnectez-vous puis relancez l’envoi.';
      else if (status === 404) message = 'Le dossier est introuvable ou inaccessible. Vérifiez votre compte et la corbeille Drive, puis réessayez.';
      else if (reason === 'storageQuotaExceeded') message = 'Votre Google Drive est plein. Libérez de l’espace puis réessayez.';
      else if (status === 429 || /[Rr]ateLimit/.test(reason)) message = 'Google reçoit trop de demandes. Patientez un instant puis réessayez.';
      else if (status === 403) message = 'Accès Drive refusé. Vérifiez l’autorisation accordée à l’application et l’activation de Google Drive API.';
      else if (status >= 500) message = 'Google Drive est momentanément indisponible. Réessayez.';
      super(message); this.status = status;
    }
  }
  class Drive {
    constructor({ getToken, fetcher = (...args) => fetch(...args), onExpired = () => {} }) {
      this.getToken = getToken; this.fetcher = fetcher; this.onExpired = onExpired;
      this.folders = new Map();
    }
    async request(url, options = {}, allowed = []) {
      const token = this.getToken();
      if (!token) { this.onExpired(); throw new DriveError(401); }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      let response;
      try {
        response = await this.fetcher(url, { ...options, signal: controller.signal, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
      } catch (error) {
        throw new Error(error.name === 'AbortError' ? 'L’envoi a pris trop de temps. Votre ticket est conservé ; réessayez.' : 'Connexion interrompue. Votre ticket est conservé ; réessayez.');
      } finally { clearTimeout(timer); }
      if (response.status === 401) this.onExpired();
      if (!response.ok && !allowed.includes(response.status)) {
        let detail = {}; try { detail = await response.json(); } catch {}
        throw new DriveError(response.status, detail);
      }
      return response;
    }
    async account() {
      const data = await (await this.request(`${API}/about?fields=user(permissionId,emailAddress,displayName)`)).json();
      if (!data.user?.permissionId) throw new Error('Impossible d’identifier le compte Google. Reconnectez-vous.');
      return data.user;
    }
    async generatedId() {
      const data = await (await this.request(`${API}/files/generateIds?count=1&space=drive&type=files`)).json();
      if (!data.ids?.[0]) throw new Error('Google n’a pas fourni d’identifiant de fichier. Réessayez.');
      return data.ids[0];
    }
    async folder(name, parent = 'root') {
      const key = `${parent}/${name}`;
      if (this.folders.has(key)) return this.folders.get(key);
      const q = `name='${queryEscape(name)}' and mimeType='${FOLDER}' and '${queryEscape(parent)}' in parents and trashed=false`;
      const params = new URLSearchParams({ q, spaces: 'drive', fields: 'files(id)', orderBy: 'createdTime', pageSize: '100' });
      const data = await (await this.request(`${API}/files?${params}`)).json();
      let id = data.files?.[0]?.id;
      if (!id) {
        const folder = await (await this.request(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) })).json();
        id = folder.id;
      }
      if (!id) throw new Error('Impossible de créer le dossier Google Drive.');
      this.folders.set(key, id);
      return id;
    }
    async receiptFolder(month, rootId) {
      return this.folder(PENDING_NAME, await this.folder(month, rootId));
    }
    async catalogFiles() {
      const params = new URLSearchParams({ q: "appProperties has { key='ticketCatalog' and value='merchants-v1' } and trashed=false", spaces: 'drive', fields: 'nextPageToken,files(id,createdTime)', pageSize: '100' });
      const files = [];
      do {
        const data = await (await this.request(`${API}/files?${params}`, { cache: 'no-store' })).json();
        files.push(...(data.files || []));
        if (!data.nextPageToken) break;
        params.set('pageToken', data.nextPageToken);
      } while (true);
      return files.sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.id.localeCompare(b.id));
    }
    async readCatalog(id) {
      // L'ETag décrit la ressource File, pas la représentation alt=media.
      // Lire la révision désignée par ces métadonnées donne un contenu cohérent
      // sans envoyer cet ETag au téléchargement. Il reste utilisé à l'écriture.
      const url = `https://www.googleapis.com/drive/v2/files/${encodeURIComponent(id)}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        const metadata = await (await this.request(`${url}?fields=etag,labels,headRevisionId`, { cache: 'no-store' })).json();
        if (metadata.labels?.trashed || !metadata.etag) throw new Error('Le répertoire des enseignes est indisponible. Réessayez.');
        if (!metadata.headRevisionId) continue;
        const params = new URLSearchParams({ alt: 'media', revisionId: metadata.headRevisionId });
        const response = await this.request(`${url}?${params}`, { cache: 'no-store' }, [404]);
        if (response.status === 404) continue;
        return { id, etag: metadata.etag, data: validateCatalog(await response.json()) };
      }
      throw new Error('Impossible de lire une version stable du répertoire. Actualisez les enseignes puis réessayez.');
    }
    async catalog(create = false) {
      let files = await this.catalogFiles();
      if (!files.length && create) {
        const rootId = await this.folder(ROOT_NAME);
        const boundary = 'ticket_catalog_' + crypto.randomUUID();
        const metadata = { name: CATALOG_NAME, mimeType: 'application/json', parents: [rootId], appProperties: { ticketCatalog: 'merchants-v1' } };
        const data = { schemaVersion: 1, nextId: 1, merchants: [] };
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
        await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
        files = await this.catalogFiles();
        if (!files.length) throw new Error('Le répertoire est en cours de création. Réessayez dans un instant.');
      }
      if (!files.length) return null;
      const catalogs = [];
      for (const file of files) catalogs.push(await this.readCatalog(file.id));
      const populated = catalogs.filter(catalog => catalog.data.merchants.length);
      // Deux initialisations simultanées peuvent laisser un fichier vide ; il est ignoré.
      // Ne jamais fusionner silencieusement deux répertoires contenant des IDs déjà attribués.
      if (populated.length > 1) throw new Error('Plusieurs répertoires d’enseignes existent dans Drive. Conservez le répertoire de référence avant de continuer.');
      return populated[0] || catalogs[0];
    }
    async merchants() { return (await this.catalog())?.data.merchants || []; }
    async createMerchant(fields) {
      const details = merchantFields(fields);
      for (let attempt = 0; attempt < 5; attempt++) {
        const catalog = await this.catalog(true);
        const existing = catalog.data.merchants.find(item => ['name', 'address', 'vatNumber'].every(key => normalize(item[key]) === normalize(details[key])));
        if (existing) return existing; // Réponse perdue : la nouvelle tentative retrouve la même fiche.
        if (catalog.data.nextId > 999999) throw new Error('Les 999 999 identifiants disponibles ont été attribués.');
        const merchant = { id: catalog.data.nextId, ...details, createdAt: new Date().toISOString() };
        const data = { ...catalog.data, nextId: merchant.id + 1, merchants: [...catalog.data.merchants, merchant] };
        const response = await this.request(`https://www.googleapis.com/upload/drive/v2/files/${encodeURIComponent(catalog.id)}?uploadType=media&fields=id`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': catalog.etag }, body: JSON.stringify(data) }, [412]);
        if (response.status !== 412) return merchant;
      }
      throw new Error('Une autre création est en cours. Réessayez dans un instant.');
    }
    async findUploaded(item) {
      const response = await this.request(`${API}/files/${encodeURIComponent(item.driveId)}?fields=id,name,size,trashed,parents,appProperties`, {}, [404]);
      if (response.status === 404) return null;
      const remote = await response.json();
      if (remote.trashed) throw new Error('Ce ticket est dans la corbeille Drive. Restaurez-le avant de réessayer.');
      if (Number(remote.size) !== item.size || remote.appProperties?.receiptId !== item.id) throw new Error('Le fichier distant ne correspond pas au ticket attendu. Vérifiez-le dans Drive.');
      if (remote.appProperties?.merchantId && remote.appProperties.merchantId !== String(item.merchantId)) throw new Error('Ce ticket est déjà lié à une autre enseigne dans Drive.');
      if (!remote.appProperties?.merchantId) {
        // Migration d'un ancien envoi confirmé dont la réponse avait été perdue.
        const params = new URLSearchParams({ fields: 'id,name,size', addParents: item.folderId });
        const oldParents = (remote.parents || []).filter(id => id !== item.folderId);
        if (oldParents.length) params.set('removeParents', oldParents.join(','));
        if (remote.parents?.includes(item.folderId)) params.delete('addParents');
        return (await this.request(`${API}/files/${encodeURIComponent(item.driveId)}?${params}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: item.name, appProperties: { receiptId: item.id, merchantId: String(item.merchantId) } }) })).json();
      }
      return remote;
    }
    validSession(url) {
      try { const parsed = new URL(url); return parsed.origin === 'https://www.googleapis.com' && parsed.pathname.startsWith('/upload/drive/v3/files'); }
      catch { return false; }
    }
    async upload(item, persist, progress = () => {}) {
      merchantId(item.merchantId);
      // Identifiant fixé et enregistré avant toute création : une réponse perdue ne duplique pas le ticket.
      if (!item.driveId) { item.driveId = await this.generatedId(); await persist(item); }
      const existing = await this.findUploaded(item);
      if (existing) return existing;
      let offset = 0;
      if (item.sessionUrl && this.validSession(item.sessionUrl)) {
        const status = await this.request(item.sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${item.size}` }, body: new Blob([]) }, [308, 404, 410]);
        if (status.ok) return status.json();
        if (status.status === 308) offset = this.nextOffset(status, item.size);
        else { item.sessionUrl = null; await persist(item); }
      } else item.sessionUrl = null;
      if (!item.sessionUrl) {
        const metadata = { id: item.driveId, name: item.name, mimeType: item.mimeType, parents: [item.folderId], appProperties: { receiptId: item.id, merchantId: String(item.merchantId) } };
        const response = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': item.mimeType, 'X-Upload-Content-Length': String(item.size) }, body: JSON.stringify(metadata) }, [409]);
        if (response.status === 409) {
          const remote = await this.findUploaded(item);
          if (remote) return remote;
          throw new Error('L’envoi précédent est encore en cours. Réessayez dans un instant.');
        }
        const sessionUrl = response.headers.get('Location');
        if (!this.validSession(sessionUrl)) throw new Error('Google n’a pas fourni d’adresse d’envoi valide. Réessayez.');
        item.sessionUrl = sessionUrl; await persist(item);
      }
      const chunkSize = 1024 * 1024; // Multiple de 256 Ko, requis par Drive.
      while (offset < item.size) {
        progress(Math.floor(offset / item.size * 100));
        const end = Math.min(offset + chunkSize, item.size);
        const response = await this.request(item.sessionUrl, { method: 'PUT', headers: { 'Content-Type': item.mimeType, 'Content-Range': `bytes ${offset}-${end - 1}/${item.size}` }, body: item.blob.slice(offset, end) }, [308]);
        if (response.ok) return response.json();
        const next = this.nextOffset(response, item.size);
        if (next <= offset) throw new Error('L’envoi n’a pas progressé. Votre ticket est conservé ; réessayez.');
        offset = next;
      }
      const remote = await this.findUploaded(item);
      if (!remote) throw new Error('La confirmation Drive n’est pas encore disponible. Réessayez.');
      return remote;
    }
    nextOffset(response, size) {
      const range = response.headers.get('Range');
      if (!range) return 0;
      const match = /^bytes=0-(\d+)$/i.exec(range);
      const next = match ? Number(match[1]) + 1 : NaN;
      if (!Number.isSafeInteger(next) || next < 0 || next > size) throw new Error('Réponse d’envoi Google invalide. Réessayez.');
      return next;
    }
  }
  const exports = { naming, merchantId, merchantFields, filterMerchants, validateCatalog, fileInfo, queryEscape, DriveError, Drive, ROOT_NAME, PENDING_NAME, MAX_SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  else root.TicketCore = exports;
})(globalThis);
