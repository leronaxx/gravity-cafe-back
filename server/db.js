import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE || "gravity_cafe",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "",
});

export default pool;
