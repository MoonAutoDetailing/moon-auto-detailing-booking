import jwt from "jsonwebtoken";

export default function verifyAdmin(req) {
  const token = req.headers["x-admin-session"];

  if (!token) {
    throw new Error("Missing admin session");
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.ADMIN_SESSION_SECRET
    );

    return decoded;

  } catch (err) {
    throw new Error("Invalid admin session");
  }
}
