
import express from 'express';
import { getAllReturns, getReturnById } from '../controllers/returns.controller';
const router = express.Router();

router.get('/', getAllReturns);
router.post('/', (_req, res) => {
  res.status(409).json({ code: "LINKED_FINANCIAL_RETURN_REQUIRED", message: "استخدم مرتجع البيع أو الشراء المرتبط بالفاتورة لضمان ترحيل المخزون والحسابات معاً" });
});
router.get("/:id", getReturnById);

router.post("/byId", getReturnById);

export default router;
