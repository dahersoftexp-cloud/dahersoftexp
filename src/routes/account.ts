import express from "express";
import { createAccount , getAccount , updateAccount , deleteAccount, getAccountDetails, initializeDefaultAccounts } from "../controllers/account.controller";


const router = express.Router();

router.post('/create-account' , createAccount)
router.post('/initialize-defaults', initializeDefaultAccounts)
router.get('/get-account' ,getAccount )
router.put('/update-account/:id' ,updateAccount )
router.delete('/delete-account/:id' ,deleteAccount )
router.get('/get-account/:id' ,getAccountDetails )



export default router;
