import { Router } from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = Router();

router.post("/", auth, async (req, res) => {
  try {
    const { customer_name, phone, reservation_date, reservation_time, guests, area_slug, table_number } = req.body;

    if (!customer_name || !phone || !reservation_date || !reservation_time || !guests || !area_slug || !table_number) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Resolve area
    const areaResult = await pool.query(
      "SELECT id, name FROM areas WHERE slug = $1",
      [area_slug]
    );
    if (!areaResult.rows.length) {
      return res.status(400).json({ error: "Invalid area" });
    }
    const area = areaResult.rows[0];

    const { rows } = await pool.query(
      `INSERT INTO reservations (customer_name, user_id, phone, reservation_date, reservation_time, guests, area_id, table_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, status`,
      [customer_name, req.user.id, phone, reservation_date, reservation_time, guests, area.id, table_number]
    );

    res.status(201).json({
      id: rows[0].id,
      customer_name,
      reservation_date,
      reservation_time,
      guests,
      area_name: area.name,
      table_number,
      status: rows[0].status,
    });
  } catch (err) {
    console.error("POST /api/reservations error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
