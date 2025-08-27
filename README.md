# AgtronCam — Estimator Level Roasting (Web/Phone Camera)

Estimator level roasting kopi (mirip skala Agtron) menggunakan kamera HP + kalibrasi sederhana. Berjalan 100% di browser (on-device). Ini **bukan** pengganti meter profesional, tetapi mendekati bila pencahayaan terkendali dan dilakukan kalibrasi.

## Fitur
- Live kamera dengan **ROI**: lingkaran (sampel bubuk kopi) & kotak kecil (kertas putih untuk kalibrasi WB)
- **Kalibrasi putih** otomatis → kompensasi white balance per-perangkat
- Konversi **sRGB → CIELAB** (L*, a*, b*) di perangkat
- Estimasi **Agtron ≈ scale × L* + offset** (bisa di-tune dan disimpan)
- **Averaging multi-frame** untuk mengurangi noise (18 frame)
- Peringatan kualitas: **glare**, WB delta, dan stabilitas pencahayaan (EMA)
- UI modern (Tailwind via CDN) → siap deploy di **Vercel**

## Cara pakai (Vercel)
1. Download ZIP ini, ekstrak, lalu push ke GitHub (opsional).
2. Buka [vercel.com](https://vercel.com), **New Project** → Import repo atau **deploy** dari folder ini.
3. Pastikan domain HTTPS aktif (kamera butuh HTTPS).
4. Buka dari HP (Chrome/Safari), izinkan akses kamera.
5. Letakkan **kopi bubuk** merata di tengah lingkaran, **kertas putih polos** di kotak kanan-atas.
6. Klik **Mulai Kamera** → **Kalibrasi Putih** → **Ukur**.
7. Jika memiliki sampel dengan angka Agtron referensi, sesuaikan **Scale/Offset** lalu **Simpan Kalibrasi**.

## Tips akurasi
- Gunakan pencahayaan konsisten 5000–6500K, hindari cahaya campuran (jendela + lampu).
- Kurangi glare dengan diffuser / sudut kamera sedikit miring.
- Utamakan **bubuk** (ground coffee) untuk konsistensi.
- Lakukan kalibrasi per perangkat (hasil disimpan di browser via `localStorage`).

## Struktur
```
/ (root)
├─ index.html   → UI + Tailwind CDN
├─ app.js       → logika kamera, CIELAB, estimasi, kalibrasi
└─ README.md
```

## Catatan hukum & lisensi
Kode ini dirilis untuk tujuan edukasi dan eksperimen. Tidak ada jaminan akurasi; gunakan perangkat profesional untuk kebutuhan sertifikasi/kontrol mutu.
