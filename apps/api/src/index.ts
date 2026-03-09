import "dotenv/config";
import express from "express";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "api" });
});

app.listen(PORT, () => {
  console.log(`[api] listening on port ${PORT}`);
});
