import { Router } from "express";
import pool from "../db.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { category } = req.query;
    let query = `
      SELECT
        m.id, m.name, m.description, m.price, m.prep_time,
        m.calories, m.proteins, m.fats, m.carbs, m.is_vegetarian, m.allergens,
        c.slug AS category,
        m.image_id,
        CASE WHEN m.image_id IS NOT NULL
          THEN '/api/images/' || m.image_id
          ELSE NULL
        END AS image_url
      FROM menu_items m
      JOIN categories c ON c.id = m.category_id
    `;
    const params = [];

    if (category) {
      query += " WHERE c.slug = $1";
      params.push(category);
    }

    query += " ORDER BY m.id";

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/menu error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
