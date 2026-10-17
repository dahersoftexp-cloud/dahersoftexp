
import express from 'express';
import { getAllPurchases } from '../controllers/purchases.controller';
import { handleBulkPurchase, handlePurchase } from '../functions/transactions';
const router = express.Router();

router.get('/', getAllPurchases);
router.post('/', async (req, res) => {
  try {
    const newPurchase = req.body.newPurchase || req.body;
    const result = Array.isArray(newPurchase.products)
      ? await handleBulkPurchase({ newPurchase })
      : await handlePurchase({ newPurchase, newProduct: req.body.newProduct || newPurchase });
    res.json({ message: "تم تسجيل الشراء وترحيله محاسبياً", data: result });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

export default router;
