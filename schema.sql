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
  emoji VARCHAR(16) DEFAULT '🥐',
  available TINYINT(1) NOT NULL DEFAULT 1,
  image MEDIUMBLOB NULL,
  image_type VARCHAR(30) NULL,
  image_v BIGINT NOT NULL DEFAULT 0
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
)
;
INSERT INTO menu_items (name, price, emoji, available) VALUES
 ('Butter Croissant',80,'🥐',1),('Chocolate Cupcake',60,'🧁',1),('Sourdough Loaf',180,'🍞',1),
 ('French Baguette',110,'🥖',1),('Black Forest Pastry',95,'🍰',1),('Glazed Donut',55,'🍩',0);
