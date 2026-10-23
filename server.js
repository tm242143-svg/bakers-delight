const path = require('path'), os = require('os');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express'), http = require('http'), { Server } = require('socket.io'), mysql = require('mysql2/promise'),
  bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), multer = require('multer'), XLSX = require('xlsx');

const app = express(), srv = http.createServer(app), io = new Server(srv);
const SECRET = process.env.JWT_SECRET || 'change-me';
const pool = mysql.createPool({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'saffron_table', decimalNumbers: true, connectionLimit: 10, charset: 'utf8mb4' });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = f => (q, s) => f(q, s).catch(e => { console.error(e); s.status(500).json({ error: 'Server error' }) });
// Role guard: auth() = any logged-in user, auth('admin','chef') = only those roles
const auth = (...roles) => (q, s, next) => {
  try { q.user = jwt.verify((q.headers.authorization || '').slice(7), SECRET) } catch { return s.status(401).json({ error: 'Please sign in again' }) }
  if (roles.length && !roles.includes(q.user.role)) return s.status(403).json({ error: 'Not allowed for your role' });
  next();
};
const fix = o => ({ ...o, items: typeof o.items === 'string' ? JSON.parse(o.items) : o.items });
const sendOrder = (ev, o) => io.to('role:chef').to('role:admin').to('user:' + o.created_by).emit(ev, o);

/* ---------- login ---------- */
app.post('/api/login', wrap(async (q, s) => {
  const [[u]] = await pool.query('SELECT * FROM users WHERE email=?', [String(q.body.email || '').toLowerCase()]);
  if (!u || !(await bcrypt.compare(String(q.body.password || ''), u.password_hash))) {
    console.log(`Login failed for "${q.body.email}": ${u ? 'wrong password' : 'no such user in database "' + DB + '"'}`);
    return s.status(401).json({ error: 'Wrong email or password' });
  }
  const user = { id: u.id, name: u.name, role: u.role };
  s.json({ token: jwt.sign(user, SECRET, { expiresIn: '12h' }), user });
}));
app.get('/api/me', auth(), (q, s) => s.json({ id: q.user.id, name: q.user.name, role: q.user.role }));

/* ---------- menu ---------- */
const dish = r => ({ ...r, available: !!r.available });
app.get('/api/menu', auth(), wrap(async (q, s) => { const [r] = await pool.query('SELECT * FROM menu_items ORDER BY id'); s.json(r.map(dish)) }));
app.post('/api/menu', auth('admin'), wrap(async (q, s) => {
  const name = String(q.body.name || '').trim().slice(0, 40), price = +q.body.price;
  if (!name || !(price > 0)) return s.status(400).json({ error: 'Enter a name and a price above 0' });
  await pool.query('INSERT INTO menu_items (name,price) VALUES (?,?)', [name, price]); io.emit('menu:changed'); s.json({ ok: 1 });
}));
app.put('/api/menu/:id', auth('admin'), wrap(async (q, s) => {
  const b = q.body, set = [], v = [];
  if (b.name !== undefined) { set.push('name=?'); v.push(String(b.name).trim().slice(0, 40)) }
  if (b.price !== undefined) { if (!(+b.price > 0)) return s.status(400).json({ error: 'Price must be above 0' }); set.push('price=?'); v.push(+b.price) }
  if (b.available !== undefined) { set.push('available=?'); v.push(b.available ? 1 : 0) }
  if (!set.length) return s.status(400).json({ error: 'Nothing to change' });
  await pool.query(`UPDATE menu_items SET ${set.join(',')} WHERE id=?`, [...v, q.params.id]); io.emit('menu:changed'); s.json({ ok: 1 });
}));
app.delete('/api/menu/:id', auth('admin'), wrap(async (q, s) => { await pool.query('DELETE FROM menu_items WHERE id=?', [q.params.id]); io.emit('menu:changed'); s.json({ ok: 1 }) }));

app.get('/api/menu-template', auth('admin'), (q, s) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'price', 'emoji', 'available'], ['Paneer Tikka', 220, '🍢', 'yes'], ['Cold Coffee', 110, '☕', 'yes']]), 'Menu');
  s.set('Content-Disposition', 'attachment; filename=menu-template.xlsx').type('xlsx').send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});
app.post('/api/menu-upload', auth('admin'), upload.single('file'), wrap(async (q, s) => {
  if (!q.file) return s.status(400).json({ error: 'Choose an .xlsx or .csv file' });
  let rows; try { const wb = XLSX.read(q.file.buffer); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }) } catch { return s.status(400).json({ error: 'Could not read that file' }) }
  const [have] = await pool.query('SELECT name FROM menu_items'); const seen = new Set(have.map(h => h.name.toLowerCase())); const out = []; let skipped = 0;
  for (const r of rows) {
    const k = {}; for (const key in r) k[String(key).trim().toLowerCase()] = r[key];
    const name = String(k.name || k.item || k.food || '').trim().slice(0, 40), price = parseFloat(k.price);
    if (!name || !(price > 0) || seen.has(name.toLowerCase())) { skipped++; continue }
    seen.add(name.toLowerCase());
    out.push([name, price, String(k.emoji || '🍽️').slice(0, 8), /^(no|n|false|0)$/i.test(String(k.available ?? 'yes').trim()) ? 0 : 1]);
  }
  if (out.length) await pool.query('INSERT INTO menu_items (name,price,emoji,available) VALUES ?', [out]);
  io.emit('menu:changed'); s.json({ added: out.length, skipped });
}));

/* ---------- orders ---------- */
app.get('/api/orders', auth('chef', 'salesperson', 'admin'), wrap(async (q, s) => {
  const mine = q.user.role === 'salesperson';
  const [r] = await pool.query(`SELECT * FROM orders ${mine ? 'WHERE created_by=?' : ''} ORDER BY created_at DESC LIMIT ${q.user.role === 'admin' ? 2000 : 100}`, mine ? [q.user.id] : []);
  s.json(r.map(fix));
}));
// Admin: delete order history (completed orders only; ongoing orders are protected)
app.delete('/api/orders/history', auth('admin'), wrap(async (q, s) => {
  const [r] = await pool.query("DELETE FROM orders WHERE status='Served'"); io.emit('orders:changed'); s.json({ deleted: r.affectedRows });
}));
app.delete('/api/orders/:id', auth('admin'), wrap(async (q, s) => {
  const [r] = await pool.query("DELETE FROM orders WHERE id=? AND status='Served'", [q.params.id]);
  if (!r.affectedRows) return s.status(400).json({ error: 'Only completed orders can be deleted' });
  io.emit('orders:changed'); s.json({ ok: 1 });
}));
app.post('/api/orders', auth('salesperson'), wrap(async (q, s) => {
  const table = String(q.body.table_no || '').trim().slice(0, 10), want = Array.isArray(q.body.items) ? q.body.items : [];
  if (!table || !want.length) return s.status(400).json({ error: 'Table number and dishes are required' });
  // Prices come from the database, never from the browser
  const [m] = await pool.query('SELECT id,name,price FROM menu_items WHERE available=1 AND id IN (?)', [want.map(i => +i.id)]);
  const items = want.map(i => { const d = m.find(x => x.id === +i.id), n = Math.min(50, Math.floor(+i.q)); return d && n > 0 ? { name: d.name, price: d.price, q: n } : null }).filter(Boolean);
  if (!items.length) return s.status(400).json({ error: 'Those dishes are not available' });
  const [r] = await pool.query('INSERT INTO orders (table_no,items,waiter_name,created_by) VALUES (?,?,?,?)', [table, JSON.stringify(items), null, q.user.id]);
  const [[o]] = await pool.query('SELECT * FROM orders WHERE id=?', [r.insertId]); const out = fix(o);
  sendOrder('order:new', out); s.json(out);
}));
// Chef steps (must follow in order): Pending → Preparing → Ready → Received ("Given to salesperson").
// Salesperson: Received → Served ("Given to customer"), own orders only. Admin has no order controls.
const CHEF_STEP = { Preparing: 'Pending', Ready: 'Preparing', Received: 'Ready' };   // new status : required current status
const FLOW = { chef: Object.keys(CHEF_STEP), salesperson: ['Served'] };
app.put('/api/orders/:id/status', auth('chef', 'salesperson'), wrap(async (q, s) => {
  const st = q.body.status, role = q.user.role;
  if (!FLOW[role].includes(st)) return s.status(403).json({ error: 'Your role cannot set this status' });
  const [[cur]] = await pool.query('SELECT * FROM orders WHERE id=?', [q.params.id]);
  if (!cur) return s.status(404).json({ error: 'Order not found' });
  if (role === 'chef' && CHEF_STEP[st] !== cur.status) return s.status(400).json({ error: 'Follow the steps: Preparing → Ready → Given to salesperson' });
  if (role === 'salesperson') {
    if (cur.created_by !== q.user.id) return s.status(403).json({ error: 'You can only update your own orders' });
    if (cur.status !== 'Received') return s.status(400).json({ error: 'The chef has not given this order to you yet' });
  }
  await pool.query('UPDATE orders SET status=? WHERE id=?', [st, cur.id]);
  const out = { ...fix({ ...cur, status: st }), changed_by: q.user.id };
  sendOrder('order:status', out); s.json(out);
}));

/* ---------- realtime (Socket.IO) ---------- */
io.use((sock, next) => { try { sock.user = jwt.verify(sock.handshake.auth.token, SECRET); next() } catch { next(new Error('unauthorized')) } });
io.on('connection', sock => { sock.join('role:' + sock.user.role); sock.join('user:' + sock.user.id) });

/* ---------- database setup (runs automatically on every start; safe to repeat) ---------- */
const DB = process.env.DB_NAME || 'saffron_table';
const DEFAULT_USERS = [['Admin', 'admin@saffron.com', 'admin123', 'admin'], ['Salesperson', 'salesperson@saffron.com', 'sales123', 'salesperson'], ['Chef', 'chef@saffron.com', 'chef123', 'chef']];
async function initDb() {
  const c = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', charset: 'utf8mb4' });
  try {
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` CHARACTER SET utf8mb4`);
    await c.query(`USE \`${DB}\``);
    await c.query(`CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL, email VARCHAR(120) NOT NULL UNIQUE, password_hash VARCHAR(100) NOT NULL, role ENUM('admin','salesperson','chef') NOT NULL)`);
    await c.query(`CREATE TABLE IF NOT EXISTS menu_items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40) NOT NULL, price DECIMAL(10,2) NOT NULL, emoji VARCHAR(16) DEFAULT '🍽️', available TINYINT(1) NOT NULL DEFAULT 1)`);
    await c.query(`CREATE TABLE IF NOT EXISTS orders (id INT AUTO_INCREMENT PRIMARY KEY, table_no VARCHAR(10) NOT NULL, items JSON NOT NULL, status ENUM('Pending','Preparing','Ready','Received','Served') NOT NULL DEFAULT 'Pending', waiter_name VARCHAR(60), created_by INT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (created_by) REFERENCES users(id))`);
    // upgrade older databases (waiter → salesperson, new statuses)
    await c.query(`ALTER TABLE users MODIFY role ENUM('admin','waiter','salesperson','chef') NOT NULL`);
    await c.query(`UPDATE users SET role='salesperson' WHERE role='waiter'`);
    await c.query(`ALTER TABLE users MODIFY role ENUM('admin','salesperson','chef') NOT NULL`);
    await c.query(`ALTER TABLE orders MODIFY status ENUM('Pending','Preparing','Ready','Received','Served') NOT NULL DEFAULT 'Pending'`);
    const [[old]] = await c.query(`SELECT COUNT(*) n FROM users WHERE email='waiter@saffron.com'`);
    const [[neu]] = await c.query(`SELECT COUNT(*) n FROM users WHERE email='salesperson@saffron.com'`);
    if (old.n && !neu.n) await c.query(`UPDATE users SET email='salesperson@saffron.com' WHERE email='waiter@saffron.com'`);
    // create the 3 default logins only if they do not exist yet
    // The 3 default logins are (re)set on every start so they always match the README.
    // After you change passwords, add KEEP_PASSWORDS=1 to .env to stop this reset.
    const keep = process.env.KEEP_PASSWORDS === '1';
    for (const [name, email, pw, role] of DEFAULT_USERS)
      await c.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)' + (keep ? ' ON DUPLICATE KEY UPDATE role=role' : ' ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), role=VALUES(role), name=VALUES(name)'), [name, email, await bcrypt.hash(pw, 10), role]);
    const [[m]] = await c.query('SELECT COUNT(*) n FROM menu_items');
    if (!m.n) await c.query('INSERT INTO menu_items (name,price,emoji,available) VALUES ?', [[['Paneer Butter Masala', 240, '🍛', 1], ['Chicken Biryani', 280, '🍚', 1], ['Masala Dosa', 120, '🥞', 1], ['Margherita Pizza', 320, '🍕', 1], ['Veg Burger', 150, '🍔', 1], ['Fresh Lime Soda', 70, '🍋', 1], ['Gulab Jamun', 90, '🍮', 0]]]);
  } finally { await c.end() }
}

const PORT = process.env.PORT || 3000;
srv.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `\n✖ Port ${PORT} is already in use. Close the other terminal running this app, or set a different PORT in .env.` : '\n✖ ' + e.message); process.exit(1) });
initDb().then(() => {
  srv.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✔ Bakers Delight is running\n  This computer : http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`  Phones (same Wi-Fi): http://${n.address}:${PORT}`);
  });
}).catch(e => {
  const hint = { ER_ACCESS_DENIED_ERROR: 'Wrong MySQL user or password. Fix DB_USER / DB_PASSWORD in the .env file.', ECONNREFUSED: 'MySQL is not running. Start the "MySQL80" service (Win+R → services.msc) and try again.', ENOTFOUND: 'DB_HOST in .env is wrong.' }[e.code];
  console.error('\n✖ Could not set up the database: ' + e.message + (hint ? '\n  → ' + hint : '')); process.exit(1);
});
