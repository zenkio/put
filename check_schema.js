import Database from 'better-sqlite3';
const db = new Database('data/nanoclaw.db');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables);

for (const table of tables) {
  const schema = db.prepare(`PRAGMA table_info(${table.name})`).all();
  console.log(`Schema for ${table.name}:`, schema);
}
