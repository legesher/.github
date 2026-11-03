'use strict';

// Fetches every link in the given folders' Markdown files and fails on any
// that doesn't resolve. Usage: node check-links.js <folder> [<folder> ...]

const fs = require('fs');
const path = require('path');

const LINK = /\]\((https?:\/\/[^)\s]+)\)/g;

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

function linksIn(text) {
  return [...text.matchAll(LINK)].map((match) => match[1]);
}

async function resolves(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const response = await fetch(url, { method, redirect: 'follow' });
      if (response.ok) return true;
      if (method === 'GET') return false;
    } catch {
      if (method === 'GET') return false;
    }
  }
  return false;
}

async function main(dirs) {
  const found = new Map();
  for (const dir of dirs) {
    for (const file of markdownFiles(dir)) {
      for (const url of linksIn(fs.readFileSync(file, 'utf8'))) {
        const target = url.split('#')[0];
        if (!found.has(target)) found.set(target, []);
        found.get(target).push(file);
      }
    }
  }
  let dead = 0;
  for (const [url, files] of found) {
    if (await resolves(url)) continue;
    dead += 1;
    console.error(`Dead link ${url} in ${[...new Set(files)].join(', ')}`);
  }
  console.log(`Checked ${found.size} links, ${dead} dead.`);
  if (dead > 0) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { linksIn, markdownFiles };
