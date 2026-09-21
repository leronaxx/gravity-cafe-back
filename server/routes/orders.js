import { Router } from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = Router();

router.post("/", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, phone, order_date, order_time, area_slug, table_number, items } = req.body;

    if (!customer_name || !phone || !order_date || !order_time || !area_slug || !table_number || !items?.length) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    // Resolve area
    const areaResult = await client.query(
      "SELECT id, name FROM areas WHERE slug = $1",
      [area_slug]
    );
    if (!areaResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid area" });
    }
    const area = areaResult.rows[0];

    // Fetch menu items for price snapshot and prep time
    const itemIds = items.map((i) => i.menu_item_id);
    const menuResult = await client.query(
      "SELECT id, price, prep_time FROM menu_items WHERE id = ANY($1)",
      [itemIds]
    );
    const menuMap = {};
    for (const row of menuResult.rows) {
      menuMap[row.id] = row;
    }

    let total = 0;
    let maxPrep = 0;
    for (const item of items) {
      const menuItem = menuMap[item.menu_item_id];
      if (!menuItem) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Menu item ${item.menu_item_id} not found` });
      }
      total += menuItem.price * item.quantity;
      maxPrep = Math.max(maxPrep, menuItem.prep_time);
    }

    // Calculate ready_time
    const [h, m] = order_time.split(":").map(Number);
    let totalMinutes = h * 60 + m - maxPrep;
    if (totalMinutes < 0) totalMinutes += 24 * 60;
    const readyH = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
    const readyM = String(totalMinutes % 60).padStart(2, "0");
    const readyTime = `${readyH}:${readyM}`;

    // Insert order
    const orderResult = await client.query(
      `INSERT INTO orders (customer_name, user_id, phone, order_date, order_time, area_id, table_number, total, ready_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [customer_name, req.user.id, phone, order_date, order_time, area.id, table_number, total, readyTime]
    );
    const orderId = orderResult.rows[0].id;

    // Insert order items
    for (const item of items) {
      const menuItem = menuMap[item.menu_item_id];
      await client.query(
        "INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES ($1, $2, $3, $4)",
        [orderId, item.menu_item_id, item.quantity, menuItem.price]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      id: orderId,
      customer_name,
      order_date,
      order_time,
      area_name: area.name,
      table_number,
      total,
      ready_time: readyTime,
      status: "pending",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/orders error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

export default router;
