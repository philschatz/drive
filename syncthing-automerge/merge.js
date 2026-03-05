#!/usr/bin/env node

const Automerge = require('@automerge/automerge');
const fs = require('fs');
const path = require('path');

const CONFLICT_RE = /^(.+)\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+\.automerge$/;

function log(message) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${message}\n`);
}

function mergeConflict(conflictPath, originalPath) {
  const conflictData = fs.readFileSync(conflictPath);
  const originalData = fs.readFileSync(originalPath);

  const conflictDoc = Automerge.load(new Uint8Array(conflictData));
  const originalDoc = Automerge.load(new Uint8Array(originalData));

  const merged = Automerge.merge(originalDoc, conflictDoc);

  fs.writeFileSync(originalPath, Automerge.save(merged));
  fs.unlinkSync(conflictPath);

  log(`merged ${path.basename(conflictPath)} -> ${path.basename(originalPath)}`);
}

const dataDir = process.argv[2];

if (!dataDir) {
  console.error('usage: merge.js <directory>');
  process.exit(1);
}

if (!fs.existsSync(dataDir)) {
  console.error(`directory does not exist: ${dataDir}`);
  process.exit(1);
}

const files = fs.readdirSync(dataDir);
let merged = 0;

for (const file of files) {
  const match = file.match(CONFLICT_RE);
  if (!match) continue;

  const baseName = match[1] + '.automerge';
  const conflictPath = path.join(dataDir, file);
  const originalPath = path.join(dataDir, baseName);

  if (!fs.existsSync(originalPath)) {
    fs.renameSync(conflictPath, originalPath);
    log(`renamed ${file} -> ${baseName} (no original)`);
    merged++;
    continue;
  }

  try {
    mergeConflict(conflictPath, originalPath);
    merged++;
  } catch (err) {
    log(`error merging ${file}: ${err}`);
  }
}

log(`done — ${merged} conflict${merged !== 1 ? 's' : ''} resolved`);
