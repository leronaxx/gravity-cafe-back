import { Router } from "express";
import pool from "../db.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT slot_time FROM time_slots ORDER BY slot_time"
    );
    res.json(rows.map((r) => r.slot_time.substring(0, 5)));
  } catch (err) {
    console.error("GET /api/time-slots error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
