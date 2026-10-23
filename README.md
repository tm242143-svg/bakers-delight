# Bakers Delight – restaurant ordering (v4)

Roles: **Admin, Salesperson, Chef** · realtime orders and alerts · bill printing · Excel menu upload.

## Run (3 steps)
1. Make sure MySQL is running (Windows: Win+R → `services.msc` → **MySQL80** → Start).
2. Open `.env` and set `DB_PASSWORD` to your MySQL root password (no spaces around `=`).
3. Double-click **start.bat** — or in a terminal inside this folder run `npm install` once, then `npm start`.

The server creates the database, tables, sample menu and the three logins by itself. You do **not** need
`schema.sql`, `migrate.sql` or `npm run seed` any more (they are kept only for reference).
Open http://localhost:3000. The terminal also prints a link for phones on the same Wi-Fi.

## Logins
| Role | Email | Password |
|---|---|---|
| Admin | admin@saffron.com | admin123 |
| Salesperson | salesperson@saffron.com | sales123 |
| Chef | chef@saffron.com | chef123 |

The login page no longer shows these credentials. Change the passwords before real use. `npm run seed` resets the three passwords to the values above if you forget them.

## Who can do what
- **Admin:** manage the menu, see **Ongoing orders** live, view **Order history**, reprint bills, and delete completed orders (one by one or all history). Ongoing orders cannot be deleted.
- **Salesperson:** take orders, see status, mark **Given to customer**, print bills.
- **Chef:** **Preparing → Ready → Given to salesperson**, in that order.

## Order flow
Salesperson submits (Given to chef) → Chef: Preparing → Ready → Given to salesperson → Salesperson: Given to customer.
Each step sends a realtime alert (sound, vibration, banner) to the person who acts next.

## Bill printing
"Print bill" opens the print dialog of the device in use: any connected printer (USB, Wi-Fi, Bluetooth, 80 mm
thermal) or Save as PDF. Edit shop name, address and GST % in `SHOP` inside `public/index.html`.

## Excel upload
Columns: name, price, emoji (optional), available (optional yes/no). Existing names are skipped.

## Problems
- "Wrong MySQL user or password" → fix `DB_PASSWORD` in `.env`.
- "MySQL is not running" → start the MySQL80 service.
- "Port 3000 already in use" → close the other terminal running the app.
