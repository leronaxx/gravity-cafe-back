DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS reservations CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS menu_items CASCADE;
DROP TABLE IF EXISTS images CASCADE;
DROP TABLE IF EXISTS tables CASCADE;
DROP TABLE IF EXISTS areas CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS time_slots CASCADE;
DROP TABLE IF EXISTS cafe_settings CASCADE;

CREATE TABLE categories (
    id      SERIAL PRIMARY KEY,
    slug    VARCHAR(50) UNIQUE NOT NULL,
    label   VARCHAR(100) NOT NULL,
    icon    VARCHAR(10) NOT NULL
);

CREATE TABLE images (
    id          SERIAL PRIMARY KEY,
    filename    VARCHAR(255) NOT NULL,
    mimetype    VARCHAR(100) NOT NULL,
    data        BYTEA NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE menu_items (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    description TEXT,
    price       INTEGER NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    image_id    INTEGER REFERENCES images(id),
    prep_time   INTEGER NOT NULL DEFAULT 5,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE areas (
    id      SERIAL PRIMARY KEY,
    slug    VARCHAR(50) UNIQUE NOT NULL,
    name    VARCHAR(100) NOT NULL
);

CREATE TABLE tables (
    id      SERIAL PRIMARY KEY,
    number  INTEGER NOT NULL UNIQUE,
    area_id INTEGER NOT NULL REFERENCES areas(id)
);

CREATE TABLE time_slots (
    id        SERIAL PRIMARY KEY,
    slot_time TIME NOT NULL UNIQUE
);

CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(200) NOT NULL,
    phone           VARCHAR(30) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE orders (
    id              SERIAL PRIMARY KEY,
    customer_name   VARCHAR(200) NOT NULL,
    user_id         INTEGER REFERENCES users(id),
    phone           VARCHAR(30) NOT NULL,
    order_date      DATE NOT NULL,
    order_time      TIME NOT NULL,
    area_id         INTEGER NOT NULL REFERENCES areas(id),
    table_number    INTEGER NOT NULL,
    total           INTEGER NOT NULL,
    ready_time      TIME,
    status          VARCHAR(20) DEFAULT 'pending',
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE order_items (
    id              SERIAL PRIMARY KEY,
    order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id    INTEGER NOT NULL REFERENCES menu_items(id),
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    unit_price      INTEGER NOT NULL
);

CREATE TABLE reservations (
    id                  SERIAL PRIMARY KEY,
    customer_name       VARCHAR(200) NOT NULL,
    user_id             INTEGER REFERENCES users(id),
    phone               VARCHAR(30) NOT NULL,
    reservation_date    DATE NOT NULL,
    reservation_time    TIME NOT NULL,
    guests              INTEGER NOT NULL CHECK (guests >= 1 AND guests <= 8),
    area_id             INTEGER NOT NULL REFERENCES areas(id),
    table_number        INTEGER NOT NULL,
    status              VARCHAR(20) DEFAULT 'confirmed',
    created_at          TIMESTAMP DEFAULT NOW()
);

CREATE TABLE cafe_settings (
    id      SERIAL PRIMARY KEY,
    key     VARCHAR(100) UNIQUE NOT NULL,
    value   TEXT NOT NULL
);
