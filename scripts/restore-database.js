// Run only while ME-AI is stopped. Never prints user data.
process.umask(0o077);
const fs = require('node:fs');
const path = require('node:path');
const { validateDatabase } = require('../lib/core/database');
const source = process.argv[2];
if (!source) {
    console.error('Pemakaian: node scripts/restore-database.js backups/database-TIMESTAMP.json');
    process.exit(1);
}
const db = validateDatabase(JSON.parse(fs.readFileSync(source, 'utf8')));
const destination = path.join(process.cwd(), 'database.json');
const tmp = `${destination}.${process.pid}.tmp`;
if (fs.existsSync(destination)) {
    const preserved = `${destination}.before-restore-${Date.now()}`;
    fs.copyFileSync(destination, preserved);
    fs.chmodSync(preserved, 0o600);
}
fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
fs.renameSync(tmp, destination);
console.log('Database dipulihkan. Jalankan ME-AI kembali.');
