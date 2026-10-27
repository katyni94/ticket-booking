const express = require('express');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "admin123";

// Trust proxy: корректный req.ip за reverse proxy (Railway, Render, Vercel и т.д.)
app.set('trust proxy', 1);

// ============================================================
// ПУЛ: запас на 50+ одновременных пользователей
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 25,                         // default 10 — повышаем для burst-нагрузки
  idleTimeoutMillis: 30000,        // закрываем простаивающие
  connectionTimeoutMillis: 10000,  // ждём коннект из пула не более 10 сек
  statement_timeout: 15000,        // любой SQL — не дольше 15 сек
  query_timeout: 15000
});
pool.on('error', (err) => {
  // Без этого обработчика один дропнутый idle-коннект убивает весь процесс
  console.error('Пул: неожиданная ошибка idle-соединения:', err.message);
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Простой in-memory rate-limit по IP (без внешних зависимостей)
// ============================================================
const rateLimitStore = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
    }
    next();
  };
}
// Чистим протухшие записи раз в минуту
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitStore) if (now > v.resetAt) rateLimitStore.delete(k);
}, 60000);

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

function normPhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}

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
        is_admin_booking BOOLEAN DEFAULT false,
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
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_admin_booking BOOLEAN DEFAULT false;`).catch(()=>{});

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
  const { firstname, lastname, phone } = req.query;
  if (!firstname || !lastname) return res.status(400).json({ error: 'Имя и фамилия обязательны' });
  const normP = normPhone(phone);
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as count FROM bookings
       WHERE (
         (LOWER(firstname) = LOWER($1) AND LOWER(lastname) = LOWER($2)
          ${normP ? `AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $3` : ''})
         OR (LOWER(reserve_firstname) = LOWER($1) AND LOWER(reserve_lastname) = LOWER($2))
       )
       AND status = 'booked'
       AND COALESCE(is_admin_booking, false) = false`,
      normP ? [firstname.trim(), lastname.trim(), normP] : [firstname.trim(), lastname.trim()]
    );
    const used = parseInt(rows[0].count, 10);
    res.json({ used, max: appSettings.maxSeats, left: Math.max(0, appSettings.maxSeats - used) });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

// ============================================================
// БРОНИРОВАНИЕ — с atomic-защитой от гонок
// ============================================================
app.post('/api/bookings', rateLimit(60000, 10), async (req, res) => {
  const {
    seats, firstname, lastname, phone,
    reserveFirstname, reserveLastname, groupName,
    adminPass, ignoreLimit
  } = req.body || {};

  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'Не выбраны места' });
  if (seats.length > 20) return res.status(400).json({ error: 'Слишком много мест за один раз' });

  const digits = normPhone(phone);
  if (!firstname || firstname.trim().length < 2) return res.status(400).json({ error: 'Введите имя' });
  if (!lastname || lastname.trim().length < 2) return res.status(400).json({ error: 'Введите фамилию' });
  if (digits.length < 10) return res.status(400).json({ error: 'Введите корректный телефон' });

  // Валидация резерва (раньше отсутствовала на сервере)
  const rFName = reserveFirstname ? reserveFirstname.trim() : null;
  const rLName = reserveLastname ? reserveLastname.trim() : null;
  if ((rFName && !rLName) || (!rFName && rLName)) {
    return res.status(400).json({ error: 'Для резерва нужно ввести и имя, и фамилию' });
  }

  const isAdmin = (adminPass === ADMIN_PASSWORD);
  const useLimit = isAdmin ? (ignoreLimit !== true) : true;
  const isAdminBooking = isAdmin && !useLimit;

  const fName = firstname.trim();
  const lName = lastname.trim();
  // Уникальный ключ пользователя для advisory lock
  const userLockKey = `user:${fName.toLowerCase()}:${lName.toLowerCase()}:${digits}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Advisory lock по пользователю: все его брони идут строго последовательно.
    //    Это защищает проверку лимита от гонки (две вкладки одного юзера).
    //    Другие пользователи блокируются независимо — параллелизм сохранён.
    await client.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [userLockKey]);

    // 2) Быстрая проверка — если места заняты, отдаём 409 без попытки вставки
    const { rows: existing } = await client.query(
      'SELECT seat_key FROM bookings WHERE seat_key = ANY($1)',
      [seats]
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Эти места уже выбрал кто-то другой 🥲. Обновите страницу.',
        code: 'SEATS_TAKEN'
      });
    }

    // 3) Проверка лимита (если используем)
    if (useLimit) {
      // Если указан резерв, проверяем ТОЛЬКО лимит резерва.
      // Если резерва нет, проверяем лимит основного пользователя.
      if (rFName && rLName) {
        const { rows: resRows } = await client.query(
          `SELECT COUNT(*) as count FROM bookings
           WHERE (
             (LOWER(firstname) = LOWER($1) AND LOWER(lastname) = LOWER($2))
             OR (LOWER(reserve_firstname) = LOWER($1) AND LOWER(reserve_lastname) = LOWER($2))
           )
           AND status = 'booked'
           AND COALESCE(is_admin_booking, false) = false`,
          [rFName, rLName]
        );
        const resUsed = parseInt(resRows[0].count, 10);
        const max = appSettings.maxSeats;
        if (resUsed + seats.length > max) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `У ${rFName} ${rLName} уже занято ${resUsed} мест из ${max}. Резерв исчерпан.`,
            code: 'LIMIT_EXCEEDED'
          });
        }
      } else {
        const { rows: userRows } = await client.query(
          `SELECT COUNT(*) as count FROM bookings
           WHERE (
             (LOWER(firstname) = LOWER($1) AND LOWER(lastname) = LOWER($2)
              AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $3)
             OR (LOWER(reserve_firstname) = LOWER($1) AND LOWER(reserve_lastname) = LOWER($2))
           )
           AND status = 'booked'
           AND COALESCE(is_admin_booking, false) = false`,
          [fName, lName, digits]
        );
        const userUsed = parseInt(userRows[0].count, 10);
        const max = appSettings.maxSeats;
        if (userUsed + seats.length > max) {
          await client.query('ROLLBACK');
          const left = Math.max(0, max - userUsed);
          let msg;
          if (userUsed >= max) {
            msg = `У вас уже забронировано ${userUsed} из ${max} мест (лимит исчерпан). Снимите лишние места или обратитесь к администратору.`;
          } else {
            msg = `У вас уже ${userUsed} мест из ${max}. Можно добавить ещё не более ${left} (выбрано ${seats.length}).`;
          }
          return res.status(409).json({ error: msg, code: 'LIMIT_EXCEEDED', used: userUsed, max, left });
        }
      }
    }

    // 4) Атомарная вставка. ON CONFLICT (seat_key) DO NOTHING — если в момент
    //    между проверкой (шаг 2) и INSERT другой пользователь успел занять
    //    это место, конфликт не выбросит исключение, а вернёт 0 строк.
    //    Проверяем это и откатываем всю транзакцию.
    for (const seat of seats) {
      const r = await client.query(
        `INSERT INTO bookings
           (seat_key, firstname, lastname, phone, reserve_firstname, reserve_lastname, group_name, status, is_admin_booking)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'booked', $8)
         ON CONFLICT (seat_key) DO NOTHING
         RETURNING seat_key`,
        [seat, fName, lName, phone.trim(), rFName, rLName, groupName || '', isAdminBooking]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Эти места уже выбрал кто-то другой 🥲. Обновите страницу.',
          code: 'SEATS_TAKEN'
        });
      }
    }

    await client.query('COMMIT');
    const { rows: all } = await client.query("SELECT seat_key, status FROM bookings");
    res.json({ ok: true, booked: all, adminBooking: isAdminBooking });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Ошибка бронирования:', err.message);
    res.status(500).json({ error: 'Ошибка при бронировании. Попробуйте ещё раз.' });
  } finally { client.release(); }
});

app.get('/api/my-tickets', async (req, res) => {
  const { firstname, lastname, phone } = req.query;
  if (!firstname || !lastname) return res.status(400).json({ error: 'Введите имя и фамилию' });
  const digits = normPhone(phone);
  if (digits.length < 10) return res.status(400).json({ error: 'Введите корректный телефон' });
  try {
    const { rows } = await pool.query(`
      SELECT seat_key, firstname, lastname, phone, reserve_firstname, reserve_lastname, status, is_admin_booking
      FROM bookings
      WHERE (
        (LOWER(firstname) = LOWER($1) AND LOWER(lastname) = LOWER($2)
         AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $3)
        OR (LOWER(reserve_firstname) = LOWER($1) AND LOWER(reserve_lastname) = LOWER($2))
      )
      AND status = 'booked'
      ORDER BY seat_key
    `, [firstname.trim(), lastname.trim(), digits]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка БД: ' + err.message }); }
});

app.post('/api/cancel', rateLimit(60000, 20), async (req, res) => {
  const { seats, firstname, lastname, phone } = req.body || {};
  if (!seats || !seats.length) return res.status(400).json({ error: 'Не выбраны места' });
  const digits = normPhone(phone);
  if (!firstname || !lastname || digits.length < 10) {
    return res.status(400).json({ error: 'Введите имя, фамилию и телефон' });
  }
  try {
    const result = await pool.query(
      `DELETE FROM bookings
       WHERE seat_key = ANY($1)
         AND LOWER(firstname) = LOWER($2)
         AND LOWER(lastname) = LOWER($3)
         AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $4
         AND status = 'booked'`,
      [seats, firstname.trim(), lastname.trim(), digits]
    );
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) { res.status(500).json({ error: 'Ошибка при отмене' }); }
});

app.get('/api/admin/person-summary', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  const { firstname, lastname, phone } = req.query;
  if (!firstname || !lastname) return res.status(400).json({ error: 'Имя и фамилия обязательны' });
  const digits = normPhone(phone);
  try {
    const baseWhere = `
      WHERE (
        (LOWER(firstname) = LOWER($1) AND LOWER(lastname) = LOWER($2)
         ${digits ? `AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $3` : ''})
        OR (LOWER(reserve_firstname) = LOWER($1) AND LOWER(reserve_lastname) = LOWER($2))
      )
      AND status = 'booked'`;
    const params = digits ? [firstname.trim(), lastname.trim(), digits] : [firstname.trim(), lastname.trim()];

    const totalQ = await pool.query(`SELECT COUNT(*) as c FROM bookings ${baseWhere}`, params);
    const limitedQ = await pool.query(
      `SELECT COUNT(*) as c FROM bookings ${baseWhere} AND COALESCE(is_admin_booking, false) = false`,
      params
    );

    const total = parseInt(totalQ.rows[0].c, 10);
    const limited = parseInt(limitedQ.rows[0].c, 10);
    const admin = total - limited;

    res.json({
      total, limited, admin,
      max: appSettings.maxSeats,
      left: Math.max(0, appSettings.maxSeats - limited)
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД: ' + err.message }); }
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
      await pool.query(
        "INSERT INTO bookings (seat_key, firstname, phone, status) VALUES ($1, 'Админ', 'Заблокировано', 'blocked') ON CONFLICT (seat_key) DO NOTHING",
        [seat]
      );
      return res.json({ status: 'blocked' });
    }
  } catch (err) { res.status(500).json({ error: 'Ошибка БД: ' + err.message }); }
});

app.get('/api/admin/booking-info', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    const { rows } = await pool.query('SELECT * FROM bookings WHERE seat_key = $1', [req.query.seat]);
    if (rows.length > 0) res.json(rows[0]);
    else res.status(404).json({ error: 'Не найдено' });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/admin/force-cancel', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  try {
    await pool.query('DELETE FROM bookings WHERE seat_key = $1', [req.body.seat]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/admin/edit-booking', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  const { seat, firstname, lastname, phone, group_name, reserve_firstname, reserve_lastname, is_admin_booking } = req.body;
  try {
    await pool.query(
      `UPDATE bookings
       SET firstname=$1, lastname=$2, phone=$3, group_name=$4,
           reserve_firstname=$5, reserve_lastname=$6,
           is_admin_booking = COALESCE($7, is_admin_booking)
       WHERE seat_key=$8`,
      [firstname, lastname, phone, group_name, reserve_firstname, reserve_lastname,
       (typeof is_admin_booking === 'boolean' ? is_admin_booking : null), seat]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка БД: ' + err.message }); }
});

app.post('/api/admin/bulk-edit', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Доступ запрещен' });
  const { oldPhone, newFirstname, newLastname, newPhone } = req.body;
  if (!oldPhone || !newFirstname || !newLastname || !newPhone) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  try {
    const normOldPhone = oldPhone.replace(/\D/g, '').slice(-10);
    const query = `
      UPDATE bookings
      SET firstname = $1, lastname = $2, phone = $3
      WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $4
        AND status = 'booked'
    `;
    const result = await pool.query(query, [newFirstname, newLastname, newPhone, normOldPhone]);
    res.json({ ok: true, updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

app.get('/api/admin/export', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('Доступ запрещен');
  try {
    const { rows: booked } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at ASC");

    const getPrice = (key) => {
      let zone = ''; let row = 0, seat = 0;
      if (key.startsWith('parterre-')) { zone = 'parterre'; const p = key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (key.startsWith('central-')) { zone = 'central'; const p = key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (key.startsWith('balc-left-a-')) { zone = 'balc-left-a'; const p = key.split('-'); row = +p[3]; seat = +p[4]; }
      else if (key.startsWith('balc-left-b-')) { zone = 'balc-left-b'; const p = key.split('-'); row = +p[3]; seat = +p[4]; }
      else if (key.startsWith('balc-right-a-')) { zone = 'balc-right-a'; const p = key.split('-'); row = +p[3]; seat = +p[4]; }
      else if (key.startsWith('balc-right-b-')) { zone = 'balc-right-b'; const p = key.split('-'); row = +p[3]; seat = +p[4]; }
      if (appSettings.rules) {
        for (let i = appSettings.rules.length - 1; i >= 0; i--) {
          const r = appSettings.rules[i];
          if (r.zone === zone && row == r.row && seat >= r.start && seat <= r.end) {
            if (r.color && appSettings.colorPrices && appSettings.colorPrices[r.color] !== undefined)
              return appSettings.colorPrices[r.color];
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
      { header: 'Резерв на (Фамилия Имя)', key: 'reserve', width: 25 }, { header: 'Группа', key: 'group', width: 20 },
      { header: 'Админ', key: 'admin', width: 10 }, { header: 'Сумма', key: 'price', width: 15 }
    ];
    const sheet2 = workbook.addWorksheet('Сводка');
    sheet2.columns = [
      { header: 'Фамилия', key: 'lastname', width: 20 }, { header: 'Имя', key: 'firstname', width: 20 },
      { header: 'Телефон', key: 'phone', width: 20 }, { header: 'Группа', key: 'group', width: 20 },
      { header: 'Всего мест', key: 'count', width: 15 }, { header: 'Из них админских', key: 'adminCount', width: 15 },
      { header: 'Итого сумма', key: 'total', width: 15 }
    ];

    const summaryMap = {};
    booked.forEach(b => {
      let zoneName = 'Балкон'; let row = 0, seat = 0;
      if (b.seat_key.startsWith('parterre-')) { zoneName = 'Партер'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('central-')) { zoneName = 'Центр. балкон'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('balc-left-a-')) { zoneName = 'Левый балкон А'; const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; }
      else if (b.seat_key.startsWith('balc-left-b-')) { zoneName = 'Левый балкон Б'; const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; }
      else if (b.seat_key.startsWith('balc-right-a-')) { zoneName = 'Правый балкон А'; const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; }
      else if (b.seat_key.startsWith('balc-right-b-')) { zoneName = 'Правый балкон Б'; const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; }

      const price = getPrice(b.seat_key);
      const reserveStr = (b.reserve_lastname && b.reserve_firstname) ? `${b.reserve_lastname} ${b.reserve_firstname}` : '';
      sheet1.addRow({
        zone: zoneName, row, seat, lastname: b.lastname, firstname: b.firstname,
        phone: b.phone, reserve: reserveStr, group: b.group_name || '',
        admin: b.is_admin_booking ? 'да' : '', price
      });

      const key = `${b.lastname}_${b.firstname}_${b.phone}`;
      if (!summaryMap[key]) summaryMap[key] = {
        lastname: b.lastname, firstname: b.firstname, phone: b.phone,
        group: b.group_name || '', count: 0, adminCount: 0, total: 0
      };
      summaryMap[key].count++;
      if (b.is_admin_booking) summaryMap[key].adminCount++;
      summaryMap[key].total += price;
    });
    Object.values(summaryMap).forEach(p => sheet2.addRow(p));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { res.status(500).send('Ошибка экспорта: ' + err.message); }
});

app.get('/api/admin/export-word', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).send('Доступ запрещен');
  try {
    const { rows: booked } = await pool.query("SELECT * FROM bookings WHERE status = 'booked' ORDER BY created_at ASC");

    const getPrice = (key) => {
      let zone = ''; let row = 0, seat = 0;
      if (key.startsWith('parterre-')) { zone = 'parterre'; const p = key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (key.startsWith('central-')) { zone = 'central'; const p = key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (key.startsWith('balc-')) { const p = key.split('-'); row = +p[3]; seat = +p[4]; }
      if (appSettings.rules) {
        for (let i = appSettings.rules.length - 1; i >= 0; i--) {
          const r = appSettings.rules[i];
          if (r.zone === zone && row == r.row && seat >= r.start && seat <= r.end) {
            if (r.color && appSettings.colorPrices && appSettings.colorPrices[r.color] !== undefined)
              return appSettings.colorPrices[r.color];
            return r.price || appSettings.basePrice || 600;
          }
        }
      }
      return appSettings.basePrice || 600;
    };

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
    booked.forEach(b => {
      let zoneName = 'Балкон'; let row = 0, seat = 0;
      if (b.seat_key.startsWith('parterre-')) { zoneName = 'Партер'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('central-')) { zoneName = 'Центр. балкон'; const p = b.seat_key.split('-'); row = +p[1]; seat = +p[2]; }
      else if (b.seat_key.startsWith('balc-left-a-')) { zoneName = 'Левый балкон А'; const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; }
      else if (b.seat_key.startsWith('balc-left-b-')) { zoneName = 'Левый балкон Б'; const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; }
      else if (b.seat_key.startsWith('balc-right-a-')) { zoneName = 'Правый балкон А'; const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; }
      else if (b.seat_key.startsWith('balc-right-b-')) { zoneName = 'Правый балкон Б'; const p = b.seat_key.split('-'); row = +p[3]; seat = +p[4]; }

      const price = getPrice(b.seat_key);
      const reserveStr = (b.reserve_lastname && b.reserve_firstname) ? `${b.reserve_lastname} ${b.reserve_firstname}` : '';
      html += `<tr><td>${zoneName}</td><td>${row}</td><td>${seat}</td><td>${b.lastname}</td><td>${b.firstname}</td><td>${b.phone}</td><td>${reserveStr}</td><td>${b.group_name || ''}</td><td>${b.is_admin_booking ? 'да' : ''}</td><td>${price} ₽</td></tr>`;

      const key = `${b.lastname}_${b.firstname}_${b.phone}`;
      if (!summaryMap[key]) summaryMap[key] = {
        lastname: b.lastname, firstname: b.firstname, phone: b.phone,
        group: b.group_name || '', count: 0, adminCount: 0, total: 0
      };
      summaryMap[key].count++;
      if (b.is_admin_booking) summaryMap[key].adminCount++;
      summaryMap[key].total += price;
    });
    html += `</table>`;

    html += `<h1>Сводка по покупателям</h1>`;
    html += `<table><tr><th>Фамилия</th><th>Имя</th><th>Телефон</th><th>Группа</th><th>Всего мест</th><th>Из них админских</th><th>Итого сумма</th></tr>`;
    Object.values(summaryMap).forEach(p => {
      html += `<tr><td>${p.lastname}</td><td>${p.firstname}</td><td>${p.phone}</td><td>${p.group}</td><td>${p.count}</td><td>${p.adminCount}</td><td>${p.total} ₽</td></tr>`;
    });
    html += `</table></body></html>`;

    res.setHeader('Content-Type', 'application/msword');
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.doc"');
    res.send(html);
  } catch (err) { res.status(500).send('Ошибка экспорта: ' + err.message); }
});

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
