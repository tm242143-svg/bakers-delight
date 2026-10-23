CREATE DATABASE IF NOT EXISTS saffron_table CHARACTER SET utf8mb4;
USE saffron_table;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('admin','salesperson','chef') NOT NULL
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(40) NOT NULL,
  price DECIMAL(10,2) NOT NULL CHECK (price > 0),
  emoji VARCHAR(16) DEFAULT '🍽️',
  available TINYINT(1) NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  table_no VARCHAR(10) NOT NULL,
  items JSON NOT NULL,
  status ENUM('Pending','Preparing','Ready','Received','Served') NOT NULL DEFAULT 'Pending',
  waiter_name VARCHAR(60),
  created_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

INSERT INTO menu_items (name, price, emoji, available) VALUES
 ('Paneer Butter Masala',240,'🍛',1),('Chicken Biryani',280,'🍚',1),('Masala Dosa',120,'🥞',1),
 ('Margherita Pizza',320,'🍕',1),('Fresh Lime Soda',70,'🍋',1),('Gulab Jamun',90,'🍮',0);
