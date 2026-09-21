import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || "gravity-cafe-secret";

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, phone: user.phone },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { name, phone, password } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ error: "name, phone, and password are required" });
    }

    const existing = await pool.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Phone number already registered" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING id, name, phone",
      [name, phone, password_hash]
    );

    const user = result.rows[0];
    const token = signToken(user);

    res.status(201).json({ token, user: { id: user.id, name: user.name, phone: user.phone } });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: "phone and password are required" });
    }

    const result = await pool.query("SELECT * FROM users WHERE phone = $1", [phone]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = signToken(user);

    res.json({ token, user: { id: user.id, name: user.name, phone: user.phone } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/auth/me
router.get("/me", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, phone FROM users WHERE id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("Me error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/auth/orders — заказы текущего пользователя
router.get("/orders", auth, async (req, res) => {
  try {
    const ordersResult = await pool.query(
      `SELECT o.id, o.order_date, o.order_time, o.table_number, o.total, o.ready_time, o.status, o.created_at,
              a.name AS area_name
       FROM orders o
       JOIN areas a ON a.id = o.area_id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );

    if (ordersResult.rows.length === 0) {
      return res.json([]);
    }

    const orderIds = ordersResult.rows.map((o) => o.id);
    const itemsResult = await pool.query(
      `SELECT oi.order_id, oi.quantity, oi.unit_price,
              m.name AS menu_item_name,
              CASE WHEN m.image_id IS NOT NULL THEN '/api/images/' || m.image_id ELSE NULL END AS image_url
       FROM order_items oi
       JOIN menu_items m ON m.id = oi.menu_item_id
       WHERE oi.order_id = ANY($1)`,
      [orderIds]
    );

    const orders = ordersResult.rows.map((order) => ({
      ...order,
      items: itemsResult.rows.filter((i) => i.order_id === order.id),
    }));

    res.json(orders);
  } catch (err) {
    console.error("Get orders error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/auth/reservations — брони текущего пользователя
router.get("/reservations", auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.reservation_date, r.reservation_time, r.guests, r.table_number, r.status, r.created_at,
              a.name AS area_name
       FROM reservations r
       JOIN areas a ON a.id = r.area_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Get reservations error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
