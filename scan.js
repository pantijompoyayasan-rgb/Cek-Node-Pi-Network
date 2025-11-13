#!/usr/bin/env node
'use strict';

const fs = require('fs').promises;
const path = require('path');

const DEFAULT_PORT = 31401;
const SERVERS_FILE = 'servers.txt';
const WALLETS_FILE = 'wallets.txt';
const TIMEOUT_MS = 7000;

function buildUrl(server, wallet) {
  const host = server.includes(':') ? server : `${server}:${DEFAULT_PORT}`;
  return `http://${host}/claimable_balances?claimant=${encodeURIComponent(wallet)}`;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function checkUrl(url) {
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    if (!res.ok) return { status: 'novalid', details: `HTTP ${res.status}` };
    const text = await res.text();
    if (text.includes('_embedded') && text.includes('records')) {
      try {
        const j = JSON.parse(text);
        if (j && j._embedded && Array.isArray(j._embedded.records) && j._embedded.records.length > 0) {
          const r = j._embedded.records[0];
          if (r.asset && r.amount) return { status: 'valid', details: `amount=${r.amount}` };
        }
        return { status: 'novalid', details: 'json but structure mismatch' };
      } catch {
        return { status: 'novalid', details: 'non-json response' };
      }
    } else {
      return { status: 'novalid', details: 'no _embedded/records in response' };
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return { status: 'timeout', details: 'fetch timeout' };
    return { status: 'timeout', details: err.message || String(err) };
  }
}

async function main() {
  console.log('=== Pi Mainnet Node Checker (serial) ===');
  console.log(`Default port: ${DEFAULT_PORT}`);
  console.log(`Timeout per request: ${TIMEOUT_MS} ms\n`);

  // baca file
  let serversRaw, walletsRaw;
  try {
    serversRaw = await fs.readFile(path.resolve(SERVERS_FILE), 'utf8');
  } catch {
    console.error(`❌ Tidak menemukan ${SERVERS_FILE} di folder ini.`);
    process.exit(1);
  }
  try {
    walletsRaw = await fs.readFile(path.resolve(WALLETS_FILE), 'utf8');
  } catch {
    console.error(`❌ Tidak menemukan ${WALLETS_FILE} di folder ini.`);
    process.exit(1);
  }

  const servers = serversRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const wallets = walletsRaw.split(/\r?\n/).map(w => w.trim()).filter(Boolean);

  if (servers.length === 0) { console.error('❌ servers.txt kosong'); process.exit(1); }
  if (wallets.length === 0) { console.error('❌ wallets.txt kosong'); process.exit(1); }

  console.log(`Memeriksa ${servers.length} server × ${wallets.length} wallet(s) secara serial...\n`);

  // baca daftar valid yang sudah ada untuk mencegah duplikat
  let validList = [];
  try {
    const existing = await fs.readFile('valid.txt', 'utf8');
    validList = existing.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  } catch {
    // kalau belum ada file, abaikan
  }

  // kosongkan file lain
  await Promise.all([
    fs.writeFile('novalid.txt', ''),
    fs.writeFile('timeout.txt', '')
  ]);

  const stats = { valid: 0, novalid: 0, timeout: 0 };

  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    console.log(`[#${i + 1}/${servers.length}] ${server}`);

    // lewati jika sudah ada di valid.txt
    if (validList.includes(server)) {
      console.log(`  ⚙️  Lewati (sudah ada di valid.txt)\n`);
      continue;
    }

    let serverHadValid = false;

    for (let j = 0; j < wallets.length; j++) {
      const wallet = wallets[j];
      const url = buildUrl(server, wallet);
      process.stdout.write(`  - testing wallet ${j + 1}/${wallets.length} (${wallet}) ... `);

      const result = await checkUrl(url);

      if (result.status === 'valid') {
        console.log(`✅ VALID (${result.details})`);
        await fs.appendFile('valid.txt', `${server}\n`);
        validList.push(server); // tambahkan ke list agar tidak duplikat saat runtime
        stats.valid++;
        serverHadValid = true;
        break;
      } else if (result.status === 'novalid') {
        console.log(`⚠️  NO-VALID (${result.details})`);
        await fs.appendFile('novalid.txt', `${server}|${wallet}|${result.details}\n`);
        stats.novalid++;
      } else {
        console.log(`⌛ TIMEOUT/ERR (${result.details})`);
        await fs.appendFile('timeout.txt', `${server}|${result.details}\n`);
        stats.timeout++;
      }
    }

    if (!serverHadValid) {
      console.log(`  -> selesai server ${server} (tidak ada wallet valid)\n`);
    } else {
      console.log(`  -> ditemukan wallet valid untuk server ${server}\n`);
    }
  }

  console.log('=== Selesai ===');
  console.log(`Valid: ${stats.valid}, No-Valid: ${stats.novalid}, Timeout: ${stats.timeout}`);
  console.log('File hasil: valid.txt, novalid.txt, timeout.txt');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
