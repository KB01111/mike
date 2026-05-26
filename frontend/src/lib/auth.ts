import { NextRequest } from 'next/server';
import { getMikeApiBaseUrl } from "@/lib/apiBase";

const API_BASE = getMikeApiBaseUrl();

/**
 * Extract and validate user from a Mike bearer session token.
 */
export async function getUserFromRequest(request: NextRequest): Promise<{
  email: string;
  id: string;
} | null> {
  try {
    const authHeader = request.headers.get('Authorization');
    
    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.substring(7);
    
    if (!token) {
      return null;
    }
    const response = await fetch(`${API_BASE}/auth/session`, {
      method: "GET",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.warn('[Auth] Invalid or expired token:', response.status);
      return null;
    }

    const data = (await response.json()) as {
      user?: { email?: string | null; id?: string | null };
    };
    const user = data.user;

    if (!user?.email || !user.id) {
      console.warn('[Auth] User has no email or id');
      return null;
    }

    console.log(`[Auth] User authenticated: ${user.email}`);
    return {
      email: user.email,
      id: user.id
    };
  } catch (error) {
    console.error('[Auth] Error validating token:', error);
    return null;
  }
}

