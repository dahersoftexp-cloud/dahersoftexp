import express from "express";
import { createTrial } from "../controllers/trials.controller";

const router = express.Router();

router.post("/", createTrial);

export default router;
