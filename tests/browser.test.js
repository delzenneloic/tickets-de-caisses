'use strict';
// Tests de bout en bout locaux : aucun compte Google ni fichier réel n'est utilisé.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('path');
    res.setHeader('Content-Type', types[path.extname(file)] || 'text/plain'); res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
let browser;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'block', hasTouch: true, viewport: { width: 1180, height: 950 } });
  let catalog = null, version = 1, counter = 0, failUpload = false, currentAccount = 'account-a';
  const folders = [], uploads = new Map(), sessions = new Map(), errors = [];
  await context.route('https://accounts.google.com/gsi/client', route => route.fulfill({ contentType: 'text/javascript', body: `window.google={accounts:{oauth2:{hasGrantedAllScopes:()=>true,initTokenClient:config=>({requestAccessToken:()=>config.callback({access_token:'mock',expires_in:3600})})}}};` }));
  await context.route('https://www.googleapis.com/**', async route => {
    const req = route.request(), parsed = new URL(req.url()), method = req.method();
    const reply = (body, status = 200, headers = {}) => route.fulfill({ status, headers: { 'Access-Control-Expose-Headers': 'Location, Range', ...headers }, contentType: 'application/json', body: JSON.stringify(body) });
    if (parsed.pathname.endsWith('/about')) return reply({ user: { permissionId: currentAccount, emailAddress: currentAccount + '@example.test' } });
    if (parsed.pathname.endsWith('/generateIds')) return reply({ ids: ['ticket-' + ++counter] });
    if (parsed.pathname === '/drive/v3/files' && method === 'GET') {
      const q = parsed.searchParams.get('q');
      if (q.includes('ticketCatalog')) return reply({ files: catalog && currentAccount === 'account-a' ? [{ id: 'catalog', createdTime: '2026-10-15T00:00:00Z' }] : [] });
      const name = /name='([^']+)'/.exec(q)?.[1], parent = /'([^']+)' in parents/.exec(q)?.[1];
      return reply({ files: folders.filter(file => file.name === name && file.parents.includes(parent)) });
    }
    if (parsed.pathname === '/drive/v3/files' && method === 'POST') {
      const file = { ...req.postDataJSON(), id: 'folder-' + ++counter }; folders.push(file); return reply(file);
    }
    if (parsed.pathname === '/upload/drive/v3/files' && parsed.searchParams.get('uploadType') === 'multipart') {
      const parts = req.postData().split('\r\n\r\n'); catalog = JSON.parse(parts[2].split('\r\n--')[0]); return reply({ id: 'catalog' });
    }
    if (parsed.pathname === '/drive/v2/files/catalog') {
      if (parsed.searchParams.get('alt') === 'media') {
        if (req.headers()['if-match']) return reply({}, 412);
        if (parsed.searchParams.has('revisionId')) return route.abort('failed');
        return reply(catalog);
      }
      return reply({ etag: String(version), headRevisionId: 'revision-' + version, labels: { trashed: false } });
    }
    if (parsed.pathname === '/upload/drive/v2/files/catalog') {
      if (req.headers()['if-match'] !== String(version)) return reply({}, 412);
      catalog = req.postDataJSON(); version++; return reply({ id: 'catalog' });
    }
    if (parsed.pathname.startsWith('/drive/v3/files/ticket-')) {
      const item = uploads.get(parsed.pathname.split('/').pop()); return item ? reply(item) : reply({}, 404);
    }
    if (parsed.searchParams.get('uploadType') === 'resumable' && method === 'POST') {
      const item = req.postDataJSON(); sessions.set(item.id, item);
      return reply({}, 200, { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=' + item.id });
    }
    if (parsed.searchParams.has('upload_id')) {
      const id = parsed.searchParams.get('upload_id');
      if (failUpload) { failUpload = false; return route.abort('internetdisconnected'); }
      if (req.headers()['content-range'].startsWith('bytes */')) return uploads.has(id) ? reply(uploads.get(id)) : reply({}, 308);
      const item = { ...sessions.get(id), size: req.headers()['content-range'].split('/')[1] }; uploads.set(id, item); return reply(item);
    }
    throw new Error(`Requête non simulée : ${method} ${parsed}`);
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const connect = async page => { await page.locator('#connect').click(); await page.waitForFunction(() => !document.getElementById('merchant-search').disabled); };
  await page.goto(url); await page.waitForFunction(() => !document.getElementById('files-button').disabled);
  await page.locator('#files-input').setInputFiles({ name: 'ticket.pdf', mimeType: 'application/pdf', buffer: Buffer.from('abc') });
  await page.waitForFunction(() => document.getElementById('queue-count').textContent === '1');
  assert.equal(await page.locator('#send').isDisabled(), true);
  await connect(page); assert.equal(await page.locator('#send').isDisabled(), true);
  await page.locator('#merchant-search').fill('Café du Centre'); await page.locator('#new-merchant').click();
  assert.equal(await page.locator('#merchant-name').inputValue(), 'Café du Centre');
  await page.locator('#merchant-address').fill('Rue du Centre 12, Namur');
  await page.locator('#merchant-vat').fill('BE 0123.456.789'); await page.locator('#save-merchant').click();
  await page.waitForFunction(() => !document.getElementById('merchant-dialog').open);
  assert.equal(catalog.merchants[0].id, 1); assert.equal(await page.locator('#send').isEnabled(), true);
  console.log('PASS création Drive, champs, sélection automatique et envoi obligatoire');
  await page.locator('#merchant-search').fill('FE DU');
  assert.equal(await page.locator('#merchant-options [role=option]').count(), 1); assert.equal(await page.locator('#send').isDisabled(), true);
  await page.locator('#merchant-search').press('ArrowDown'); await page.locator('#merchant-search').press('Enter');
  assert.equal(await page.locator('#send').isEnabled(), true);
  console.log('PASS recherche par sous-chaîne et sélection au clavier');
  failUpload = true; await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#queue-list .ticket-error')?.textContent.includes('Connexion interrompue')).catch(async error => { console.log(await page.locator('main').innerText()); throw error; });
  const pendingName = await page.locator('.ticket-detail').first().textContent();
  assert.equal(uploads.size, 0);
  await page.reload(); await connect(page);
  await page.locator('#new-merchant').click(); await page.locator('#merchant-name').fill('Autre restaurant');
  await page.locator('#merchant-address').fill('Rue de Test 2'); await page.locator('#merchant-vat').fill('BE 0987.654.321');
  await page.locator('#save-merchant').click(); await page.waitForFunction(() => !document.getElementById('merchant-dialog').open);
  assert.equal(catalog.merchants[1].id, 2); // Une autre sélection ne doit pas réaffecter le ticket interrompu.
  await page.locator('#send').click(); await page.waitForFunction(() => document.getElementById('queue-count').textContent === '0');
  assert.equal(uploads.size, 1); const uploaded = [...uploads.values()][0];
  assert.match(uploaded.name, /^000001\.\d{4}\.\d{2}\.\d{2}\.\d{6}\.\d{3}\.pdf$/);
  assert.ok(pendingName.includes(uploaded.name)); assert.equal(uploaded.appProperties.merchantId, '1');
  const pendingFolder = folders.find(folder => folder.id === uploaded.parents[0]); assert.equal(pendingFolder.name, 'A traiter');
  assert.match(folders.find(folder => folder.id === pendingFolder.parents[0]).name, /^\d{4}\.\d{2}$/);
  console.log('PASS coupure, rechargement, reprise sans doublon, enseigne initiale et destination');
  await page.locator('#tab-history').click(); assert.equal(await page.locator('#history-list .ticket').count(), 1);
  await page.locator('#tab-add').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#merchant-search').fill('du');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results/mobile.png'), fullPage: true });
  await page.locator('#merchant-options [role=option]').tap();
  assert.equal(await page.locator('#merchant-search').inputValue(), 'Café du Centre');
  console.log('PASS historique et affichage mobile sans débordement');
  const otherPage = await context.newPage(); await otherPage.goto(url); await connect(otherPage);
  await otherPage.locator('#merchant-search').fill('centre'); assert.equal(await otherPage.locator('#merchant-options [role=option]').count(), 1);
  console.log('PASS répertoire retrouvé dans une nouvelle session');
  await page.locator('#connect').click(); currentAccount = 'account-b'; await connect(page);
  assert.equal(await page.locator('#merchant-search').inputValue(), '');
  await page.locator('#merchant-search').fill('centre'); assert.equal(await page.locator('#merchant-options [role=option]').count(), 0);
  console.log('PASS isolation des enseignes entre comptes Google');
  assert.deepEqual(errors, []);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
