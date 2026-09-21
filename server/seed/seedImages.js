import fs from "fs";
import path from "path";

const MIME_MAP = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export default async function seedImages(pool, publicDir) {
  const files = fs.readdirSync(publicDir).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return MIME_MAP[ext] !== undefined;
  });

  const imageMap = {};

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const mimetype = MIME_MAP[ext];
    const data = fs.readFileSync(path.join(publicDir, file));

    const { rows } = await pool.query(
      "INSERT INTO images (filename, mimetype, data) VALUES ($1, $2, $3) RETURNING id",
      [file, mimetype, data]
    );
    imageMap[file] = rows[0].id;
    console.log(`  image: ${file} → id ${rows[0].id}`);
  }

  return imageMap;
}
