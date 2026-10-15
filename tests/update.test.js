'use strict';
// Régression réelle du cycle de vie Service Worker, sans compte ni envoi Google.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const oldCommit = '5565d234d404be5c5371e725160bcf9d4da189b6';
const version = '2026.10.15.3';
const nextVersion = '2026.10.15.4';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
let release = 'old', browser, failAsset = false;
const oldFiles = new Map();
const server = createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, 'http://localhost');
    const name = parsed.pathname === '/' ? 'index.html' : parsed.pathname.slice(1);
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) throw new Error('path');
    if (failAsset && name === 'core.js') { res.writeHead(503); res.end(); return; }
    let body;
    if (release === 'old') {
      if (!oldFiles.has(name)) oldFiles.set(name, execFileSync(process.env.GIT_BIN || 'git', ['show', oldCommit + ':' + name], { cwd: root }));
      body = oldFiles.get(name);
    } else {
      body = await fs.readFile(file);
      if (release === 'next' && ['.html', '.js'].includes(path.extname(file))) body = body.toString().replaceAll(version, nextVersion);
    }
    res.setHeader('Content-Type', types[path.extname(file)] || 'text/plain');
    res.setHeader('Cache-Control', 'no-store'); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  await context.route('https://accounts.google.com/**', route => route.abort());
  const oldTab = await context.newPage();
  await oldTab.goto(url);
  await oldTab.waitForFunction(() => !!navigator.serviceWorker.controller);
  await oldTab.locator('#files-input').setInputFiles({ name: 'ticket-a-conserver.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test migration') });
  await oldTab.waitForFunction(() => document.getElementById('queue-count').textContent === '1');
  assert.equal(await oldTab.locator('#merchant-search').count(), 0);
  console.log('PASS ancienne version v1 réellement installée, avec un ticket local en attente');

  // Reproduit le bug : v1 sert encore l'ancien HTML après publication, même
  // si les fichiers réseau ont changé. Le lien et les assets versionnés en sortent.
  release = 'current';
  const freshTab = await context.newPage();
  await freshTab.goto(url + '?v=' + version);
  await freshTab.locator('#merchant-search').waitFor();
  assert.match(await freshTab.locator('.destination').textContent(), /A traiter/);
  await freshTab.waitForFunction(() => document.getElementById('queue-count').textContent === '1');
  await freshTab.waitForFunction(() => document.getElementById('update-status').textContent.includes('dernière version'));
  assert.equal(await oldTab.locator('#merchant-search').count(), 0, 'aucun rechargement imposé à un onglet existant');
  assert.equal(await freshTab.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting), null);
  console.log('PASS migration depuis le cache v1 sans fermer les onglets, sans mélange de scripts et sans perdre le ticket');

  await oldTab.reload();
  await oldTab.locator('#merchant-search').waitFor();
  await oldTab.waitForFunction(() => document.getElementById('queue-count').textContent === '1');
  await context.setOffline(true);
  await freshTab.reload();
  await freshTab.locator('#merchant-search').waitFor();
  assert.equal(await freshTab.locator('#queue-count').textContent(), '1');
  await context.setOffline(false);
  console.log('PASS adresse habituelle et lien versionné utilisables hors ligne après migration');

  // Une installation incomplète ne doit pas remplacer la dernière version valide.
  release = 'next'; failAsset = true;
  await freshTab.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const failed = new Promise(resolve => registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker.addEventListener('statechange', () => { if (worker.state === 'redundant') resolve(); });
    }, { once: true }));
    await registration.update(); await failed;
  });
  await freshTab.reload();
  assert.equal(await freshTab.locator('#app-version').textContent(), version);
  failAsset = false;
  console.log('PASS échec de téléchargement : la version fonctionnelle reste active');

  // L'onglet et une saisie non enregistrée survivent au changement de contrôleur.
  await freshTab.evaluate(() => document.getElementById('merchant-dialog').showModal());
  await freshTab.locator('#merchant-name').fill('Fiche non enregistrée');
  await freshTab.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await freshTab.waitForFunction(() => !document.getElementById('update-notice').hidden);
  assert.equal(await freshTab.locator('#app-version').textContent(), version);
  assert.equal(await freshTab.locator('#merchant-name').inputValue(), 'Fiche non enregistrée');
  // Couvre la garde même si une activation clavier/script atteint le bouton.
  await freshTab.evaluate(() => document.getElementById('apply-update').click());
  assert.match(await freshTab.locator('#update-help').textContent(), /fermez la fiche/);
  await freshTab.locator('#cancel-merchant').click();
  await freshTab.locator('#apply-update').click();
  await freshTab.waitForFunction(v => document.getElementById('app-version')?.textContent === v, nextVersion);
  await freshTab.waitForFunction(() => document.getElementById('queue-count').textContent === '1');
  const draft = await freshTab.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open('tickets-de-caisses:/', 1); r.onsuccess = () => resolve(r.result); });
    const items = await new Promise(resolve => { const r = db.transaction('receipts').objectStore('receipts').getAll(); r.onsuccess = () => resolve(r.result); });
    db.close(); return { name: items[0].originalName, body: await items[0].blob.text() };
  });
  assert.deepEqual(draft, { name: 'ticket-a-conserver.pdf', body: '%PDF-1.4 test migration' });
  console.log('PASS mise à jour suivante signalée, saisie préservée, rechargement choisi et contenu du ticket intact');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
