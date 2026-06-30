const path = require('path');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const midtransClient = require('midtrans-client');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function cleanEnv(val) {
  return String(val || '').trim().replace(/^['"]|['"]$/g, '');
}

const midtransIsProduction = cleanEnv(process.env.MIDTRANS_IS_PRODUCTION).toLowerCase() === 'true';
const midtransServerKey = cleanEnv(process.env.MIDTRANS_SERVER_KEY);
const midtransClientKey = cleanEnv(process.env.MIDTRANS_CLIENT_KEY);

const snap = new midtransClient.Snap({
  isProduction: midtransIsProduction,
  serverKey: midtransServerKey,
  clientKey: midtransClientKey
});

console.log(
  '[MIDTRANS] mode=%s, serverKeyPrefix=%s, clientKeyPrefix=%s',
  midtransIsProduction ? 'production' : 'sandbox',
  midtransServerKey.slice(0, 14) || '(empty)',
  midtransClientKey.slice(0, 14) || '(empty)'
);

// JSON storage (Windows-friendly)
const storagePath = path.join(__dirname, 'db.json');

function loadDb() {
  try {
    const raw = fs.readFileSync(storagePath, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    return { tables: [], menuItems: [], settings: {}, orders: [], payments: [] };
  }
}

function saveDb(db) {
  fs.writeFileSync(storagePath, JSON.stringify(db, null, 2), 'utf8');
}

function genId(prefix = 'ID') {
  return `${prefix}-${Math.random().toString(16).slice(2, 10).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
}

function nowMs() {
  return Date.now();
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

let database = loadDb();
// normalize shape
if (!database.tables) database.tables = [];
if (!database.menuItems) database.menuItems = [];
if (!database.orders) database.orders = [];
if (!database.payments) database.payments = [];
if (!database.settings) database.settings = {};

function persistDatabase() {
  saveDb(database);
}

function getSettings() {
  return {
    taxRate: toNum(database.settings.taxRate),
    serviceFeeRate: toNum(database.settings.serviceFeeRate),
    tableCount: toInt(database.settings.tableCount),
    currency: database.settings.currency || 'IDR'
  };
}

function calcTotals(items, settings) {
  const itemsArr = Array.isArray(items) ? items : [];
  const subtotal = itemsArr.reduce((acc, it) => {
    const price = toInt(it.price);
    const qty = toInt(it.qty);
    return acc + price * qty;
  }, 0);

  const tax = Math.round(subtotal * (toNum(settings.taxRate) || 0));
  const serviceFee = Math.round(subtotal * (toNum(settings.serviceFeeRate) || 0));
  const total = subtotal + tax + serviceFee;

  return { subtotal, tax, serviceFee, total };
}

function getTableById(tableId) {
  return database.tables.find(t => String(t.id) === String(tableId));
}

const ORDER_AUTO_DELETE_MS = 15 * 60 * 1000;

function cleanupExpiredUnpaidOrders() {
  const now = nowMs();
  const before = database.orders.length;
  database.orders = database.orders.filter((o) => {
    const status = String(o?.status || 'baru');
    if (status !== 'baru') return true;
    const ts = toInt(o?.timestamp || 0);
    if (!ts) return true;
    return (now - ts) < ORDER_AUTO_DELETE_MS;
  });
  return before - database.orders.length;
}

function recomputeTableStatus() {
  // rule:
  // - table kosong if no relevant open order
  // - table terpakai if there exists order with status not in [deleted, selesai]
  //   and payment exists for paid orders will set back to kosong.
  //
  // We treat order status = paid as closed ONLY after creating payment record.
  // Here: if there is a paid order with payment record -> kosong.

  const paidOrderIds = new Set(database.payments.map(p => String(p.order_id)));

  for (const t of database.tables) {
    const openOrder = database.orders.find(o =>
      String(o.meja) === String(t.id) &&
      o.status !== 'deleted' &&
      o.status !== 'selesai' &&
      // if it's paid but already has payment => considered closed
      !(o.status === 'paid' && paidOrderIds.has(String(o.id)))
    );

    t.status = openOrder ? 'terpakai' : 'kosong';
  }
}

function validateMenuItemPayload(body) {
  const { name, price, category, active } = body || {};
  if (!name || typeof name !== 'string') return { ok: false, error: 'name required' };
  if (toInt(price) <= 0) return { ok: false, error: 'price invalid' };
  return { ok: true, data: { name: name.trim(), price: toInt(price), category: category || 'lainnya', active: active !== false } };
}

// --- API: Tables ---
app.get('/api/tables', (req, res) => {
  try {
    res.json(database.tables);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.patch('/api/tables/:id', (req, res) => {
  try {
    const tableId = req.params.id;
    const table = getTableById(tableId);
    if (!table) return res.status(404).json({ ok: false, error: 'table not found' });

    const { status, name } = req.body || {};
    if (status) {
      if (!['kosong', 'terpakai'].includes(status)) {
        return res.status(400).json({ ok: false, error: 'status invalid' });
      }
      table.status = status;
    }
    if (name && typeof name === 'string') table.name = name.trim();

    persistDatabase();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- API: Menu ---
app.get('/api/menu', (req, res) => {
  try {
    const active = req.query.active;
    if (active === 'true') return res.json(database.menuItems.filter(m => m.active !== false));
    res.json(database.menuItems);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/menu', (req, res) => {
  try {
    const validation = validateMenuItemPayload(req.body);
    if (!validation.ok) return res.status(400).json({ ok: false, error: validation.error });

    const { name, price, category, active } = validation.data;
    const newItem = { id: genId('M'), name, price, category, active };
    database.menuItems.push(newItem);
    persistDatabase();

    res.status(201).json({ ok: true, item: newItem });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put('/api/menu/:id', (req, res) => {
  try {
    const id = req.params.id;
    const item = database.menuItems.find(m => String(m.id) === String(id));
    if (!item) return res.status(404).json({ ok: false, error: 'menu item not found' });

    // allow partial updates
    const payload = req.body || {};
    if (payload.name !== undefined) {
      if (typeof payload.name !== 'string' || !payload.name.trim()) return res.status(400).json({ ok: false, error: 'name invalid' });
      item.name = payload.name.trim();
    }
    if (payload.price !== undefined) {
      const p = toInt(payload.price);
      if (p <= 0) return res.status(400).json({ ok: false, error: 'price invalid' });
      item.price = p;
    }
    if (payload.category !== undefined) item.category = String(payload.category);
    if (payload.active !== undefined) item.active = payload.active !== false;

    persistDatabase();
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete('/api/menu/:id', (req, res) => {
  try {
    const id = req.params.id;
    const idx = database.menuItems.findIndex(m => String(m.id) === String(id));
    if (idx < 0) return res.status(404).json({ ok: false, error: 'menu item not found' });

    database.menuItems.splice(idx, 1);
    persistDatabase();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- API: Orders ---
function ensureDbOrderIdUniq(orderId) {
  // minimal safety: avoid duplicate order ids
  if (database.orders.some(o => String(o.id) === String(orderId))) {
    return genId('ORD');
  }
  return orderId;
}

function normalizeOrderStatus(status) {
  const allowed = ['baru', 'diproses', 'paid', 'selesai', 'deleted'];
  return allowed.includes(status) ? status : 'baru';
}

// --- API: Orders ---
app.post('/api/orders', (req, res) => {
  try {
    cleanupExpiredUnpaidOrders();
    const settings = getSettings();
    const { id, meja, status, catatan, items, timestamp } = req.body || {};

    const orderId = id || genId('ORD');
    const itemsArr = Array.isArray(items) ? items : [];

    const totals = calcTotals(itemsArr, settings);

    const record = {
      id: orderId,
      meja: meja ?? null,
      status: status ?? 'baru',
      catatan: catatan ?? '',
      items: itemsArr,
      subtotal: totals.subtotal,
      tax: totals.tax,
      serviceFee: totals.serviceFee,
      total: totals.total,
      timestamp: toInt(timestamp ?? nowMs())
    };

    database.orders.push(record);
    persistDatabase();
    recomputeTableStatus();
    persistDatabase();

    res.status(201).json({ ok: true, orderId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/orders', (req, res) => {
  try {
    const removed = cleanupExpiredUnpaidOrders();
    if (removed > 0) {
      persistDatabase();
      recomputeTableStatus();
      persistDatabase();
    }
    const { status, meja } = req.query;
    let rows = database.orders;
    if (status) rows = rows.filter(o => o.status === status);
    if (meja) rows = rows.filter(o => String(o.meja) === String(meja));

    rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.patch('/api/orders/:id/status', (req, res) => {
  try {
    const { status } = req.body || {};
    const id = req.params.id;
    if (!status) return res.status(400).json({ ok: false, error: 'status required' });

    const allowed = ['baru', 'diproses', 'paid', 'selesai', 'deleted'];
    if (!allowed.includes(status)) return res.status(400).json({ ok: false, error: 'status invalid' });

    const order = database.orders.find(o => o.id === id);
    if (!order) return res.status(404).json({ ok: false, error: 'order not found' });

    order.status = status;
    persistDatabase();

    recomputeTableStatus();
    persistDatabase();

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete('/api/orders/:id', (req, res) => {
  try {
    const id = req.params.id;
    const idx = database.orders.findIndex(o => String(o.id) === String(id));
    if (idx < 0) return res.status(404).json({ ok: false, error: 'order not found' });

    database.orders.splice(idx, 1);
    persistDatabase();

    recomputeTableStatus();
    persistDatabase();

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- API: Payments ---
app.post('/api/payments/midtrans/token', async (req, res) => {
  try {
    const { order_id, customer_name } = req.body || {};
    if (!order_id) return res.status(400).json({ ok: false, error: 'order_id required' });

    const orderRow = database.orders.find(o => String(o.id) === String(order_id));
    if (!orderRow) return res.status(404).json({ ok: false, error: 'order not found' });

    if (!midtransServerKey || !midtransClientKey) {
      return res.status(500).json({ ok: false, error: 'midtrans keys not configured' });
    }

    const mappedItems = (Array.isArray(orderRow.items) ? orderRow.items : []).map((it, idx) => ({
      id: String(idx + 1),
      name: String(it.name || 'Item'),
      quantity: Math.max(1, toInt(it.qty)),
      price: Math.max(0, toInt(it.price))
    }));

    const itemsSubtotal = mappedItems.reduce((acc, it) => acc + (toInt(it.price) * toInt(it.quantity)), 0);
    const grossAmount = toInt(orderRow.total);
    const otherAmount = Math.max(0, grossAmount - itemsSubtotal);

    const item_details = [...mappedItems];
    if (otherAmount > 0) {
      item_details.push({
        id: 'OTHER-1',
        name: 'Tax & Service Fee',
        quantity: 1,
        price: otherAmount
      });
    }

    const finalGrossAmount = item_details.reduce((acc, it) => acc + (toInt(it.price) * toInt(it.quantity)), 0);

    const parameter = {
      transaction_details: {
        order_id: `${String(orderRow.id)}-${Date.now()}`,
        gross_amount: finalGrossAmount
      },
      customer_details: {
        first_name: customer_name || 'Pelanggan',
        email: 'customer@example.com'
      },
      item_details
    };

    console.log('[MIDTRANS] createTransaction payload:', JSON.stringify(parameter));

    const transaction = await snap.createTransaction(parameter);
    return res.json({
      ok: true,
      token: transaction.token,
      redirect_url: transaction.redirect_url,
      clientKey: midtransClientKey
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/payments', (req, res) => {
  try {
    const { id, order_id, method, amount } = req.body || {};
    const orderId = order_id;
    if (!orderId) return res.status(400).json({ ok: false, error: 'order_id required' });

    const orderRow = database.orders.find(o => o.id === orderId);
    if (!orderRow) return res.status(404).json({ ok: false, error: 'order not found' });

    const methodVal = method || 'tunai';
    const amountInt = toInt(amount);
    if (amountInt <= 0) return res.status(400).json({ ok: false, error: 'amount invalid' });

    const paymentId = id || genId('PAY');

    database.payments.push({
      id: paymentId,
      order_id: orderId,
      method: methodVal,
      amount: amountInt,
      paid_at: nowMs()
    });

    // set final paid status and keep in database
    orderRow.status = 'sudah_dibayar';
    persistDatabase();

    recomputeTableStatus();
    persistDatabase();

    res.status(201).json({ ok: true, paymentId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/payments', (req, res) => {
  try {
    const orderId = req.query.order_id;
    const rows = orderId ? database.payments.filter(p => String(p.order_id) === String(orderId)) : database.payments;
    rows.sort((a, b) => (b.paid_at ?? 0) - (a.paid_at ?? 0));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// DELETE /api/payments/reset HARUS came BEFORE /api/payments/:id
app.delete('/api/payments/reset', (req, res) => {
  try {
    database.orders = [];
    database.payments = [];
    persistDatabase();
    recomputeTableStatus();
    persistDatabase();
    res.json({ ok: true, message: 'orders dan payments berhasil direset' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete('/api/db-view/clear-all', (req, res) => {
  try {
    database.orders = [];
    database.payments = [];
    persistDatabase();
    recomputeTableStatus();
    persistDatabase();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete('/api/payments/:id', (req, res) => {
  try {
    const id = String(req.params.id || '');
    const idx = database.payments.findIndex(p => String(p.id) === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'payment not found' });

    const removed = database.payments.splice(idx, 1)[0];
    const order = database.orders.find(o => String(o.id) === String(removed.order_id));

    if (order) {
      const hasAnotherPayment = database.payments.some(p => String(p.order_id) === String(order.id));
      if (!hasAnotherPayment && order.status === 'paid') {
        order.status = 'baru';
      }
    }

    persistDatabase();
    recomputeTableStatus();
    persistDatabase();

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- API: Reports (Sales) ---
app.get('/api/reports/sales', (req, res) => {
  try {
    const { from, to } = req.query;

    const fromMs = from ? new Date(from).getTime() : null;
    const toMs = to ? new Date(to).getTime() : null;

    const payments = database.payments.filter(p => {
      const t = p.paid_at ?? 0;
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t > toMs) return false;
      return true;
    });

    const total = payments.reduce((acc, p) => acc + toInt(p.amount), 0);

    const byMethod = payments.reduce((acc, p) => {
      const m = p.method || 'tunai';
      acc[m] = (acc[m] || 0) + toInt(p.amount);
      return acc;
    }, {});

    res.json({
      ok: true,
      range: { from: from || null, to: to || null },
      total,
      currency: getSettings().currency,
      byMethod,
      count: payments.length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- API: Settings ---
// --- API: DB View (for easier reading) ---
app.get('/api/db-view', (req, res) => {
  try {
    // Sort newest first for better UX
    const orders = Array.isArray(database.orders) ? [...database.orders].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)) : [];
    const payments = Array.isArray(database.payments) ? [...database.payments].sort((a, b) => (b.paid_at ?? 0) - (a.paid_at ?? 0)) : [];

    const paidTotal = orders
      .filter(o => o.status === 'paid' || o.status === 'selesai' || o.status === 'sudah_dibayar')
      .reduce((acc, o) => acc + toInt(o.total), 0);

    res.json({
      ok: true,
      summary: {
        count: payments.length,
        total: paidTotal
      },
      orders,
      payments
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/settings', (req, res) => {
  try {
    res.json(getSettings());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.patch('/api/settings', (req, res) => {
  try {
    const { taxRate, serviceFeeRate, tableCount, currency } = req.body || {};

    if (taxRate !== undefined) database.settings.taxRate = toNum(taxRate);
    if (serviceFeeRate !== undefined) database.settings.serviceFeeRate = toNum(serviceFeeRate);
    if (tableCount !== undefined) database.settings.tableCount = toInt(tableCount);
    if (currency !== undefined) database.settings.currency = String(currency);

    // Optionally create missing tables based on tableCount
    const desired = Math.max(0, toInt(database.settings.tableCount));
    if (desired > 0) {
      // ensure there are tables 1..desired
      const existing = new Set(database.tables.map(t => String(t.id).toUpperCase()));
      for (let i = 1; i <= desired; i++) {
        const tid = `T${i}`;
        if (!existing.has(tid)) {
          database.tables.push({ id: tid, name: `Meja ${i}`, status: 'kosong' });
        }
      }
    }

    persistDatabase();
    recomputeTableStatus();
    persistDatabase();

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// static serving:
// 1) serve root project HTML (customer pages like /2menu.html, /3keranjang.html)
// 2) then serve backend/public (admin-db and assets)
app.use(express.static(path.join(__dirname, '..')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '1index.html'));
});

// explicit customer pages routing (avoid "Cannot GET /2menu.html" in some environments)
app.get('/1index.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '1index.html'));
});
app.get('/2menu.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '2menu.html'));
});
app.get('/3keranjang.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '3keranjang.html'));
});
app.get('/kasir.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'kasir.html'));
});
app.get('/api.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'api.js'));
});

setInterval(() => {
  try {
    const removed = cleanupExpiredUnpaidOrders();
    if (removed > 0) {
      persistDatabase();
      recomputeTableStatus();
      persistDatabase();
      console.log(`[CLEANUP] removed ${removed} expired unpaid orders`);
    }
  } catch (_) {}
}, 60 * 1000);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Backend berjalan di http://localhost:${port}`);
});

