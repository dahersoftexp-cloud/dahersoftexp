import express from "express";
import * as warehouseController from "../controllers/warehouses.controller";

const router = express.Router();

router.get("/", warehouseController.getAll);

router.post("/", warehouseController.create);
router.put("/:id", warehouseController.updateWarehouse);
router.delete("/:id", warehouseController.archiveWarehouse);

router.get("/migrate", (_req, res) =>
  res.status(410).json({ error: "ENDPOINT_RETIRED" }),
);

export default router;
