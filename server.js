const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SEATS_PER_PERSON = 4;
const ADMIN_PASSWORD = "admin123"; // Пароль для админки

// Подключение к базе данных Render (берется из переменных окружения)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Обязательно для Render
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Создаем таблицу при старте
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        seat_key VARCHAR(10) PRIMARY KEY,
        surname VARCHAR(100) NOT NULL,
        phone VARCHAR(30) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

// API: Получить занятые места
app.get('/api/bookings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT seat_key FROM bookings');
    res.json(rows.map(r => r.seat_key));
  } catch (err) {
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

// API: Проверить лимит по номеру
app.get('/api/limit', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'Телефон обязателен' });
  
  try {
    const normPhone = normalizePhone(phone);
    // В PostgreSQL используем RIGHT и REGEXP_REPLACE
    const { rows } = await pool.query(
      "SELECT COUNT(*) as count FROM bookings WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1",
      [normPhone]
    );
    const used = parseInt(rows[0].count, 10);
    res.json({ used, max: MAX_SEATS_PER_PERSON, left: Math.max(0, MAX_SEATS_PER_PERSON - used) });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

// API: Забронировать
app.post('/api/bookings', async (req, res) => {
  const { seats, surname, phone } = req.body || {};

  if (!Array.isArray(seats) || seats.length === 0) {
    return res.status(400).json({ error: 'Не выбраны места' });
  }

  const digits = String(phone || '').replace(/\D/g, '');
  if (typeof surname !== 'string' || surname.trim().length < 2 || digits.length < 10) {
    return res.status(400).json({ error: 'Проверьте фамилию и телефон' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Проверка занятости
    const { rows: existing } = await client.query(
      'SELECT seat_key FROM bookings WHERE seat_key = ANY($1) FOR UPDATE',
      [seats]
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Эти места только что забронировал кто-то другой. Обновите страницу.' });
    }

    // Проверка лимита
    const normPhone = normalizePhone(phone);
    const { rows: countRows } = await client.query(
      "SELECT COUNT(*) as count FROM bookings WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1",
      [normPhone]
    );
    const used = parseInt(countRows[0].count, 10);

    if (used + seats.length > MAX_SEATS_PER_PERSON) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        error: `На этот номер уже забронировано ${used} мест. Можно добавить не более ${MAX_SEATS_PER_PERSON - used}.` 
      });
    }

    // Запись
    for (const seat of seats) {
      await client.query(
        'INSERT INTO bookings (seat_key, surname, phone) VALUES ($1, $2, $3)',
        [seat, surname.trim(), phone.trim()]
      );
    }
    
    await client.query('COMMIT');
    
    const { rows: all } = await client.query('SELECT seat_key FROM bookings');
    res.json({ ok: true, booked: all.map(r => r.seat_key), left: MAX_SEATS_PER_PERSON - (used + seats.length) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ошибка при бронировании' });
  } finally {
    client.release();
  }
});

// Админка
app.get('/admin', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) {
    return res.status(401).send('<h1>Доступ запрещен</h1><p>Добавьте к адресу ?pass=ваш_пароль</p>');
  }
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    
    let html = `<html><head><meta charset="utf-8"><title>Админка</title>
    <style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#f4f4f4}</style></head>
    <body><h1>Все брони (${rows.length} мест)</h1><table>
    <tr><th>Место</th><th>Фамилия</th><th>Телефон</th><th>Дата</th></tr>`;
    
    rows.forEach(r => {
      html += `<tr><td>${r.seat_key}</td><td>${r.surname}</td><td>${r.phone}</td><td>${new Date(r.created_at).toLocaleString('ru-RU')}</td></tr>`;
    });
    
    html += `</table></body></html>`;
    res.send(html);
  } catch (err) {
    res.status(500).send('Ошибка БД');
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});