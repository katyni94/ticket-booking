const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SEATS_PER_PERSON = 4;
const ADMIN_PASSWORD = "admin123"; // Пароль для админки

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
        seat_key VARCHAR(20) PRIMARY KEY,
        fullname VARCHAR(100) NOT NULL,
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

// --- ПОЛУЧЕНИЕ ЗАНЯТЫХ МЕСТ ---
app.get('/api/bookings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT seat_key FROM bookings');
    res.json(rows.map(r => r.seat_key));
  } catch (err) {
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

// --- ПРОВЕРКА ЛИМИТА ПО ТЕЛЕФОНУ ---
app.get('/api/limit', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'Телефон обязателен' });
  
  try {
    const normPhone = normalizePhone(phone);
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

// --- БРОНИРОВАНИЕ ---
app.post('/api/bookings', async (req, res) => {
  const { seats, fullname, phone } = req.body || {};

  if (!Array.isArray(seats) || seats.length === 0) {
    return res.status(400).json({ error: 'Не выбраны места' });
  }

  const digits = String(phone || '').replace(/\D/g, '');
  if (typeof fullname !== 'string' || fullname.trim().length < 2 || digits.length < 10) {
    return res.status(400).json({ error: 'Проверьте имя и телефон' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      'SELECT seat_key FROM bookings WHERE seat_key = ANY($1) FOR UPDATE',
      [seats]
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Эти места только что забронировал кто-то другой. Обновите страницу.' });
    }

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

    for (const seat of seats) {
      await client.query(
        'INSERT INTO bookings (seat_key, fullname, phone) VALUES ($1, $2, $3)',
        [seat, fullname.trim(), phone.trim()]
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

// --- ПОЛЬЗОВАТЕЛЬ: НАЙТИ СВОИ БРОНИ ---
app.get('/api/my-bookings', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'Введите телефон' });
  try {
    const normPhone = normalizePhone(phone);
    const { rows } = await pool.query(
      "SELECT seat_key FROM bookings WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1",
      [normPhone]
    );
    res.json(rows.map(r => r.seat_key));
  } catch (err) {
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

// --- ПОЛЬЗОВАТЕЛЬ: ОТМЕНИТЬ БРОНИ ---
app.post('/api/cancel', async (req, res) => {
  const { seats, phone } = req.body;
  if (!seats || !seats.length) return res.status(400).json({ error: 'Не выбраны места для отмены' });
  
  try {
    const normPhone = normalizePhone(phone);
    // Проверяем, что эти места действительно принадлежат этому номеру
    const { rows } = await pool.query(
      "SELECT seat_key FROM bookings WHERE seat_key = ANY($1) AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $2",
      [seats, normPhone]
    );
    if (rows.length !== seats.length) {
      return res.status(403).json({ error: 'Некоторые места вам не принадлежат' });
    }
    await pool.query(
      "DELETE FROM bookings WHERE seat_key = ANY($1) AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $2",
      [seats, normPhone]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка при отмене' });
  }
});

// --- АДМИНКА ---
app.get('/admin', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) {
    return res.status(401).send('<h1>Доступ запрещен</h1><p>Добавьте к адресу ?pass=ваш_пароль</p>');
  }
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    
    let html = `<html><head><meta charset="utf-8"><title>Админка</title>
    <style>
      body{font-family:sans-serif;padding:20px}
      table{border-collapse:collapse;width:100%;margin-top:20px}
      th,td{border:1px solid #ccc;padding:8px;text-align:left}
      th{background:#f4f4f4}
      .btn-red{background:#d9534f;color:white;border:none;padding:5px 10px;border-radius:3px;cursor:pointer}
      .btn-red:hover{background:#c9302c}
    </style></head>
    <body>
    <h1>Все брони (${rows.length} мест)</h1>
    <table>
    <tr><th>Место</th><th>Имя</th><th>Телефон</th><th>Дата</th><th>Действие</th></tr>`;
    
    rows.forEach(r => {
      html += `<tr>
        <td>${r.seat_key}</td>
        <td>${r.fullname}</td>
        <td>${r.phone}</td>
        <td>${new Date(r.created_at).toLocaleString('ru-RU')}</td>
        <td><button class="btn-red" onclick="deleteSeat('${r.seat_key}')">Удалить</button></td>
      </tr>`;
    });
    
    html += `</table>
    <script>
      async function deleteSeat(seat) {
        if (!confirm('Удалить бронь на место ' + seat + '?')) return;
        const pass = new URLSearchParams(window.location.search).get('pass');
        const res = await fetch('/api/admin/delete-seat?pass=' + pass, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ seat })
        });
        if (res.ok) location.reload();
        else alert('Ошибка удаления');
      }
    </script>
    </body></html>`;
    res.send(html);
  } catch (err) {
    res.status(500).send('Ошибка БД');
  }
});

// --- АДМИН: УДАЛИТЬ КОНКРЕТНОЕ МЕСТО ---
app.post('/api/admin/delete-seat', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    await pool.query('DELETE FROM bookings WHERE seat_key = $1', [req.body.seat]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
