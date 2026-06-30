/**
 * api.js — Sinkron dengan backend/server.js (Express + db.json)
 * Base URL: http://localhost:3000/api
 */

const API_BASE = "/api";

async function _req(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" }
  };

  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  try {
    const r = await fetch(API_BASE + path, opts);
    let data = null;
    try {
      data = await r.json();
    } catch (_) {
      data = null;
    }

    if (!r.ok) {
      return {
        success: false,
        status: r.status,
        error: data?.error || `HTTP ${r.status}`,
        data
      };
    }

    return {
      success: true,
      status: r.status,
      data
    };
  } catch (e) {
    console.error("API Error:", e);
    return { success: false, error: e.message };
  }
}

const API = {
  // SETTINGS
  settings: {
    get: () => _req("GET", "/settings"),
    update: (body) => _req("PATCH", "/settings", body)
    // body: { taxRate, serviceFeeRate, tableCount, currency }
  },

  // MENU
  menu: {
    list: (activeOnly = false) => _req("GET", activeOnly ? "/menu?active=true" : "/menu"),
    add: (body) => _req("POST", "/menu", body),
    update: (id, body) => _req("PUT", `/menu/${id}`, body),
    delete: (id) => _req("DELETE", `/menu/${id}`)
    // body add/update: { name, price, category, active }
  },

  // TABLES (pengganti meja)
  meja: {
    list: () => _req("GET", "/tables"),
    setStatus: (id, status) => _req("PATCH", `/tables/${id}`, { status }),
    update: (id, body) => _req("PATCH", `/tables/${id}`, body)
    // status: 'kosong' | 'terpakai'
  },

  // ORDERS
  orders: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return _req("GET", "/orders" + (qs ? `?${qs}` : ""));
    },
    byMeja: (mejaId) => _req("GET", `/orders?meja=${encodeURIComponent(mejaId)}`),
    create: (body) => _req("POST", "/orders", body),
    setStatus: (orderId, status) => _req("PATCH", `/orders/${orderId}/status`, { status }),
    batal: (orderId) => _req("DELETE", `/orders/${orderId}`),
    bayar: async (orderId, amount, method = "tunai") => {
      // bayar sekarang lewat endpoint payments agar sinkron dengan backend
      return _req("POST", "/payments", {
        order_id: orderId,
        amount,
        method
      });
    }
  },

  // PAYMENTS
  payments: {
    list: (orderId = null) =>
      _req("GET", orderId ? `/payments?order_id=${encodeURIComponent(orderId)}` : "/payments"),
    create: (body) => _req("POST", "/payments", body)
    // body: { order_id, method, amount }
  },

  // REPORTS
  laporan: {
    sales: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return _req("GET", "/reports/sales" + (qs ? `?${qs}` : ""));
    }
  },

  // DEBUG VIEW
  dbView: {
    get: () => _req("GET", "/db-view")
  }
};

window.API = API;
