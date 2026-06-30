// API Helper Functions
const API = {
  async getTables() { const r = await fetch('/api/tables'); return r.json(); },
  async getOrders() { const r = await fetch('/api/orders'); return r.json(); },
  async getPayments() { const r = await fetch('/api/payments'); return r.json(); },
  async getMenu() { const r = await fetch('/api/menu'); return r.json(); },
  async getSettings() { const r = await fetch('/api/settings'); return r.json(); },
  async getDbView() { const r = await fetch('/api/db-view'); return r.json(); }
};
