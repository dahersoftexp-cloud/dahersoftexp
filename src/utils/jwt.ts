import jwt from "jsonwebtoken";
import { getJwtSecret } from "../config/runtime";

const JWT_SECRET = getJwtSecret();

export const generateToken = (payload: object) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "1h", algorithm: "HS256" });
};

export const verifyToken = (token: string) => {
  return jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
};
