const express = require('express');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SEATS_PER_PERSON = 4;
const ADMIN_PASSWORD = "admin123"; 

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'prices'");
    res.json(rows.length > 0 ? rows[0].value : {});
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/admin/settings', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('prices', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [req.body]
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
    res.json({ used: parseInt(rows[0].count, 10), max: MAX_SEATS_PER_PERSON, left: Math.max(0, MAX_SEATS_PER_PERSON - parseInt(rows[0].count, 10)) });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/bookings', async (req, res) => {
  const { seats, fullname, phone } = req.body || {};
  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'Не выбраны места' });
  const digits = String(phone || '').replace(/\D/g, '');
  if (typeof fullname !== 'string' || fullname.trim().length < 2 || digits.length < 10) return res.status(400).json({ error: 'Проверьте имя и телефон' });

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
    if (used + seats.length > MAX_SEATS_PER_PERSON) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `На этот номер уже забронировано ${used} мест.` });
    }

    for (const seat of seats) {
      await client.query("INSERT INTO bookings (seat_key, fullname, phone, status) VALUES ($1, $2, $3, 'booked')", [seat, fullname.trim(), phone.trim()]);
    }
    await client.query('COMMIT');
    const { rows: all } = await client.query("SELECT seat_key, status FROM bookings");
    res.json({ ok: true, booked: all, left: MAX_SEATS_PER_PERSON - (used + seats.length) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Ошибка при бронировании: ' + err.message });
  } finally { client.release(); }
});

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

// НОВЫЙ ЭНДПОИНТ: Снять ВСЕ блокировки разом
app.post('/api/admin/unblock-all', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    await pool.query("DELETE FROM bookings WHERE status = 'blocked'");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// ЭКСПОРТ В EXCEL
app.get('/api/admin/export', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('Доступ запрещен');
  try {
    const { rows: booked } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at ASC");
    const { rows: settingsRows } = await pool.query("SELECT value FROM settings WHERE key = 'prices'");
    const priceSettings = settingsRows.length > 0 ? settingsRows[0].value : { default: { price: 600 } };

    const getPrice = (key) => {
      let zone = 'balcon';
      let row = 0, seat = 0;
      if (key.startsWith('parterre-')) { zone = 'parterre'; const parts = key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (key.startsWith('central-')) { zone = 'central'; const parts = key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (key.startsWith('balc-')) { const parts = key.split('-'); row = parseInt(parts[2]); seat = parseInt(parts[3]); }
      
      if (priceSettings.rules) {
        for (let i = priceSettings.rules.length - 1; i >= 0; i--) {
          let r = priceSettings.rules[i];
          if (r.zone === zone && row == r.row && seat >= r.start && seat <= r.end) return r.price;
        }
      }
      return priceSettings.default ? priceSettings.default.price : 600;
    };

    const workbook = new ExcelJS.Workbook();
    
    // Лист 1: Все билеты
    const sheet1 = workbook.addWorksheet('Билеты');
    sheet1.columns = [
      { header: 'Зона', key: 'zone', width: 20 },
      { header: 'Ряд', key: 'row', width: 10 },
      { header: 'Место', key: 'seat', width: 10 },
      { header: 'Имя', key: 'name', width: 30 },
      { header: 'Телефон', key: 'phone', width: 20 },
      { header: 'Сумма', key: 'price', width: 15 }
    ];
    
    // Лист 2: Сводка
    const sheet2 = workbook.addWorksheet('Сводка');
    sheet2.columns = [
      { header: 'Имя', key: 'name', width: 30 },
      { header: 'Телефон', key: 'phone', width: 20 },
      { header: 'Кол-во мест', key: 'count', width: 15 },
      { header: 'Итого сумма', key: 'total', width: 15 }
    ];

    const summaryMap = {};

    booked.forEach(b => {
      let zoneName = 'Балкон';
      let row = 0, seat = 0;
      
      if (b.seat_key.startsWith('parterre-')) { zoneName = 'Партер'; const parts = b.seat_key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (b.seat_key.startsWith('central-')) { zoneName = 'Центр. балкон'; const parts = b.seat_key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (b.seat_key.startsWith('balc-left-')) { zoneName = 'Левый балкон'; const parts = b.seat_key.split('-'); row = parseInt(parts[2]); seat = parseInt(parts[3]); }
      else if (b.seat_key.startsWith('balc-right-')) { zoneName = 'Правый балкон'; const parts = b.seat_key.split('-'); row = parseInt(parts[2]); seat = parseInt(parts[3]); }

      const price = getPrice(b.seat_key);
      sheet1.addRow({
        zone: zoneName,
        row: row,
        seat: seat,
        name: b.fullname,
        phone: b.phone,
        price: price
      });

      const personKey = `${b.fullname}_${b.phone}`;
      if (!summaryMap[personKey]) {
        summaryMap[personKey] = { name: b.fullname, phone: b.phone, count: 0, total: 0 };
      }
      summaryMap[personKey].count++;
      summaryMap[personKey].total += price;
    });

    Object.values(summaryMap).forEach(p => {
      sheet2.addRow(p);
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка экспорта: ' + err.message);
  }
});

app.get('/admin', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('<h1>Доступ запрещен</h1>');
  try {
    const { rows } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at DESC");
    let html = `<html><head><meta charset="utf-8"><title>Админка</title><style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%;margin-top:20px}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#f4f4f4}</style></head><body><h1>Проданные билеты (${rows.length} шт.)</h1><table><tr><th>Место</th><th>Имя</th><th>Телефон</th><th>Дата</th></tr>`;
    rows.forEach(r => { html += `<tr><td>${r.seat_key}</td><td>${r.fullname}</td><td>${r.phone}</td><td>${new Date(r.created_at).toLocaleString('ru-RU')}</td></tr>`; });
    html += `</table></body></html>`;
    res.send(html);
  } catch (err) { res.status(500).send('Ошибка БД'); }
});

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
