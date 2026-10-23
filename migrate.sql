-- Run ONCE on your existing database:  mysql -u root -p saffron_table < migrate.sql
USE saffron_table;
ALTER TABLE users MODIFY role ENUM('admin','waiter','salesperson','chef') NOT NULL;
UPDATE users SET role='salesperson' WHERE role='waiter';
UPDATE users SET email='salesperson@saffron.com' WHERE email='waiter@saffron.com';
ALTER TABLE users MODIFY role ENUM('admin','salesperson','chef') NOT NULL;
ALTER TABLE orders MODIFY status ENUM('Pending','Preparing','Ready','Received','Served') NOT NULL DEFAULT 'Pending';

-- Dish photos (run once if you use migrate.sql manually; the server also does this automatically)
ALTER TABLE menu_items ADD COLUMN image MEDIUMBLOB NULL;
ALTER TABLE menu_items ADD COLUMN image_type VARCHAR(30) NULL;
ALTER TABLE menu_items ADD COLUMN image_v BIGINT NOT NULL DEFAULT 0;
