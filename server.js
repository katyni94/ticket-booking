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
  bgUrl: '',
  bgSize: 'cover',
  bgPosX: 50,
  bgPosY: 50,
  restrictAdminSeats: true // Галочка ограничения для админа
};

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        seat_key VARCHAR(50) PRIMARY KEY,
        fullname VARCHAR(100),
        phone VARCHAR(30),
        status VARCHAR(20) DEFAULT 'booked',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE bookings ALTER COLUMN seat_key TYPE VARCHAR(50);`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ALTER COLUMN fullname DROP NOT NULL;`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ALTER COLUMN phone DROP NOT NULL;`).catch(()=>{});
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

app.get('/api/settings', (req, res) => {
  res.json(appSettings);
});

app.post('/api/admin/settings', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    appSettings = req.body;
    await pool.query(
      "UPDATE settings SET value = $1 WHERE key = 'app_settings'",
      [appSettings]
    );
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
      "SELECT COUNT(*) as count FROM bookings WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1 AND status = 'booked'",
      [normPhone]
    );
    res.json({ used: parseInt(rows[0].count, 10), max: appSettings.maxSeats, left: Math.max(0, appSettings.maxSeats - parseInt(rows[0].count, 10)) });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/bookings', async (req, res) => {
  const { seats, fullname, phone, adminPass } = req.body || {};
  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'Не выбраны места' });
  const digits = String(phone || '').replace(/\D/g, '');
  if (typeof fullname !== 'string' || fullname.trim().length < 2 || digits.length < 10) return res.status(400).json({ error: 'Проверьте имя и телефон' });

  const isAdminOverride = (adminPass === ADMIN_PASSWORD); // Проверяем, админ ли обходит лимит

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT seat_key FROM bookings WHERE seat_key = ANY($1) FOR UPDATE', [seats]);
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Места уже заняты или заблокированы.' });
    }

    const normPhone = normalizePhone(phone);
    const { rows: countRows } = await client.query(
      "SELECT COUNT(*) as count FROM bookings WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1 AND status = 'booked'",
      [normPhone]
    );
    const used = parseInt(countRows[0].count, 10);
    
    // Если это НЕ админ-обход, проверяем лимит
    if (!isAdminOverride && (used + seats.length > appSettings.maxSeats)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `На этот номер уже забронировано ${used} мест. Максимум: ${appSettings.maxSeats}.` });
    }

    for (const seat of seats) {
      await client.query("INSERT INTO bookings (seat_key, fullname, phone, status) VALUES ($1, $2, $3, 'booked')", [seat, fullname.trim(), phone.trim()]);
    }
    await client.query('COMMIT');
    const { rows: all } = await client.query("SELECT seat_key, status FROM bookings");
    res.json({ ok: true, booked: all, left: appSettings.maxSeats - (used + seats.length) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Ошибка при бронировании: ' + err.message });
  } finally { client.release(); }
});

// Остальные эндпоинты (my-bookings, cancel, toggle-block, unblock-all, export, admin) остаются без изменений...
// ... (скопируйте их из предыдущего рабочего server.js) ...

app.get('/api/my-bookings', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'Введите телефон' });
  try {
    const normPhone = normalizePhone(phone);
    const { rows } = await pool.query("SELECT seat_key FROM bookings WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1 AND status = 'booked'", [normPhone]);
    res.json(rows.map(r => r.seat_key));
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
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
      await pool.query("INSERT INTO bookings (seat_key, fullname, phone, status) VALUES ($1, 'Админ', 'Заблокировано', 'blocked')", [seat]);
      return res.json({ status: 'blocked' });
    }
  } catch (err) { res.status(500).json({ error: 'Ошибка БД: ' + err.message }); }
});

app.post('/api/admin/unblock-all', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    await pool.query("DELETE FROM bookings WHERE status = 'blocked'");
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД: ' + err.message }); }
});

app.get('/api/admin/export', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('Доступ запрещен');
  try {
    const { rows: booked } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at ASC");

    const getPrice = (key) => {
      let zone = 'balcon'; let row = 0, seat = 0;
      if (key.startsWith('parterre-')) { zone = 'parterre'; const parts = key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (key.startsWith('central-')) { zone = 'central'; const parts = key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (key.startsWith('balc-')) { const parts = key.split('-'); row = parseInt(parts[2]); seat = parseInt(parts[3]); }
      
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
      { header: 'Место', key: 'seat', width: 10 }, { header: 'Имя', key: 'name', width: 30 },
      { header: 'Телефон', key: 'phone', width: 20 }, { header: 'Сумма', key: 'price', width: 15 }
    ];
    const sheet2 = workbook.addWorksheet('Сводка');
    sheet2.columns = [
      { header: 'Имя', key: 'name', width: 30 }, { header: 'Телефон', key: 'phone', width: 20 },
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
      sheet1.addRow({ zone: zoneName, row: row, seat: seat, name: b.fullname, phone: b.phone, price: price });

      const personKey = `${b.fullname}_${b.phone}`;
      if (!summaryMap[personKey]) summaryMap[personKey] = { name: b.fullname, phone: b.phone, count: 0, total: 0 };
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
