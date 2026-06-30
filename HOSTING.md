# Cara Hosting Mie Ayam Awat

## File yang Wajib Diupload
```
ptti/
├── 1index.html      # Beranda
├── 2menu.html       # Menu
├── 3keranjang.html # Keranjang
├── kasir.html       # Kasir
├── api.js          # API Helper
├── backend/
│   ├── server.js    # Backend Node.js
│   ├── db.json     # Database
│   ├── package.json
│   └── .env        # Midtrans Keys (BUAT FILE INI MANUAL)
└── runtime.txt     # Node version (18.x)
```

## Steps Hosting di Railway
1. **Push ke GitHub**
   ```bash
   git init
   git add .
   git commit -m "init"
   # Buat repo github.com, lalu:
   git remote add origin https://github.com/username/repo.git
   git push -u origin main
   ```

2. **Deploy di Railway**
   - Buka https://railway.app
   - Login → "New Project" → "Deploy from GitHub repo"
   - Pilih repo -> Deploy

3. **Setup Environment Variables**
   - Di Railway dashboard, klik Variables
   - Tambah:
     ```
     MIDTRANS_IS_PRODUCTION=false
     MIDTRANS_SERVER_KEY=... (dari Midtrans Dashboard)
     MIDTRANS_CLIENT_KEY=... (dari Midtrans Dashboard)
     PORT=3000
     ```

4. **Selesai!**
   - Buka link yang diberikan Railway

## Alternative: Render.com
1. Push ke GitHub
2. Buka https://render.com
3. New Web Service → Connect GitHub
4. Build Command: `npm install`
5. Start Command: `node backend/server.js`

## Catatan
- Tidak perlu upload `.venv` atau `node_modules/`
- File `.env` wajib diisi manual dengan Midtrans keys asli
- Untuk testing sandbox: `MIDTRANS_IS_PRODUCTION=false
