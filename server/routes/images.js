import { Router } from "express";
import pool from "../db.js";

const router = Router();

router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT filename, mimetype, data FROM images WHERE id = $1",
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Image not found" });
    }

    const img = rows[0];
    res.set("Content-Type", img.mimetype);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(img.data);
  } catch (err) {
    console.error("GET /api/images/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
