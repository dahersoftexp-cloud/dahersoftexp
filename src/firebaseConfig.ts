// src/firebaseConfig.ts
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import dotenv from "dotenv";

dotenv.config(); // تحميل متغيرات البيئة

const firebaseConfig = {
  apiKey: process.env.FIREBASE_apiKey,
  authDomain: process.env.FIREBASE_authDomain,
  databaseURL: process.env.FIREBASE_databaseURL,
  projectId: process.env.FIREBASE_projectId,
  storageBucket: process.env.FIREBASE_storageBucket,
  messagingSenderId: process.env.FIREBASE_messagingSenderId,
  appId: process.env.FIREBASE_appId,
  measurementId: process.env.FIREBASE_measurementId,
  // apiKey: "AIzaSyDwZmm9YFxUsXaNGadxNWyDa3sN7DCDnNs",
  // authDomain: "fitnesstime-4096f.firebaseapp.com",
  // databaseURL: "https://fitnesstime-4096f-default-rtdb.firebaseio.com",
  // projectId: "fitnesstime-4096f",
  // storageBucket: "fitnesstime-4096f.firebasestorage.app",
  // messagingSenderId: "577921419371",
  // appId: "1:577921419371:web:6b1bced7ebc17a07b5092e",
  // measurementId: "G-MB1NYNBY2M",
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

export { app, database };
