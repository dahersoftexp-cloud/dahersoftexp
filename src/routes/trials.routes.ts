import express from "express";
import {
  createTrial,
  deleteTrial,
  getTrials,
} from "../controllers/trials.controller";

const router = express.Router();

router.get("/", getTrials);
router.post("/", createTrial);
router.delete("/:tenantId", deleteTrial);

export default router;
