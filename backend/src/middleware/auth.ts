import { Request, Response, NextFunction } from "express";
import { getSessionSecret, verifySessionToken } from "../lib/localAuth";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  const token = auth.slice(7).trim();

  let verified: ReturnType<typeof verifySessionToken>;
  try {
    verified = verifySessionToken(token, getSessionSecret());
  } catch {
    res.status(500).json({ detail: "Server auth is not configured" });
    return;
  }
  if (!verified) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return;
  }

  res.locals.userId = verified.userId;
  res.locals.userEmail = verified.email;
  res.locals.token = token;
  next();
}
