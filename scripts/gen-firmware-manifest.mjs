#!/usr/bin/env node
// Scan assets/firmware/ for bundled firmware and write manifest.json. The
// launcher can't list a directory at runtime (static hosts serve files, not
// listings), so this manifest is how the browser discovers what's available.
//
// Drop a versioned .uf2 into assets/firmware/ named "<family>.v<version>.uf2"
// (e.g. gblink.v2.1.2.uf2), run `node scripts/gen-firmware-manifest.mjs`, and
// commit. No hand-editing of JSON needed.

import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIRMWARE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'firmware');
const MANIFEST = join(FIRMWARE_DIR, 'manifest.json');

// "gblink.v2.1.2.uf2" -> { family: "gblink", version: "2.1.2" }
const FILENAME_RE = /^(.+?)\.v?(\d+\.\d+\.\d+)\.uf2$/i;

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
}

const byFamily = {};
for (const file of readdirSync(FIRMWARE_DIR)) {
    const match = FILENAME_RE.exec(file);
    if (!match) continue;
    const [, family, version] = match;
    (byFamily[family] ??= []).push({ version, uf2: `assets/firmware/${file}` });
}

// Newest first, so the launcher can take [0] as the default to install.
for (const family of Object.keys(byFamily)) {
    byFamily[family].sort((a, b) => compareVersions(b.version, a.version));
}

writeFileSync(MANIFEST, JSON.stringify(byFamily, null, 2) + '\n');

const summary = Object.entries(byFamily)
    .map(([f, list]) => `${f}: ${list.map(r => r.version).join(', ')}`)
    .join(' | ');
console.log(`Wrote ${MANIFEST}\n  ${summary || '(no firmware files found)'}`);
