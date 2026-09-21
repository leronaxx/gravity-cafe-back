import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";
import seedImages from "./seedImages.js";
import seedData from "./seedData.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../public");

async function main() {
  console.log("=== Gravity Café seed ===\n");

  // 1. Run schema
  console.log("[1/3] Creating tables...");
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  await pool.query(schema);
  console.log("  done\n");

  // 2. Seed images
  console.log("[2/3] Seeding images from public/...");
  const imageMap = await seedImages(pool, publicDir);
  console.log(`  total: ${Object.keys(imageMap).length} images\n`);

  // 3. Seed data
  console.log("[3/3] Seeding data...");
  await seedData(pool, imageMap);
  console.log("\n=== Seed complete ===");

  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  pool.end();
  process.exit(1);
});
