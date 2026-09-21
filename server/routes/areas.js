import { Router } from "express";
import pool from "../db.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const areasResult = await pool.query(
      "SELECT id, slug, name FROM areas ORDER BY id"
    );
    const tablesResult = await pool.query(
      "SELECT number, area_id FROM tables ORDER BY number"
    );

    const areas = areasResult.rows.map((area) => ({
      ...area,
      tables: tablesResult.rows
        .filter((t) => t.area_id === area.id)
        .map((t) => t.number),
    }));

    res.json(areas);
  } catch (err) {
    console.error("GET /api/areas error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
