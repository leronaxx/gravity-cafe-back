import { Router } from "express";
import pool from "../db.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM cafe_settings");
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    res.json(settings);
  } catch (err) {
    console.error("GET /api/settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
