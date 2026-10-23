// Creates the 3 starter logins. Change these passwords after first login.
require('dotenv').config();
const mysql = require('mysql2/promise'), bcrypt = require('bcryptjs');
(async () => {
  const db = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'saffron_table' });
  const users = [['Admin', 'admin@saffron.com', 'admin123', 'admin'], ['Salesperson', 'salesperson@saffron.com', 'sales123', 'salesperson'], ['Chef', 'chef@saffron.com', 'chef123', 'chef']];
  for (const [name, email, pw, role] of users)
    await db.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), password_hash=VALUES(password_hash), role=VALUES(role)', [name, email, await bcrypt.hash(pw, 10), role]);
  console.log('Users ready:\n' + users.map(u => `  ${u[3]}: ${u[1]} / ${u[2]}`).join('\n'));
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1) });
