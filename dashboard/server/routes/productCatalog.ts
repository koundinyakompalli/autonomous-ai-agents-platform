import { Router } from "express";
import { getProductCatalog } from "../services/productCatalog.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-cache");
    res.json(await getProductCatalog());
  } catch (error) {
    console.error("[product-catalog] query failed:", error);
    res.status(500).json({ error: "Product Catalog query failed" });
  }
});

export default router;
