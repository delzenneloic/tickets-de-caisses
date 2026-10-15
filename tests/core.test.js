'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { naming, merchantId, merchantFields, filterMerchants, validateCatalog, Drive, fileInfo } = require('../core');
const details = { name: 'Café du Centre', address: 'Rue du Centre 12, Namur', vatNumber: 'BE 0123.456.789' };
const entry = { id: 1, ...details };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const makeDrive = fetcher => new Drive({ getToken: () => 'test-only', fetcher });
const catalog = merchants => ({ schemaVersion: 1, nextId: Math.max(0, ...merchants.map(item => item.id)) + 1, merchants });
function registryServer() {
  let data = catalog([]), version = 1, writes = 0, conflict = false, lost = false;
  const fetcher = async (url, options) => {
    if (url.includes('/drive/v3/files?')) return json({ files: [{ id: 'catalog', createdTime: '2026-10-15T00:00:00Z' }] });
    if (options.method === 'PUT') {
      if (conflict) { conflict = false; data = catalog([{ ...entry, name: 'Autre magasin' }]); version++; }
      if (options.headers['If-Match'] !== String(version)) return json({}, 412);
      data = JSON.parse(options.body); version++; writes++;
      if (lost) { lost = false; throw new TypeError('connection lost'); }
      return json({ id: 'catalog' });
    }
    if (url.includes('alt=media')) return options.headers['If-Match'] === String(version) ? json(data) : json({}, 412);
    return json({ etag: String(version), labels: { trashed: false } });
  };
  return { fetcher, get data() { return data; }, get writes() { return writes; }, conflict() { conflict = true; }, loseResponse() { lost = true; } };
}
test('nom : préfixe sur six chiffres et date locale du premier envoi', () => {
  assert.deepEqual(naming(new Date(2026, 8, 12, 9, 15, 30, 398), 'jpg', 42), { month: '2026.09', stamp: '2026.09.12.091530.398', name: '000042.2026.09.12.091530.398.jpg' });
  assert.equal(merchantId(999999), '999999');
  for (const id of [0, -1, 1.5, '42', 1000000, undefined]) assert.throws(() => merchantId(id));
});
test('recherche par sous-chaîne, sans casse ni accents ; homonymes conservés', () => {
  const list = [entry, { id: 2, ...details, address: 'Autre adresse' }, { id: 3, name: 'Restaurant' }];
  assert.deepEqual(filterMerchants(list, 'FÉ DU').map(item => item.id), [1, 2]);
  assert.equal(filterMerchants(list, 'introuvable').length, 0);
});
test('création : nom, adresse et TVA obligatoires et nettoyés', () => {
  assert.equal(merchantFields({ ...details, name: ' Café ' }).name, 'Café');
  for (const key of Object.keys(details)) assert.throws(() => merchantFields({ ...details, [key]: '   ' }));
});
test('répertoire corrompu : aucun écrasement ni réemploi d’identifiant', () => {
  assert.throws(() => validateCatalog({ ...catalog([entry]), nextId: 1 }));
  assert.throws(() => validateCatalog(catalog([entry, entry])));
  assert.throws(() => validateCatalog({ schemaVersion: 2, nextId: 1, merchants: [] }));
});
test('destination : mois / A traiter, puis réutilisation des dossiers', async () => {
  const created = [];
  const drive = makeDrive(async (url, options) => {
    if (options.method === 'POST') { const data = JSON.parse(options.body); created.push(data); return json({ id: 'folder' + created.length }); }
    return json({ files: [] });
  });
  assert.equal(await drive.receiptFolder('2026.10', 'root-folder'), 'folder2');
  assert.equal(await drive.receiptFolder('2026.10', 'root-folder'), 'folder2');
  assert.deepEqual(created.map(item => [item.name, item.parents[0]]), [['2026.10', 'root-folder'], ['A traiter', 'folder1']]);
});
test('répertoire partagé entre deux clients ; identifiants séquentiels', async () => {
  const server = registryServer(), first = makeDrive(server.fetcher), second = makeDrive(server.fetcher);
  assert.equal((await first.createMerchant(details)).id, 1);
  assert.equal((await second.merchants())[0].name, details.name);
  assert.equal((await second.createMerchant({ ...details, address: 'Autre rue' })).id, 2);
  assert.equal((await first.merchants()).length, 2);
});
test('créations concurrentes : conflit 412, relecture, nouvel entier', async () => {
  const server = registryServer(); server.conflict();
  assert.equal((await makeDrive(server.fetcher).createMerchant(details)).id, 2);
  assert.deepEqual(server.data.merchants.map(item => item.id), [1, 2]);
});
test('création confirmée mais réponse perdue : réessayer retrouve la fiche', async () => {
  const server = registryServer(), drive = makeDrive(server.fetcher); server.loseResponse();
  await assert.rejects(drive.createMerchant(details));
  assert.equal((await drive.createMerchant(details)).id, 1);
  assert.equal(server.writes, 1);
});
test('pagination : toutes les pages du répertoire sont inspectées', async () => {
  const drive = makeDrive(async url => new URL(url).searchParams.has('pageToken') ? json({ files: [{ id: 'b', createdTime: '2026-02' }] }) : json({ files: [{ id: 'a', createdTime: '2026-01' }], nextPageToken: 'next' }));
  assert.equal((await drive.catalogFiles()).length, 2);
});
test('upload : refus sans enseigne avant toute requête réseau', async () => {
  let called = false;
  await assert.rejects(makeDrive(async () => { called = true; }).upload({}, async () => {}), /enseigne/);
  assert.equal(called, false);
});
test('upload : métadonnée merchantId, ID Drive persistant et fichier préfixé', async () => {
  const saved = [], requests = [];
  const item = { id: 'receipt', merchantId: 42, ...naming(new Date(2026, 9, 15), 'pdf', 42), folderId: 'pending', mimeType: 'application/pdf', size: 3, blob: new Blob(['abc']) };
  const drive = makeDrive(async (url, options) => {
    requests.push({ url, options });
    if (url.includes('generateIds')) return json({ ids: ['drive-ticket'] });
    if (url.includes('/drive/v3/files/drive-ticket')) return json({}, 404);
    if (options.method === 'POST') return new Response(null, { status: 200, headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc' } });
    return json({ id: 'drive-ticket', size: '3', name: item.name });
  });
  const result = await drive.upload(item, async value => saved.push(structuredClone(value)));
  assert.equal(result.id, 'drive-ticket');
  const metadata = JSON.parse(requests.find(request => request.options.method === 'POST').options.body);
  assert.equal(metadata.appProperties.merchantId, '42'); assert.equal(metadata.name, item.name); assert.deepEqual(metadata.parents, ['pending']);
  assert.equal(saved[0].driveId, 'drive-ticket');
});
test('ancien envoi déjà reçu : migration dans A traiter sans recréer le fichier', async () => {
  let patch;
  const drive = makeDrive(async (url, options) => {
    if (options.method === 'PATCH') { patch = { url: new URL(url), body: JSON.parse(options.body) }; return json({ id: 'old', size: '3' }); }
    return json({ id: 'old', size: '3', name: 'ancien.pdf', parents: ['month'], appProperties: { receiptId: 'receipt' } });
  });
  await drive.upload({ id: 'receipt', driveId: 'old', size: 3, merchantId: 42, folderId: 'pending', name: '000042.ancien.pdf' }, async () => {});
  assert.equal(patch.url.searchParams.get('addParents'), 'pending'); assert.equal(patch.url.searchParams.get('removeParents'), 'month');
  assert.equal(patch.body.appProperties.merchantId, '42');
});
test('reprise : une enseigne distante différente bloque toute réaffectation', async () => {
  const drive = makeDrive(async () => json({ id: 'old', size: '3', appProperties: { receiptId: 'receipt', merchantId: '1' } }));
  await assert.rejects(drive.upload({ id: 'receipt', driveId: 'old', size: 3, merchantId: 2 }, async () => {}), /autre enseigne/);
});
test('fichiers : contrôles de taille et formats conservés', () => {
  assert.throws(() => fileInfo({ name: 'a.pdf', size: 0 }));
  assert.throws(() => fileInfo({ name: 'a.pdf', size: 26 * 1024 * 1024 }));
  assert.throws(() => fileInfo({ name: 'a.exe', size: 10, type: 'application/octet-stream' }));
  assert.equal(fileInfo({ name: 'a.pdf', size: 10 }).mimeType, 'application/pdf');
});
