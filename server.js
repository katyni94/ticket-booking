const express = require('express');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "admin123";

app.set('trust proxy', 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 25, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, statement_timeout: 15000, query_timeout: 15000
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const rateLimitStore = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetAt) { entry = { count: 0, resetAt: now + windowMs }; rateLimitStore.set(key, entry); }
    entry.count++;
    if (entry.count > max) return res.status(429).json({ error: 'Слишком много запросов. Подождите.' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rateLimitStore) if (now > v.resetAt) rateLimitStore.delete(k); }, 60000);

let appSettings = {
  basePrice: 600, colorPrices: { '#FFC000': 600, '#FFFF00': 800, '#92D050': 1000, '#C55A11': 1100, '#00B0F0': 1300, '#B4A7D6': 1400, '#F4B183': 1500 },
  rules: [], hidden: { left: false, right: false }, maxSeats: 4, bgUrl: '', bgSize: 'cover', bgPosX: 50, bgPosY: 50, restrictAdminSeats: true
};

function normPhone(p) { return String(p || '').replace(/\D/g, '').slice(-10); }

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS bookings (
      seat_key VARCHAR(50) PRIMARY KEY, firstname VARCHAR(50), lastname VARCHAR(50), phone VARCHAR(30),
      reserve_firstname VARCHAR(50), reserve_lastname VARCHAR(50), group_name VARCHAR(100), status VARCHAR(20) DEFAULT 'booked',
      is_admin_booking BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      phone VARCHAR(30) PRIMARY KEY, firstname VARCHAR(50) NOT NULL, lastname VARCHAR(50) NOT NULL, group_name VARCHAR(100)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS settings (key VARCHAR(50) PRIMARY KEY, value JSONB)`);
    
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'app_settings'");
    if (rows.length > 0) appSettings = { ...appSettings, ...rows[0].value };
    else await pool.query("INSERT INTO settings (key, value) VALUES ('app_settings', $1)", [appSettings]);
    console.log('БД готова');
  } catch (err) { console.error('Ошибка БД:', err); }
}
initDB();

app.get('/api/settings', (req, res) => res.json(appSettings));
app.post('/api/admin/settings', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try { appSettings = req.body; await pool.query("UPDATE settings SET value = $1 WHERE key = 'app_settings'", [appSettings]); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/bookings', async (req, res) => {
  try { const { rows } = await pool.query('SELECT seat_key, status FROM bookings'); res.json(rows); } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

// === БАЗА КЛИЕНТОВ ===
app.get('/api/auth/check-phone', async (req, res) => {
  const phone = normPhone(req.query.phone);
  if (!phone) return res.status(400).json({ error: 'Введите телефон' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE RIGHT(REGEXP_REPLACE(phone, \'[^0-9]\', \'\', \'g\'), 10) = $1', [phone]);
    if (rows.length === 0) return res.status(404).json({ error: 'Номер не найден в базе. Обратитесь к администратору.' });
    res.json({ found: true, user: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/admin/users', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  const { rows } = await pool.query('SELECT * FROM users ORDER BY lastname, firstname');
  res.json(rows);
});

app.post('/api/admin/users', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  const { firstname, lastname, phone, group_name } = req.body;
  if (!firstname || !lastname || !phone) return res.status(400).json({ error: 'Заполните поля' });
  try {
    await pool.query(`INSERT INTO users (phone, firstname, lastname, group_name) VALUES ($1, $2, $3, $4) ON CONFLICT (phone) DO UPDATE SET firstname=$2, lastname=$3, group_name=$4`, [phone.trim(), firstname.trim(), lastname.trim(), group_name || '']);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.delete('/api/admin/users', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  await pool.query('DELETE FROM users WHERE phone = $1', [req.query.phone]);
  res.json({ ok: true });
});

// === БРОНИРОВАНИЕ ===
app.post('/api/bookings', rateLimit(60000, 15), async (req, res) => {
  const { seats, phone, reserveFirstname, reserveLastname, groupName, adminPass, ignoreLimit } = req.body || {};
  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'Не выбраны места' });
  if (seats.length > 20) return res.status(400).json({ error: 'Слишком много мест' });
  const digits = normPhone(phone);
  if (digits.length < 10) return res.status(400).json({ error: 'Введите корректный телефон' });

  let fName = '', lName = '', userGroup = groupName || '';
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE RIGHT(REGEXP_REPLACE(phone, \'[^0-9]\', \'\', \'g\'), 10) = $1', [digits]);
    if (userRes.rows.length === 0) return res.status(400).json({ error: 'Пользователь с таким телефоном не найден в базе' });
    fName = userRes.rows[0].firstname; lName = userRes.rows[0].lastname;
    userGroup = userRes.rows[0].group_name || groupName || '';
  } catch (e) { return res.status(500).json({ error: 'Ошибка проверки пользователя' }); }

  const isAdmin = (adminPass === ADMIN_PASSWORD);
  const useLimit = isAdmin ? (ignoreLimit !== true) : true;
  const isAdminBooking = isAdmin && !useLimit;
  const rFName = reserveFirstname ? reserveFirstname.trim() : null;
  const rLName = reserveLastname ? reserveLastname.trim() : null;
  if ((rFName && !rLName) || (!rFName && rLName)) return res.status(400).json({ error: 'Для резерва нужно ввести и имя, и фамилию' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [`user:${fName}:${lName}:${digits}`]);
    const { rows: existing } = await client.query('SELECT seat_key FROM bookings WHERE seat_key = ANY($1)', [seats]);
    if (existing.length > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Места уже заняты', code: 'SEATS_TAKEN' }); }

    if (useLimit) {
      const { rows: userRows } = await client.query(`SELECT COUNT(*) as count FROM bookings WHERE (LOWER(firstname)=LOWER($1) AND LOWER(lastname)=LOWER($2) AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $3) OR (LOWER(reserve_firstname)=LOWER($1) AND LOWER(reserve_lastname)=LOWER($2)) AND status='booked' AND COALESCE(is_admin_booking, false) = false`, [fName, lName, digits]);
      const userUsed = parseInt(userRows[0].count, 10);
      if (userUsed + seats.length > appSettings.maxSeats) {
        await client.query('ROLLBACK'); return res.status(409).json({ error: `У вас уже занято ${userUsed} из ${appSettings.maxSeats} мест.`, code: 'LIMIT_EXCEEDED' });
      }
    }

    for (const seat of seats) {
      const r = await client.query(`INSERT INTO bookings (seat_key, firstname, lastname, phone, reserve_firstname, reserve_lastname, group_name, status, is_admin_booking) VALUES ($1, $2, $3, $4, $5, $6, $7, 'booked', $8) ON CONFLICT (seat_key) DO NOTHING RETURNING seat_key`, [seat, fName, lName, phone.trim(), rFName, rLName, userGroup, isAdminBooking]);
      if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Место занято', code: 'SEATS_TAKEN' }); }
    }
    await client.query('COMMIT'); res.json({ ok: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Ошибка бронирования' }); } finally { client.release(); }
});

// === ОСТАЛЬНЫЕ API ===
app.get('/api/my-tickets', async (req, res) => {
  const { phone } = req.query; const digits = normPhone(phone);
  if (digits.length < 10) return res.status(400).json({ error: 'Введите телефон' });
  try {
    const { rows } = await pool.query(`SELECT seat_key, firstname, lastname, phone, reserve_firstname, reserve_lastname, status, is_admin_booking, group_name FROM bookings WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $1 AND status='booked' ORDER BY seat_key`, [digits]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/cancel', async (req, res) => {
  const { seats, phone } = req.body || {}; const digits = normPhone(phone);
  if (digits.length < 10) return res.status(400).json({ error: 'Введите телефон' });
  try {
    const result = await pool.query(`DELETE FROM bookings WHERE seat_key = ANY($1) AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $2 AND status='booked'`, [seats, digits]);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) { res.status(500).json({ error: 'Ошибка отмены' }); }
});

app.get('/api/admin/person-summary', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  const { phone } = req.query; const digits = normPhone(phone);
  try {
    const total = parseInt((await pool.query(`SELECT COUNT(*) as c FROM bookings WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $1 AND status='booked'`, [digits])).rows[0].c, 10);
    const limited = parseInt((await pool.query(`SELECT COUNT(*) as c FROM bookings WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $1 AND status='booked' AND COALESCE(is_admin_booking, false) = false`, [digits])).rows[0].c, 10);
    res.json({ total, limited, admin: total - limited, max: appSettings.maxSeats, left: Math.max(0, appSettings.maxSeats - limited) });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/admin/toggle-block', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  const { seat } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM bookings WHERE seat_key = $1', [seat]);
    if (rows.length > 0) {
      if (rows[0].status === 'blocked') { await pool.query('DELETE FROM bookings WHERE seat_key = $1', [seat]); return res.json({ status: 'free' }); } 
      else return res.status(400).json({ error: 'Место уже забронировано' });
    } else {
      await pool.query("INSERT INTO bookings (seat_key, firstname, phone, status) VALUES ($1, 'Админ', 'Заблокировано', 'blocked') ON CONFLICT DO NOTHING", [seat]);
      return res.json({ status: 'blocked' });
    }
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/admin/booking-info', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  const { rows } = await pool.query('SELECT * FROM bookings WHERE seat_key = $1', [req.query.seat]);
  if (rows.length > 0) res.json(rows[0]); else res.status(404).json({ error: 'Не найдено' });
});

app.post('/api/admin/force-cancel', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  await pool.query('DELETE FROM bookings WHERE seat_key = $1', [req.body.seat]); res.json({ ok: true });
});

app.post('/api/admin/bulk-force-cancel', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  const { seats } = req.body;
  if (!seats || !seats.length) return res.status(400).json({ error: 'Не выбраны места' });
  try { await pool.query('DELETE FROM bookings WHERE seat_key = ANY($1)', [seats]); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/admin/edit-booking', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  const { seat, firstname, lastname, phone, group_name, reserve_firstname, reserve_lastname, is_admin_booking } = req.body;
  await pool.query(`UPDATE bookings SET firstname=$1, lastname=$2, phone=$3, group_name=$4, reserve_firstname=$5, reserve_lastname=$6, is_admin_booking = COALESCE($7, is_admin_booking) WHERE seat_key=$8`, [firstname, lastname, phone, group_name, reserve_firstname, reserve_lastname, (typeof is_admin_booking === 'boolean' ? is_admin_booking : null), seat]);
  res.json({ ok: true });
});

app.post('/api/admin/bulk-edit', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  const { oldPhone, newFirstname, newLastname, newPhone } = req.body;
  if (!oldPhone || !newFirstname || !newLastname || !newPhone) return res.status(400).json({ error: 'Заполните все поля' });
  try {
    const normOldPhone = oldPhone.replace(/\D/g, '').slice(-10);
    const result = await pool.query(`UPDATE bookings SET firstname = $1, lastname = $2, phone = $3 WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $4 AND status = 'booked'`, [newFirstname, newLastname, newPhone, normOldPhone]);
    res.json({ ok: true, updated: result.rowCount });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/admin/duplicates', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  const { rows } = await pool.query(`SELECT LOWER(firstname) as fname, LOWER(lastname) as lname, MAX(firstname) as display_firstname, MAX(lastname) as display_lastname, COUNT(DISTINCT phone) as phone_count, STRING_AGG(DISTINCT phone, ' | ') as phones, COUNT(*) as total_seats FROM bookings WHERE status = 'booked' AND COALESCE(is_admin_booking, false) = false GROUP BY LOWER(firstname), LOWER(lastname) HAVING COUNT(DISTINCT phone) > 1`);
  res.json(rows);
});

// ЭКСПОРТ EXCEL
app.get('/api/admin/export', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('Доступ запрещен');
  try {
    const { rows: booked } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at ASC");
    const workbook = new ExcelJS.Workbook();
    const sheet1 = workbook.addWorksheet('Билеты');
    sheet1.columns = [ { header: 'Зона', key: 'zone', width: 20 }, { header: 'Ряд', key: 'row', width: 10 }, { header: 'Место', key: 'seat', width: 10 }, { header: 'Фамилия', key: 'lastname', width: 20 }, { header: 'Имя', key: 'firstname', width: 20 }, { header: 'Телефон', key: 'phone', width: 20 }, { header: 'Резерв', key: 'reserve', width: 25 }, { header: 'Группа', key: 'group', width: 20 }, { header: 'Админ', key: 'admin', width: 10 }, { header: 'Сумма', key: 'price', width: 15 } ];
    booked.forEach(b => {
      let zoneName = 'Балкон'; let row = 0, seat = 0;
      if (b.seat_key.startsWith('parterre-')) { zoneName = 'Партер'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('central-')) { zoneName = 'Центр. балкон'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('balc-')) { const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; zoneName = b.seat_key.includes('left') ? 'Левый балкон' : 'Правый балкон'; }
      sheet1.addRow({ zone: zoneName, row, seat, lastname: b.lastname, firstname: b.firstname, phone: b.phone, reserve: b.reserve_lastname || '', group: b.group_name || '', admin: b.is_admin_booking ? 'да' : '', price: 600 });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.xlsx"');
    await workbook.xlsx.write(res); res.end();
  } catch (err) { res.status(500).send('Ошибка'); }
});

app.get('/api/admin/export-word', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('Доступ запрещен');
  try {
    const { rows: booked } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at ASC");
    let html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><style>body{font-family:Arial;} table{border-collapse:collapse;width:100%;} th,td{border:1px solid #000;padding:5px;}</style></head><body><h1>Билеты</h1><table><tr><th>Зона</th><th>Ряд</th><th>Место</th><th>Фамилия</th><th>Имя</th><th>Телефон</th><th>Группа</th></tr>`;
    booked.forEach(b => {
      let zoneName = 'Балкон'; let row = 0, seat = 0;
      if (b.seat_key.startsWith('parterre-')) { zoneName = 'Партер'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('central-')) { zoneName = 'Центр. балкон'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('balc-')) { const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; zoneName = b.seat_key.includes('left') ? 'Левый балкон' : 'Правый балкон'; }
      html += `<tr><td>${zoneName}</td><td>${row}</td><td>${seat}</td><td>${b.lastname}</td><td>${b.firstname}</td><td>${b.phone}</td><td>${b.group_name || ''}</td></tr>`;
    });
    html += `</table></body></html>`;
    res.setHeader('Content-Type', 'application/msword');
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.doc"');
    res.send(html);
  } catch (err) { res.status(500).send('Ошибка'); }
});

app.listen(PORT, () => console.log(`Сервер: ${PORT}`));
