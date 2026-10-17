
import express from 'express';
import { getAllSells, getSalesByWarehouseAndDate, getSellById } from '../controllers/sells.controller';
import { get, ref } from '../utils/tenantFirebase';
const router = express.Router();

router.get('/', getAllSells);

router.get("/:id", getSellById);

router.put("/:id", async (req, res) => {
  if (!(await get(ref(`sells/${req.params.id}`))).exists()) return res.status(404).json({ message: "الفاتورة غير موجودة" });
  res.status(409).json({ code: "POSTED_RECORD_IMMUTABLE", message: "لا يمكن تعديل فاتورة مرحلة؛ استخدم المرتجع المرتبط بالفاتورة ثم أنشئ الفاتورة المصححة" });
});

router.delete("/:id", async (req, res) => {
  if (!(await get(ref(`sells/${req.params.id}`))).exists()) return res.status(404).json({ message: "الفاتورة غير موجودة" });
  res.status(409).json({ code: "POSTED_RECORD_IMMUTABLE", message: "لا يمكن حذف فاتورة مرحلة؛ استخدم مرتجع البيع للحفاظ على سجل المخزون والقيود" });
});

router.post("/byWarehouseDate", getSalesByWarehouseAndDate);


export default router;
