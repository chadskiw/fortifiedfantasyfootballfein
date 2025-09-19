// server/routes.js (Express)
import express from "express";
import { createAvatarUpload } from "./r2.js";

const router = express.Router();

router.post("/api/media/presign", async (req, res) => {
  // auth gate here; infer memberId from session
  const memberId = req.user.id;
  const { ext = "webp" } = req.body || {};
  const out = await createAvatarUpload({ memberId, ext });
  res.json(out);
});

export default router;
