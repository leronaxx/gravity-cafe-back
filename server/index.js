import express from "express";
import cors from "cors";
import "dotenv/config";

import categoriesRouter from "./routes/categories.js";
import menuRouter from "./routes/menu.js";
import imagesRouter from "./routes/images.js";
import areasRouter from "./routes/areas.js";
import timeSlotsRouter from "./routes/timeSlots.js";
import ordersRouter from "./routes/orders.js";
import reservationsRouter from "./routes/reservations.js";
import settingsRouter from "./routes/settings.js";
import authRouter from "./routes/auth.js";
import assistantRouter from "./routes/assistant.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.use("/api/categories", categoriesRouter);
app.use("/api/menu", menuRouter);
app.use("/api/images", imagesRouter);
app.use("/api/areas", areasRouter);
app.use("/api/time-slots", timeSlotsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/reservations", reservationsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/auth", authRouter);
// ИИ-ассистент кафе: чат, потоковый ответ, обратная связь и статистика.
app.use("/api/assistant", assistantRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`AI assistant: POST http://localhost:${PORT}/api/assistant/chat`);
});
