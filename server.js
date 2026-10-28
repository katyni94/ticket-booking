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

app.use(express.json({ limit: '10mb' }));
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
  rules: [], hidden: { left: false, right: false }, maxSeats: 4, bgUrl: '', bgSize: 'cover', bgPosX: 50, bgPosY: 50, restrictAdminSeats: true,
  groupRestrictions: {} 
};

function normPhone(p) { return String(p || '').replace(/\D/g, '').slice(-10); }

// ОБНОВЛЕННЫЕ ДИАПАЗОНЫ ДЛЯ 22-25 РЯДОВ
const tanci_parterre = { 1: [19, 39], 2: [18, 37], 3: [18, 37], 4: [17, 35], 5: [10, 20], 6: [17, 35], 7: [15, 31], 8: [16, 33], 9: [15, 32], 10: [14, 30], 11: [14, 30], 12: [14, 29], 13: [14, 29], 14: [14, 29], 15: [14, 29], 16: [14, 28], 17: [14, 28], 18: [13, 27], 19: [11, 19], 20: [11, 19], 21: [11, 19], 22: [14, 30], 23: [9, 20], 24: [7, 17], 25: [8, 19] };
const tanci_central = { 1: [14, 27], 2: [14, 28], 3: [15, 30], 4: [16, 31], 5: [15, 28] };

function getSeatSide(seatKey) {
    if (seatKey.startsWith('balc-left')) return 'left';
    if (seatKey.startsWith('balc-right')) return 'right';
    if (seatKey.startsWith('parterre-')) {
        const p = seatKey.split('-'); const row = +p[1], seat = +p[2];
        const r = tanci_parterre[row];
        return (r && seat >= r[0] && seat <= r[1]) ? 'left' : 'right';
    }
    if (seatKey.startsWith('central-')) {
        const p = seatKey.split('-'); const row = +p[1], seat = +p[2];
        const r = tanci_central[row];
        return (r && seat >= r[0] && seat <= r[1]) ? 'left' : 'right';
    }
    return 'left';
}

// ФУНКЦИЯ РАСЧЕТА ЦЕНЫ ДЛЯ ЭКСПОРТА
function getPrice(key) {
  let zone = ''; let row = 0, seat = 0;
  if (key.startsWith('parterre-')) { zone = 'parterre'; const p = key.split('-'); row = +p[1]; seat = +p[2]; }
  else if (key.startsWith('central-')) { zone = 'central'; const p = key.split('-'); row = +p[1]; seat = +p[2]; }
  else if (key.startsWith('balc-left-a-')) { zone = 'balc-left-a'; const p = key.split('-'); row = +p[3]; seat = +p[4]; }
  else if (key.startsWith('balc-left-b-')) { zone = 'balc-left-b'; const p = key.split('-'); row = +p[3]; seat = +p[4]; }
  else if (key.startsWith('balc-right-a-')) { zone = 'balc-right-a'; const p = key.split('-'); row = +p[3]; seat = +p[4]; }
  else if (key.startsWith('balc-right-b-')) { zone = 'balc-right-b'; const p = key.split('-'); row = +p[3]; seat = +p[4]; }
  
  if (appSettings.rules) {
    for (let i = appSettings.rules.length - 1; i >= 0; i--) {
      let r = appSettings.rules[i];
      if (r.zone === zone && row == r.row && seat >= r.start && seat <= r.end) {
        if (r.color && appSettings.colorPrices && appSettings.colorPrices[r.color] !== undefined) {
            return appSettings.colorPrices[r.color];
        }
        return r.price || appSettings.basePrice || 600;
      }
    }
  }
  return appSettings.basePrice || 600;
}

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS bookings (
      seat_key VARCHAR(50) PRIMARY KEY, firstname VARCHAR(50), lastname VARCHAR(50), phone VARCHAR(30),
      reserve_firstname VARCHAR(50), reserve_lastname VARCHAR(50), group_name VARCHAR(100), status VARCHAR(20) DEFAULT 'booked',
      is_admin_booking BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      phone VARCHAR(30) PRIMARY KEY, firstname VARCHAR(50) NOT NULL, lastname VARCHAR(50) NOT NULL, group_name VARCHAR(100) NOT NULL
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

app.get('/api/auth/check-phone', async (req, res) => {
  const phone = normPhone(req.query.phone);
  if (!phone) return res.status(400).json({ error: 'Введите телефон' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE RIGHT(REGEXP_REPLACE(phone, \'[^0-9]\', \'\', \'g\'), 10) = $1', [phone]);
    if (rows.length === 0) return res.status(404).json({ error: 'Номер не найден в базе.' });
    res.json({ found: true, user: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/admin/users', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  const { rows } = await pool.query('SELECT * FROM users ORDER BY lastname, firstname');
  res.json(rows);
});

app.post('/api/admin/bulk-users', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Нет доступа' });
  const { users } = req.body;
  if (!Array.isArray(users) || users.length === 0) return res.status(400).json({ error: 'Список пуст' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of users) {
      if (!u.firstname || !u.lastname || !u.phone || !u.group_name) continue;
      await client.query(
        `INSERT INTO users (phone, firstname, lastname, group_name) VALUES ($1, $2, $3, $4) 
         ON CONFLICT (phone) DO UPDATE SET firstname=$2, lastname=$3, group_name=$4`, 
        [u.phone.trim(), u.firstname.trim(), u.lastname.trim(), u.group_name.trim()]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: users.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  } finally { client.release(); }
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

app.post('/api/bookings', rateLimit(60000, 20), async (req, res) => {
  const { seats, phone, reserveFirstname, reserveLastname, groupName, adminPass, ignoreLimit, manualBooking, manualFirstname, manualLastname, manualGroup } = req.body || {};
  
  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'Не выбраны места' });
  if (seats.length > 20) return res.status(400).json({ error: 'Слишком много мест' });

  const isAdmin = (adminPass === ADMIN_PASSWORD);
  
  let fName = '', lName = '', userGroup = groupName || '';
  let actualPhone = phone ? phone.trim() : '';

  if (isAdmin && manualBooking) {
      if (!manualFirstname || !manualLastname) return res.status(400).json({ error: 'Введите имя и фамилию' });
      fName = manualFirstname.trim();
      lName = manualLastname.trim();
      userGroup = manualGroup ? manualGroup.trim() : '';
      if (!actualPhone) actualPhone = 'Админ';
  } else {
      const digits = normPhone(phone);
      if (digits.length < 10) return res.status(400).json({ error: 'Введите корректный телефон' });

      try {
        const userRes = await pool.query('SELECT * FROM users WHERE RIGHT(REGEXP_REPLACE(phone, \'[^0-9]\', \'\', \'g\'), 10) = $1', [digits]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: 'Пользователь с таким телефоном не найден в базе' });
        fName = userRes.rows[0].firstname; lName = userRes.rows[0].lastname;
        userGroup = userRes.rows[0].group_name || groupName || '';
      } catch (e) { return res.status(500).json({ error: 'Ошибка проверки пользователя' }); }

      if (!isAdmin && appSettings.groupRestrictions && appSettings.groupRestrictions[userGroup]) {
          const restriction = appSettings.groupRestrictions[userGroup];
          if (restriction !== 'both') {
              const side = getSeatSide(seats[0]);
              if (side !== restriction) {
                  return res.status(403).json({ error: `Ваша группа может бронировать только ${restriction === 'left' ? 'левую' : 'правую'} часть зала.` });
              }
          }
      }
  }

  const useLimit = isAdmin ? (ignoreLimit !== true) : true;
  const isAdminBooking = isAdmin && !useLimit;
  
  const rFName = reserveFirstname ? reserveFirstname.trim() : null;
  const rLName = reserveLastname ? reserveLastname.trim() : null;
  if ((rFName && !rLName) || (!rFName && rLName)) return res.status(400).json({ error: 'Для резерва нужно ввести и имя, и фамилию' });

  let limitPhone = actualPhone;
  let limitFName = fName;
  let limitLName = lName;

  if (rFName && rLName) {
    try {
      const rUserRes = await pool.query('SELECT phone, firstname, lastname FROM users WHERE LOWER(lastname) = LOWER($1) AND LOWER(firstname) = LOWER($2)', [rLName, rFName]);
      if (rUserRes.rows.length === 0) {
        return res.status(400).json({ error: `Резерв ${rFName} ${rLName} не найден в базе клиентов. Проверьте написание.` });
      }
      limitPhone = rUserRes.rows[0].phone;
      limitFName = rUserRes.rows[0].firstname;
      limitLName = rUserRes.rows[0].lastname;
    } catch (e) { return res.status(500).json({ error: 'Ошибка поиска резерва' }); }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [`user:${normPhone(limitPhone)}`]);
    
    const { rows: existing } = await client.query('SELECT seat_key FROM bookings WHERE seat_key = ANY($1)', [seats]);
    if (existing.length > 0) { 
        await client.query('ROLLBACK'); 
        return res.status(409).json({ 
            error: 'Места уже заняты', 
            code: 'SEATS_TAKEN',
            takenSeats: existing.map(r => r.seat_key)
        }); 
    }

    if (useLimit) {
      const { rows: userRows } = await client.query(
        `SELECT COUNT(*) as count FROM bookings 
         WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $1 
         AND status='booked' AND COALESCE(is_admin_booking, false) = false`, 
        [normPhone(limitPhone)]
      );
      const userUsed = parseInt(userRows[0].count, 10);
      if (userUsed + seats.length > appSettings.maxSeats) {
        await client.query('ROLLBACK'); 
        return res.status(409).json({ error: `У ${limitFName} ${limitLName} уже занято ${userUsed} из ${appSettings.maxSeats} мест.`, code: 'LIMIT_EXCEEDED' });
      }
    }

    for (const seat of seats) {
      const r = await client.query(
        `INSERT INTO bookings (seat_key, firstname, lastname, phone, reserve_firstname, reserve_lastname, group_name, status, is_admin_booking) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'booked', $8) ON CONFLICT (seat_key) DO NOTHING RETURNING seat_key`, 
        [seat, fName, lName, actualPhone, rFName, rLName, userGroup, isAdminBooking]
      );
      if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Место занято', code: 'SEATS_TAKEN', takenSeats: [seat] }); }
    }
    await client.query('COMMIT'); 
    res.json({ ok: true });
  } catch (err) { 
    await client.query('ROLLBACK'); 
    res.status(500).json({ error: 'Ошибка бронирования' }); 
  } finally { client.release(); }
});

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

app.get('/api/admin/bookings-by-users', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    const { rows } = await pool.query(`
      SELECT phone, firstname, lastname, COUNT(*) as seat_count, STRING_AGG(seat_key, ', ') as seats
      FROM bookings WHERE status = 'booked'
      GROUP BY phone, firstname, lastname ORDER BY lastname, firstname
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/admin/bulk-cancel-users', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  const { phones } = req.body;
  if (!phones || !phones.length) return res.status(400).json({ error: 'Никто не выбран для удаления' });
  try {
    const normPhones = phones.map(p => p.replace(/\D/g, '').slice(-10));
    await pool.query(`DELETE FROM bookings WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = ANY($1) AND status = 'booked'`, [normPhones]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД: ' + err.message }); }
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

// ЭКСПОРТ EXCEL (С ВОЗВРАЩЕННОЙ СВОДКОЙ)
app.get('/api/admin/export', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('Доступ запрещен');
  const sideFilter = req.query.side;
  
  try {
    const { rows: booked } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at ASC");
    const filteredBooked = booked.filter(b => {
        if (!sideFilter || sideFilter === 'all') return true;
        return getSeatSide(b.seat_key) === sideFilter;
    });

    const workbook = new ExcelJS.Workbook();
    
    // ЛИСТ 1: БИЛЕТЫ
    const sheet1 = workbook.addWorksheet('Билеты');
    sheet1.columns = [ 
      { header: 'Зона', key: 'zone', width: 20 }, { header: 'Ряд', key: 'row', width: 10 }, 
      { header: 'Место', key: 'seat', width: 10 }, { header: 'Фамилия', key: 'lastname', width: 20 }, 
      { header: 'Имя', key: 'firstname', width: 20 }, { header: 'Телефон', key: 'phone', width: 20 }, 
      { header: 'Резерв', key: 'reserve', width: 25 }, { header: 'Группа', key: 'group', width: 20 }, 
      { header: 'Админ', key: 'admin', width: 10 }, { header: 'Сумма', key: 'price', width: 15 } 
    ];

    // ЛИСТ 2: СВОДКА
    const sheet2 = workbook.addWorksheet('Сводка');
    sheet2.columns = [
      { header: 'Фамилия', key: 'lastname', width: 20 }, { header: 'Имя', key: 'firstname', width: 20 },
      { header: 'Телефон', key: 'phone', width: 20 }, { header: 'Группа', key: 'group', width: 20 },
      { header: 'Всего мест', key: 'count', width: 15 }, { header: 'Из них админских', key: 'adminCount', width: 15 },
      { header: 'Итого сумма', key: 'total', width: 15 }
    ];

    const summaryMap = {};

    filteredBooked.forEach(b => {
      let zoneName = 'Балкон'; let row = 0, seat = 0;
      if (b.seat_key.startsWith('parterre-')) { zoneName = 'Партер'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('central-')) { zoneName = 'Центр. балкон'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('balc-')) { const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; zoneName = b.seat_key.includes('left') ? 'Левый балкон' : 'Правый балкон'; }
      
      const price = getPrice(b.seat_key);
      const reserveStr = (b.reserve_lastname && b.reserve_firstname) ? `${b.reserve_lastname} ${b.reserve_firstname}` : '';
      
      sheet1.addRow({
        zone: zoneName, row: row, seat: seat, lastname: b.lastname, firstname: b.firstname,
        phone: b.phone, reserve: reserveStr, group: b.group_name || '',
        admin: b.is_admin_booking ? 'да' : '', price: price
      });

      const personKey = `${b.lastname}_${b.firstname}_${b.phone}`;
      if (!summaryMap[personKey]) {
        summaryMap[personKey] = { lastname: b.lastname, firstname: b.firstname, phone: b.phone, group: b.group_name || '', count: 0, adminCount: 0, total: 0 };
      }
      summaryMap[personKey].count++;
      if (b.is_admin_booking) summaryMap[personKey].adminCount++;
      summaryMap[personKey].total += price;
    });

    Object.values(summaryMap).forEach(p => sheet2.addRow(p));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tickets_${sideFilter || 'all'}.xlsx"`);
    await workbook.xlsx.write(res); res.end();
  } catch (err) { res.status(500).send('Ошибка'); }
});

// ВОЗВРАЩЕННЫЙ ЭКСПОРТ В WORD
app.get('/api/admin/export-word', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('Доступ запрещен');
  const sideFilter = req.query.side;

  try {
    const { rows: booked } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at ASC");
    const filteredBooked = booked.filter(b => {
        if (!sideFilter || sideFilter === 'all') return true;
        return getSeatSide(b.seat_key) === sideFilter;
    });

    let html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="utf-8"><title>Билеты</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 12pt; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
      th, td { border: 1px solid #000; padding: 5px; text-align: left; }
      th { background-color: #f0f0f0; font-weight: bold; }
      h1 { font-size: 16pt; }
    </style></head><body>`;

    html += `<h1>Список проданных билетов</h1>`;
    html += `<table><tr><th>Зона</th><th>Ряд</th><th>Место</th><th>Фамилия</th><th>Имя</th><th>Телефон</th><th>Резерв</th><th>Группа</th><th>Админ</th><th>Сумма</th></tr>`;

    const summaryMap = {};

    filteredBooked.forEach(b => {
      let zoneName = 'Балкон'; let row = 0, seat = 0;
      if (b.seat_key.startsWith('parterre-')) { zoneName = 'Партер'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('central-')) { zoneName = 'Центр. балкон'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('balc-')) { const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; zoneName = b.seat_key.includes('left') ? 'Левый балкон' : 'Правый балкон'; }

      const price = getPrice(b.seat_key);
      const reserveStr = (b.reserve_lastname && b.reserve_firstname) ? `${b.reserve_lastname} ${b.reserve_firstname}` : '';
      
      html += `<tr><td>${zoneName}</td><td>${row}</td><td>${seat}</td><td>${b.lastname}</td><td>${b.firstname}</td><td>${b.phone}</td><td>${reserveStr}</td><td>${b.group_name || ''}</td><td>${b.is_admin_booking ? 'да' : ''}</td><td>${price} ₽</td></tr>`;

      const personKey = `${b.lastname}_${b.firstname}_${b.phone}`;
      if (!summaryMap[personKey]) {
        summaryMap[personKey] = { lastname: b.lastname, firstname: b.firstname, phone: b.phone, group: b.group_name || '', count: 0, adminCount: 0, total: 0 };
      }
      summaryMap[personKey].count++;
      if (b.is_admin_booking) summaryMap[personKey].adminCount++;
      summaryMap[personKey].total += price;
    });
    html += `</table>`;

    html += `<h1>Сводка по покупателям</h1>`;
    html += `<table><tr><th>Фамилия</th><th>Имя</th><th>Телефон</th><th>Группа</th><th>Всего мест</th><th>Из них админских</th><th>Итого сумма</th></tr>`;
    Object.values(summaryMap).forEach(p => {
      html += `<tr><td>${p.lastname}</td><td>${p.firstname}</td><td>${p.phone}</td><td>${p.group}</td><td>${p.count}</td><td>${p.adminCount}</td><td>${p.total} ₽</td></tr>`;
    });
    html += `</table></body></html>`;

    res.setHeader('Content-Type', 'application/msword');
    res.setHeader('Content-Disposition', `attachment; filename="tickets_${sideFilter || 'all'}.doc"`);
    res.send(html);
  } catch (err) { res.status(500).send('Ошибка'); }
});

app.listen(PORT, () => console.log(`Сервер: ${PORT}`));
