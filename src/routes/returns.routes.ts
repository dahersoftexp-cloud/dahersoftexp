
import express from 'express';
import { getAllReturns, createReturn, getReturnById } from '../controllers/returns.controller';
const router = express.Router();

router.get('/', getAllReturns);
router.post('/', createReturn);
router.get("/:id", getReturnById);

router.post("/byId", getReturnById);

export default router;
