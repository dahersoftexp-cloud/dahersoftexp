import "dotenv/config";
import { assertRuntimeConfiguration } from "./config/runtime";

// Validate before importing the application or initializing Firebase.
assertRuntimeConfiguration();

import http from "http";
import app from "./app";
import { configureSocket } from "./socket";


const PORT = process.env.PORT || 5000;

// أنشئ HTTP server بناءً على app
const server = http.createServer(app);
configureSocket(server);

// تشغيل السيرفر على البورت
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
