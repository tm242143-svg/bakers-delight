const path = require('path'), os = require('os');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express'), http = require('http'), { Server } = require('socket.io'), mysql = require('mysql2/promise'),
  bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), multer = require('multer'), XLSX = require('xlsx');

const app = express(), srv = http.createServer(app), io = new Server(srv);
// Reads TiDB Cloud names (TIDB_HOST, TIDB_PORT, TIDB_USER, TIDB_PASSWORD, TIDB_DATABASE, TIDB_ENABLE_SSL)
// and also the older DB_* names, so either style of .env works.
const E = (a, b, d) => process.env[a] || process.env[b] || d;
const DB = E('TIDB_DATABASE', 'DB_NAME', 'saffron_table');
const useSsl = [process.env.TIDB_ENABLE_SSL, process.env.DB_SSL].some(v => String(v).toLowerCase() === 'true');
const DBCFG = {
  host: E('TIDB_HOST', 'DB_HOST', 'localhost'),
  port: Number(E('TIDB_PORT', 'DB_PORT', 3306)),
  user: E('TIDB_USER', 'DB_USER', 'root'),
  password: E('TIDB_PASSWORD', 'DB_PASSWORD', ''),
  charset: 'utf8mb4',
  ssl: useSsl ? { minVersion: 'TLSv1.2', rejectUnauthorized: process.env.DB_SSL_INSECURE !== 'true' } : undefined   // TiDB Cloud requires TLS
};
const SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.log('! JWT_SECRET is not set in .env - using a temporary one (everyone is signed out whenever the server restarts). Add JWT_SECRET=any-long-random-text');
const pool = mysql.createPool({ ...DBCFG, database: DB, decimalNumbers: true, connectionLimit: 10, enableKeepAlive: true });
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
app.get('/api/menu', auth(), wrap(async (q, s) => { const [r] = await pool.query('SELECT id,name,price,emoji,available,image_v FROM menu_items ORDER BY id'); s.json(r.map(dish)) }));
// Dish photos are stored in the database (survive restarts/redeploys). The URL carries ?v=image_v so a new photo shows instantly.
app.get('/api/menu/:id/image', wrap(async (q, s) => {
  const [[r]] = await pool.query('SELECT image,image_type FROM menu_items WHERE id=?', [q.params.id]);
  if (!r || !r.image) return s.status(404).end();
  s.set('Content-Type', r.image_type || 'image/jpeg').set('Cache-Control', 'public, max-age=31536000, immutable').send(r.image);
}));
const upImg = (q, s, next) => upload.single('image')(q, s, e => e ? s.status(400).json({ error: 'Image too large (max 2 MB)' }) : next());
app.post('/api/menu/:id/image', auth('admin'), upImg, wrap(async (q, s) => {
  if (!q.file || !/^image\/(jpeg|png|webp|gif)$/.test(q.file.mimetype)) return s.status(400).json({ error: 'Choose a JPG, PNG or WebP image' });
  const v = Date.now();
  const [r] = await pool.query('UPDATE menu_items SET image=?, image_type=?, image_v=? WHERE id=?', [q.file.buffer, q.file.mimetype, v, q.params.id]);
  if (!r.affectedRows) return s.status(404).json({ error: 'Dish not found' });
  io.emit('menu:changed'); s.json({ ok: 1, image_v: v });
}));
app.delete('/api/menu/:id/image', auth('admin'), wrap(async (q, s) => {
  await pool.query('UPDATE menu_items SET image=NULL, image_type=NULL, image_v=0 WHERE id=?', [q.params.id]); io.emit('menu:changed'); s.json({ ok: 1 });
}));
app.post('/api/menu', auth('admin'), wrap(async (q, s) => {
  const name = String(q.body.name || '').trim().slice(0, 40), price = +q.body.price;
  if (!name || !(price > 0)) return s.status(400).json({ error: 'Enter a name and a price above 0' });
  const [r] = await pool.query('INSERT INTO menu_items (name,price,emoji) VALUES (?,?,?)', [name, price, String(q.body.emoji || '🥐').slice(0, 8)]); io.emit('menu:changed'); s.json({ ok: 1, id: r.insertId });
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
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'price', 'emoji', 'available'], ['Butter Croissant', 80, '🥐', 'yes'], ['Chocolate Cupcake', 60, '🧁', 'yes']]), 'Menu');
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
    out.push([name, price, String(k.emoji || '🥐').slice(0, 8), /^(no|n|false|0)$/i.test(String(k.available ?? 'yes').trim()) ? 0 : 1]);
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
const DEFAULT_USERS = [['Admin', 'admin@saffron.com', 'admin123', 'admin'], ['Salesperson', 'salesperson@saffron.com', 'sales123', 'salesperson'], ['Chef', 'chef@saffron.com', 'chef123', 'chef']];
async function initDb() {
  const c = await mysql.createConnection(DBCFG);
  try {
    // Locally this creates the database. On cloud hosts you usually can't create one
    // (the provider already gave you one), so a failure here is ignored.
    try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` CHARACTER SET utf8mb4`) } catch (e) { console.log('Skipping CREATE DATABASE (' + e.code + ') - using existing database "' + DB + '"') }
    await c.query(`USE \`${DB}\``);
    await c.query(`CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL, email VARCHAR(120) NOT NULL UNIQUE, password_hash VARCHAR(100) NOT NULL, role ENUM('admin','salesperson','chef') NOT NULL)`);
    await c.query(`CREATE TABLE IF NOT EXISTS menu_items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40) NOT NULL, price DECIMAL(10,2) NOT NULL, emoji VARCHAR(16) DEFAULT '🥐', available TINYINT(1) NOT NULL DEFAULT 1, image MEDIUMBLOB NULL, image_type VARCHAR(30) NULL, image_v BIGINT NOT NULL DEFAULT 0)`);
    await c.query(`CREATE TABLE IF NOT EXISTS orders (id INT AUTO_INCREMENT PRIMARY KEY, table_no VARCHAR(10) NOT NULL, items JSON NOT NULL, status ENUM('Pending','Preparing','Ready','Received','Served') NOT NULL DEFAULT 'Pending', waiter_name VARCHAR(60), created_by INT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (created_by) REFERENCES users(id))`);
    // Upgrade older databases only when needed. Each step is optional, so a database that
    // cannot do it (e.g. TiDB does not allow re-ordering ENUM values) never stops the app.
    const colType = async (t, col) => { const [[r]] = await c.query('SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?', [DB, t, col]); return r ? String(r.t) : '' };
    const tryRun = async sql => { try { await c.query(sql) } catch (e) { console.log('Skipped optional upgrade step: ' + e.message) } };
    if ((await colType('users', 'role')).includes('waiter')) {
      await tryRun(`ALTER TABLE users MODIFY role ENUM('admin','waiter','salesperson','chef') NOT NULL`);
      await tryRun(`UPDATE users SET role='salesperson' WHERE role='waiter'`);
      await tryRun(`ALTER TABLE users MODIFY role ENUM('admin','salesperson','chef') NOT NULL`);
    }
    if (!(await colType('orders', 'status')).includes('Served'))
      await tryRun(`ALTER TABLE orders MODIFY status ENUM('Pending','Preparing','Ready','Received','Served') NOT NULL DEFAULT 'Pending'`);
    // dish photo columns for databases created before photos existed (one ALTER each - TiDB-safe)
    if (!(await colType('menu_items', 'image_v'))) {
      await c.query('ALTER TABLE menu_items ADD COLUMN image MEDIUMBLOB NULL');
      await c.query('ALTER TABLE menu_items ADD COLUMN image_type VARCHAR(30) NULL');
      await c.query('ALTER TABLE menu_items ADD COLUMN image_v BIGINT NOT NULL DEFAULT 0');
    }
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
    if (!m.n) await c.query('INSERT INTO menu_items (name,price,emoji,available) VALUES ?', [[['Butter Croissant', 80, '🥐', 1], ['Chocolate Cupcake', 60, '🧁', 1], ['Sourdough Loaf', 180, '🍞', 1], ['French Baguette', 110, '🥖', 1], ['Black Forest Pastry', 95, '🍰', 1], ['Choco Chip Cookie', 40, '🍪', 1], ['Glazed Donut', 55, '🍩', 0]]]);
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
  const hint = { ER_ACCESS_DENIED_ERROR: 'Wrong database user or password. Fix TIDB_USER / TIDB_PASSWORD.', ER_BAD_DB_ERROR: 'Database "' + DB + '" does not exist. Create it, or set TIDB_DATABASE to a database that exists (the TiDB Cloud default database is called test).', ECONNREFUSED: 'Cannot reach MySQL at ' + DBCFG.host + ':' + DBCFG.port + '. Locally: start the MySQL service. On hosting: check TIDB_HOST / TIDB_PORT.', ETIMEDOUT: 'MySQL host timed out. Check TIDB_HOST / TIDB_PORT and the provider firewall/allowlist.', ENOTFOUND: 'TIDB_HOST is wrong (host name not found).', HANDSHAKE_SSL_ERROR: 'SSL problem. Make sure TIDB_ENABLE_SSL=true is in .env.', ER_NOT_SUPPORTED_AUTH_MODE: 'MySQL auth mode not supported by the driver.' }[e.code];
  console.error('\n✖ Could not set up the database: ' + e.message + (hint ? '\n  → ' + hint : '')); process.exit(1);
});