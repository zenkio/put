import Database from 'better-sqlite3';
const db = new Database('data/nanoclaw.db');

console.log('--- Tasks ---');
try {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY last_run DESC LIMIT 10').all();
  console.table(tasks);
} catch (e) { console.log('Tasks table error or empty'); }

console.log('\n--- Chats ---');
try {
  const chats = db.prepare('SELECT * FROM chats ORDER BY last_message_time DESC LIMIT 10').all();
  console.table(chats);
} catch (e) { console.log('Chats table error or empty'); }

console.log('\n--- Messages (Last 5) ---');
try {
  const messages = db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 5').all();
  console.table(messages);
} catch (e) { console.log('Messages table error or empty'); }
