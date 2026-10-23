const express = require('express');
const { Pool } = require('pg');
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
    
    // Снимаем старые ограничения NOT NULL, если они остались с прошлых версий
    await pool.query(`
      DO $$ 
      BEGIN 
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='fullname' AND is_nullable='NO') THEN
          ALTER TABLE bookings ALTER COLUMN fullname DROP NOT NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='phone' AND is_nullable='NO') THEN
          ALTER TABLE bookings ALTER COLUMN phone DROP NOT NULL;
        END IF;
      END $$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value JSONB
      )
    `);
    
    console.log('База данных готова к работе');
  } catch (err) {
    console.error('Ошибка подключения к БД:', err);
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
    res.status(500).json({ error: 'Ошибка при бронировании' });
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

// ИСПРАВЛЕННЫЙ ЭНДПОИНТ БЛОКИРОВКИ
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
      // Теперь при блокировке подставляем системные значения, чтобы БД не ругалась
      await pool.query("INSERT INTO bookings (seat_key, fullname, phone, status) VALUES ($1, 'Админ', 'Заблокировано', 'blocked')", [seat]);
      return res.json({ status: 'blocked' });
    }
  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: 'Ошибка БД' }); 
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
