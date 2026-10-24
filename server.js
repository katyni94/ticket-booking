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
  basePrice: 600,
  colorPrices: { '#FFC000': 600, '#FFFF00': 800, '#92D050': 1000, '#C55A11': 1100, '#00B0F0': 1300, '#B4A7D6': 1400, '#F4B183': 1500 },
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
        reserve_firstname VARCHAR(50),
        reserve_lastname VARCHAR(50),
        group_name VARCHAR(100),
        status VARCHAR(20) DEFAULT 'booked',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE bookings ALTER COLUMN seat_key TYPE VARCHAR(50);`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS firstname VARCHAR(50);`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS lastname VARCHAR(50);`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reserve_firstname VARCHAR(50);`).catch(()=>{});
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reserve_lastname VARCHAR(50);`).catch(()=>{});
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
  const { firstname, lastname } = req.query;
  if (!firstname || !lastname) return res.status(400).json({ error: 'Имя и фамилия обязательны' });
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as count FROM bookings 
       WHERE ((LOWER(firstname) = LOWER($1) AND LOWER(lastname) = LOWER($2)) 
          OR (LOWER(reserve_firstname) = LOWER($1) AND LOWER(reserve_lastname) = LOWER($2))) 
       AND status = 'booked'`,
      [firstname.trim(), lastname.trim()]
    );
    const used = parseInt(rows[0].count, 10);
    res.json({ used, max: appSettings.maxSeats, left: Math.max(0, appSettings.maxSeats - used) });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/bookings', async (req, res) => {
  const { seats, firstname, lastname, phone, reserveFirstname, reserveLastname, groupName, adminPass } = req.body || {};
  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'Не выбраны места' });
  
  const digits = String(phone || '').replace(/\D/g, '');
  if (!firstname || firstname.trim().length < 2) return res.status(400).json({ error: 'Введите имя' });
  if (!lastname || lastname.trim().length < 2) return res.status(400).json({ error: 'Введите фамилию' });
  if (digits.length < 10) return res.status(400).json({ error: 'Введите корректный телефон' });

  const isAdminOverride = (adminPass === ADMIN_PASSWORD);
  const fName = firstname.trim();
  const lName = lastname.trim();
  const rFName = reserveFirstname ? reserveFirstname.trim() : null;
  const rLName = reserveLastname ? reserveLastname.trim() : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT seat_key FROM bookings WHERE seat_key = ANY($1) FOR UPDATE', [seats]);
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Эти места уже выбрал кто-то другой 🥲. Обновите страницу.' });
    }

    if (!isAdminOverride) {
      const { rows: userRows } = await client.query(
        `SELECT COUNT(*) as count FROM bookings 
         WHERE ((LOWER(firstname) = LOWER($1) AND LOWER(lastname) = LOWER($2)) 
            OR (LOWER(reserve_firstname) = LOWER($1) AND LOWER(reserve_lastname) = LOWER($2))) 
         AND status = 'booked'`, [fName, lName]
      );
      const userUsed = parseInt(userRows[0].count, 10);
      if (userUsed + seats.length > appSettings.maxSeats) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `У вас уже занято ${userUsed} мест из ${appSettings.maxSeats}.` });
      }

      if (rFName && rLName) {
        const { rows: resRows } = await client.query(
          `SELECT COUNT(*) as count FROM bookings 
           WHERE ((LOWER(firstname) = LOWER($1) AND LOWER(lastname) = LOWER($2)) 
              OR (LOWER(reserve_firstname) = LOWER($1) AND LOWER(reserve_lastname) = LOWER($2))) 
           AND status = 'booked'`, [rFName, rLName]
        );
        const resUsed = parseInt(resRows[0].count, 10);
        if (resUsed + seats.length > appSettings.maxSeats) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `У ${rFName} ${rLName} уже занято ${resUsed} мест из ${appSettings.maxSeats}. Резерв исчерпан.` });
        }
      }
    }

    for (const seat of seats) {
      await client.query(
        "INSERT INTO bookings (seat_key, firstname, lastname, phone, reserve_firstname, reserve_lastname, group_name, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'booked')", 
        [seat, fName, lName, phone.trim(), rFName, rLName, groupName || '']
      );
    }
    await client.query('COMMIT');
    const { rows: all } = await client.query("SELECT seat_key, status FROM bookings");
    res.json({ ok: true, booked: all });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Ошибка при бронировании: ' + err.message });
  } finally { client.release(); }
});

app.get('/api/my-tickets', async (req, res) => {
  const { firstname, lastname } = req.query;
  if (!firstname || !lastname) return res.status(400).json({ error: 'Введите имя и фамилию' });
  try {
    const { rows } = await pool.query(`
      SELECT seat_key, firstname, lastname, phone, reserve_firstname, reserve_lastname, status 
      FROM bookings 
      WHERE (LOWER(firstname) = LOWER($1) AND LOWER(lastname) = LOWER($2))
         OR (LOWER(reserve_firstname) = LOWER($1) AND LOWER(reserve_lastname) = LOWER($2))
      AND status = 'booked'
    `, [firstname.trim(), lastname.trim()]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка БД: ' + err.message }); }
});

app.post('/api/cancel', async (req, res) => {
  const { seats, firstname, lastname } = req.body;
  if (!seats || !seats.length) return res.status(400).json({ error: 'Не выбраны места' });
  try {
    await pool.query(
      "DELETE FROM bookings WHERE seat_key = ANY($1) AND LOWER(firstname) = LOWER($2) AND LOWER(lastname) = LOWER($3) AND status = 'booked'", 
      [seats, firstname.trim(), lastname.trim()]
    );
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

// НОВЫЙ ЭНДПОИНТ: Получить данные о брони для админа
app.get('/api/admin/booking-info', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    const { rows } = await pool.query('SELECT * FROM bookings WHERE seat_key = $1', [req.query.seat]);
    if (rows.length > 0) res.json(rows[0]);
    else res.status(404).json({ error: 'Не найдено' });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

// НОВЫЙ ЭНДПОИНТ: Принудительно снять бронь
app.post('/api/admin/force-cancel', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    await pool.query('DELETE FROM bookings WHERE seat_key = $1', [req.body.seat]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/admin/export', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('Доступ запрещен');
  try {
    const { rows: booked } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at ASC");

    const getPrice = (key) => {
      let zone = ''; let row = 0, seat = 0;
      if (key.startsWith('parterre-')) { zone = 'parterre'; const parts = key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (key.startsWith('central-')) { zone = 'central'; const parts = key.split('-'); row = parseInt(parts[1]); seat = parseInt(parts[2]); }
      else if (key.startsWith('balc-left-a-')) { zone = 'balc-left-a'; const parts = key.split('-'); row = parseInt(parts[3]); seat = parseInt(parts[4]); }
      else if (key.startsWith('balc-left-b-')) { zone = 'balc-left-b'; const parts = key.split('-'); row = parseInt(parts[3]); seat = parseInt(parts[4]); }
      else if (key.startsWith('balc-right-a-')) { zone = 'balc-right-a'; const parts = key.split('-'); row = parseInt(parts[3]); seat = parseInt(parts[4]); }
      else if (key.startsWith('balc-right-b-')) { zone = 'balc-right-b'; const parts = key.split('-'); row = parseInt(parts[3]); seat = parseInt(parts[4]); }
      
      if (appSettings.rules) {
        for (let i = appSettings.rules.length - 1; i >= 0; i--) {
          let r = appSettings.rules[i];
          if (r.zone === zone && row == r.row && seat >= r.start && seat <= r.end) {
            // Используем новый справочник цветов
            if (r.color && appSettings.colorPrices && appSettings.colorPrices[r.color] !== undefined) {
                return appSettings.colorPrices[r.color];
            }
            return r.price || appSettings.basePrice || 600;
          }
        }
      }
      return appSettings.basePrice || 600;
    };

    const workbook = new ExcelJS.Workbook();
    const sheet1 = workbook.addWorksheet('Билеты');
    sheet1.columns = [
      { header: 'Зона', key: 'zone', width: 20 }, { header: 'Ряд', key: 'row', width: 10 },
      { header: 'Место', key: 'seat', width: 10 }, { header: 'Фамилия', key: 'lastname', width: 20 },
      { header: 'Имя', key: 'firstname', width: 20 }, { header: 'Телефон', key: 'phone', width: 20 },
      { header: 'Резерв на (Фамилия Имя)', key: 'reserve', width: 25 }, { header: 'Группа', key: 'group', width: 20 }, { header: 'Сумма', key: 'price', width: 15 }
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
      else if (b.seat_key.startsWith('balc-left-a-')) { zoneName = 'Левый балкон А'; const parts = b.seat_key.split('-'); row = parseInt(parts[3]); seat = parseInt(parts[4]); }
      else if (b.seat_key.startsWith('balc-left-b-')) { zoneName = 'Левый балкон Б'; const parts = b.seat_key.split('-'); row = parseInt(parts[3]); seat = parseInt(parts[4]); }
      else if (b.seat_key.startsWith('balc-right-a-')) { zoneName = 'Правый балкон А'; const parts = b.seat_key.split('-'); row = parseInt(parts[3]); seat = parseInt(parts[4]); }
      else if (b.seat_key.startsWith('balc-right-b-')) { zoneName = 'Правый балкон Б'; const parts = b.seat_key.split('-'); row = parseInt(parts[3]); seat = parseInt(parts[4]); }

      const price = getPrice(b.seat_key);
      
      const reserveStr = (b.reserve_lastname && b.reserve_firstname) ? `${b.reserve_lastname} ${b.reserve_firstname}` : '';
      sheet1.addRow({ zone: zoneName, row: row, seat: seat, lastname: b.lastname, firstname: b.firstname, phone: b.phone, reserve: reserveStr, group: b.group_name || '', price: price });

      const personKey = `${b.lastname}_${b.firstname}_${b.phone}`;
      if (!summaryMap[personKey]) {
          summaryMap[personKey] = { lastname: b.lastname, firstname: b.firstname, phone: b.phone, group: b.group_name || '', count: 0, total: 0 };
      }
      summaryMap[personKey].count++;
      summaryMap[personKey].total += price;
    });

    Object.values(summaryMap).forEach(p => sheet2.addRow(p));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { res.status(500).send('Ошибка экспорта: ' + err.message); }
});

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
