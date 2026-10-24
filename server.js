const express = require('express');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "admin123"; 

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let appSettings = {
  default: { price: 600, color: '#2a3342' },
  rules: [],
  hidden: { left: false, right: false },
  maxSeats: 4,
  bgUrl: '', bgSize: 'cover', bgPosX: 50, bgPosY: 50,
  restrictAdminSeats: true,
  groups: { left: [], right: [] }
};

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        seat_key VARCHAR(50) PRIMARY KEY,
        firstname VARCHAR(50),
        lastname VARCHAR(50),
        phone VARCHAR(30),
        reserve_phone VARCHAR(30),
        group_name VARCHAR(100),
        status VARCHAR(20) DEFAULT 'booked',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Миграции
    await pool.query(`ALTER TABLE bookings ALTER COLUMN seat_key TYPE VARCHAR(50);`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS firstname VARCHAR(50);`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS lastname VARCHAR(50);`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reserve_phone VARCHAR(30);`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS group_name VARCHAR(100);`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'booked';`).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value JSONB
      )
    `);

    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'app_settings'");
    if (rows.length > 0) {
      appSettings = { ...appSettings, ...rows[0].value };
    } else {
      await pool.query("INSERT INTO settings (key, value) VALUES ('app_settings', $1)", [appSettings]);
    }
    console.log('База данных готова к работе');
  } catch (err) {
    console.error('Ошибка инициализации БД:', err);
  }
}
initDB();

function normalizePhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

app.get('/api/settings', (req, res) => { res.json(appSettings); });
app.post('/api/admin/settings', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    appSettings = req.body;
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'app_settings'", [appSettings]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/bookings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT seat_key, status FROM bookings');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/limit', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'Телефон обязателен' });
  try {
    const normPhone = normalizePhone(phone);
    const { rows } = await pool.query(
      "SELECT COUNT(*) as count FROM bookings WHERE RIGHT(REGEXP_REPLACE(COALESCE(reserve_phone, phone), '\\D', '', 'g'), 10) = $1 AND status = 'booked'",
      [normPhone]
    );
    res.json({ used: parseInt(rows[0].count, 10), max: appSettings.maxSeats, left: Math.max(0, appSettings.maxSeats - parseInt(rows[0].count, 10)) });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/bookings', async (req, res) => {
  const { seats, firstname, lastname, phone, reservePhone, groupName, adminPass } = req.body || {};
  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'Не выбраны места' });
  
  const digits = String(phone || '').replace(/\D/g, '');
  if (!firstname || firstname.trim().length < 2) return res.status(400).json({ error: 'Введите имя' });
  if (!lastname || lastname.trim().length < 2) return res.status(400).json({ error: 'Введите фамилию' });
  if (digits.length < 10) return res.status(400).json({ error: 'Введите корректный телефон' });

  const isAdminOverride = (adminPass === ADMIN_PASSWORD);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT seat_key FROM bookings WHERE seat_key = ANY($1) FOR UPDATE', [seats]);
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Эти места уже выбрал кто-то другой 🥲. Обновите страницу.' });
    }

    // Если указан резерв, считаем лимит по номеру резерва, иначе по своему
    const targetPhone = reservePhone && reservePhone.trim().length > 5 ? reservePhone.trim() : phone.trim();
    const normTargetPhone = normalizePhone(targetPhone);

    const { rows: countRows } = await client.query(
      "SELECT COUNT(*) as count FROM bookings WHERE RIGHT(REGEXP_REPLACE(COALESCE(reserve_phone, phone), '\\D', '', 'g'), 10) = $1 AND status = 'booked'",
      [normTargetPhone]
    );
    const used = parseInt(countRows[0].count, 10);
    
    if (!isAdminOverride && (used + seats.length > appSettings.maxSeats)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Превышен лимит мест. У номера ${targetPhone} уже занято ${used} мест из ${appSettings.maxSeats}.` });
    }

    for (const seat of seats) {
      await client.query(
        "INSERT INTO bookings (seat_key, firstname, lastname, phone, reserve_phone, group_name, status) VALUES ($1, $2, $3, $4, $5, $6, 'booked')", 
        [seat, firstname.trim(), lastname.trim(), phone.trim(), reservePhone ? reservePhone.trim() : null, groupName || '']
      );
    }
    await client.query('COMMIT');
    const { rows: all } = await client.query("SELECT seat_key, status FROM bookings");
    res.json({ ok: true, booked: all, left: appSettings.maxSeats - (used + seats.length) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Ошибка при бронировании: ' + err.message });
  } finally { client.release(); }
});

// НОВЫЙ ЭНДПОИНТ ДЛЯ ПОИСКА СВОИХ БИЛЕТОВ
app.get('/api/my-tickets', async (req, res) => {
  const { phone, lastname } = req.query;
  if (!phone || !lastname) return res.status(400).json({ error: 'Введите телефон и фамилию' });
  try {
    const normPhone = normalizePhone(phone);
    // Ищем где он сам бронировал (по совпадению телефона и фамилии) ИЛИ где он является резервом
    const { rows } = await pool.query(`
      SELECT seat_key, firstname, lastname, phone, reserve_phone, status 
      FROM bookings 
      WHERE (RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1 AND LOWER(lastname) = LOWER($2))
         OR (RIGHT(REGEXP_REPLACE(reserve_phone, '\\D', '', 'g'), 10) = $1)
      AND status = 'booked'
    `, [normPhone, lastname.trim()]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка БД: ' + err.message }); }
});

app.post('/api/cancel', async (req, res) => {
  const { seats, phone } = req.body;
  if (!seats || !seats.length) return res.status(400).json({ error: 'Не выбраны места' });
  try {
    const normPhone = normalizePhone(phone);
    await pool.query("DELETE FROM bookings WHERE seat_key = ANY($1) AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $2 AND status = 'booked'", [seats, normPhone]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка при отмене' }); }
});

app.post('/api/admin/toggle-block', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  const { seat } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM bookings WHERE seat_key = $1', [seat]);
    if (rows.length > 0) {
      if (rows[0].status === 'blocked') {
        await pool.query('DELETE FROM bookings WHERE seat_key = $1', [seat]);
        return res.json({ status: 'free' });
      } else {
        return res.status(400).json({ error: 'Место уже забронировано' });
      }
    } else {
      await pool.query("INSERT INTO bookings (seat_key, firstname, phone, status) VALUES ($1, 'Админ', 'Заблокировано', 'blocked')", [seat]);
      return res.json({ status: 'blocked' });
    }
  } catch (err) { res.status(500).json({ error: 'Ошибка БД: ' + err.message }); }
});

app.get('/api/admin/export', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('Доступ запрещен');
  try {
    const { rows: booked } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at ASC");

    const getPrice = (key) => {
      let zone = 'balcon'; let side = 'left'; let row = 0, seat = 0;
      if (key.startsWith('parterre-')) { zone = 'parterre'; const parts = key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (key.startsWith('central-')) { zone = 'central'; const parts = key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (key.startsWith('balc-')) { const parts = key.split('-'); side = parts[1]; row = parseInt(parts[2]); seat = parseInt(parts[3]); }
      
      if (appSettings.rules) {
        for (let i = appSettings.rules.length - 1; i >= 0; i--) {
          let r = appSettings.rules[i];
          if (r.zone === zone && row == r.row && seat >= r.start && seat <= r.end) return r.price;
        }
      }
      return appSettings.default ? appSettings.default.price : 600;
    };

    const workbook = new ExcelJS.Workbook();
    const sheet1 = workbook.addWorksheet('Билеты');
    sheet1.columns = [
      { header: 'Зона', key: 'zone', width: 20 }, { header: 'Ряд', key: 'row', width: 10 },
      { header: 'Место', key: 'seat', width: 10 }, { header: 'Фамилия', key: 'lastname', width: 20 },
      { header: 'Имя', key: 'firstname', width: 20 }, { header: 'Телефон', key: 'phone', width: 20 },
      { header: 'Резерв (чей)', key: 'reserve', width: 20 }, { header: 'Группа', key: 'group', width: 20 }, { header: 'Сумма', key: 'price', width: 15 }
    ];
    const sheet2 = workbook.addWorksheet('Сводка');
    sheet2.columns = [
      { header: 'Фамилия', key: 'lastname', width: 20 }, { header: 'Имя', key: 'firstname', width: 20 },
      { header: 'Телефон', key: 'phone', width: 20 }, { header: 'Группа', key: 'group', width: 20 }, 
      { header: 'Кол-во мест', key: 'count', width: 15 }, { header: 'Итого сумма', key: 'total', width: 15 }
    ];

    const summaryMap = {};
    booked.forEach(b => {
      let zoneName = 'Балкон'; let row = 0, seat = 0;
      if (b.seat_key.startsWith('parterre-')) { zoneName = 'Партер'; const parts = b.seat_key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (b.seat_key.startsWith('central-')) { zoneName = 'Центр. балкон'; const parts = b.seat_key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (b.seat_key.startsWith('balc-left-')) { zoneName = 'Левый балкон'; const parts = b.seat_key.split('-'); row = parseInt(parts[2]); seat = parseInt(parts[3]); }
      else if (b.seat_key.startsWith('balc-right-')) { zoneName = 'Правый балкон'; const parts = b.seat_key.split('-'); row = parseInt(parts[2]); seat = parseInt(parts[3]); }

      const price = getPrice(b.seat_key);
      sheet1.addRow({ zone: zoneName, row: row, seat: seat, lastname: b.lastname, firstname: b.firstname, phone: b.phone, reserve: b.reserve_phone || '', group: b.group_name || '', price: price });

      const personKey = `${b.lastname}_${b.firstname}_${b.phone}`;
      if (!summaryMap[personKey]) summaryMap[personKey] = { lastname: b.lastname, firstname: b.firstname, phone: b.phone, group: b.group_name || '', count: 0, total: 0 };
      summaryMap[personKey].count++; summaryMap[personKey].total += price;
    });

    Object.values(summaryMap).forEach(p => sheet2.addRow(p));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { res.status(500).send('Ошибка экспорта: ' + err.message); }
});

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
