type AuthChangeEvent =
    | "INITIAL_SESSION"
    | "SIGNED_IN"
    | "SIGNED_OUT"
    | "TOKEN_REFRESHED";

type LocalUser = {
    id: string;
    email?: string | null;
};

type LocalSession = {
    access_token: string;
    token_type: "bearer";
    user: LocalUser;
};

type AuthError = Error & { status?: number };

type AuthCallback = (event: AuthChangeEvent, session: LocalSession | null) => void;

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
const STORAGE_KEY = "mike.auth.session";
const subscribers = new Set<AuthCallback>();

function isBrowser(): boolean {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function makeAuthError(message: string, status?: number): AuthError {
    const error = new Error(message) as AuthError;
    error.status = status;
    return error;
}

function readSession(): LocalSession | null {
    if (!isBrowser()) return null;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const session = JSON.parse(raw) as Partial<LocalSession>;
        if (!session.access_token || !session.user?.id) return null;
        return {
            access_token: session.access_token,
            token_type: "bearer",
            user: session.user,
        };
    } catch {
        return null;
    }
}

function writeSession(session: LocalSession | null): void {
    if (!isBrowser()) return;
    if (!session) {
        window.localStorage.removeItem(STORAGE_KEY);
        return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function emit(event: AuthChangeEvent, session: LocalSession | null): void {
    for (const callback of subscribers) {
        callback(event, session);
    }
}

async function parseAuthResponse(response: Response): Promise<{
    access_token: string;
    user: LocalUser;
}> {
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
        body = { detail: text };
    }
    if (!response.ok) {
        const detail =
            typeof body.detail === "string"
                ? body.detail
                : `Authentication request failed: ${response.status}`;
        throw makeAuthError(detail, response.status);
    }
    if (
        typeof body.access_token !== "string" ||
        !body.user ||
        typeof body.user !== "object"
    ) {
        throw makeAuthError("Authentication response was missing a session");
    }
    const user = body.user as Partial<LocalUser>;
    if (typeof user.id !== "string") {
        throw makeAuthError("Authentication response was missing a user");
    }
    return {
        access_token: body.access_token,
        user: {
            id: user.id,
            email: typeof user.email === "string" ? user.email : null,
        },
    };
}

function toSession(payload: { access_token: string; user: LocalUser }): LocalSession {
    return {
        access_token: payload.access_token,
        token_type: "bearer",
        user: payload.user,
    };
}

async function authRequest(
    path: string,
    init: RequestInit,
    token?: string,
): Promise<{ access_token: string; user: LocalUser }> {
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...init,
        headers: {
            Accept: "application/json",
            ...(init.headers as Record<string, string> | undefined),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
    return parseAuthResponse(response);
}

export const supabase = {
    auth: {
        async signInWithPassword(credentials: {
            email: string;
            password: string;
        }): Promise<{
            data: { session: LocalSession | null; user: LocalUser | null };
            error: AuthError | null;
        }> {
            try {
                const payload = await authRequest("/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(credentials),
                });
                const session = toSession(payload);
                writeSession(session);
                emit("SIGNED_IN", session);
                return { data: { session, user: session.user }, error: null };
            } catch (error) {
                return {
                    data: { session: null, user: null },
                    error:
                        error instanceof Error
                            ? (error as AuthError)
                            : makeAuthError(String(error)),
                };
            }
        },

        async signUp(credentials: {
            email: string;
            password: string;
        }): Promise<{
            data: { session: LocalSession | null; user: LocalUser | null };
            error: AuthError | null;
        }> {
            try {
                const payload = await authRequest("/auth/signup", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(credentials),
                });
                const session = toSession(payload);
                writeSession(session);
                emit("SIGNED_IN", session);
                return { data: { session, user: session.user }, error: null };
            } catch (error) {
                return {
                    data: { session: null, user: null },
                    error:
                        error instanceof Error
                            ? (error as AuthError)
                            : makeAuthError(String(error)),
                };
            }
        },

        async getSession(): Promise<{
            data: { session: LocalSession | null };
            error: null;
        }> {
            return { data: { session: readSession() }, error: null };
        },

        async getUser(token?: string): Promise<{
            data: { user: LocalUser | null };
            error: AuthError | null;
        }> {
            const session = readSession();
            const accessToken = token ?? session?.access_token;
            if (!accessToken) return { data: { user: null }, error: null };
            try {
                const payload = await authRequest(
                    "/auth/session",
                    { method: "GET" },
                    accessToken,
                );
                const nextSession = toSession(payload);
                if (!token) {
                    writeSession(nextSession);
                    emit("TOKEN_REFRESHED", nextSession);
                }
                return { data: { user: nextSession.user }, error: null };
            } catch (error) {
                if (!token) {
                    writeSession(null);
                    emit("SIGNED_OUT", null);
                }
                return {
                    data: { user: null },
                    error:
                        error instanceof Error
                            ? (error as AuthError)
                            : makeAuthError(String(error)),
                };
            }
        },

        async signOut(): Promise<{ error: AuthError | null }> {
            const session = readSession();
            try {
                if (session?.access_token) {
                    await fetch(`${API_BASE}/auth/logout`, {
                        method: "POST",
                        cache: "no-store",
                        headers: {
                            Authorization: `Bearer ${session.access_token}`,
                        },
                    });
                }
                return { error: null };
            } catch (error) {
                return {
                    error:
                        error instanceof Error
                            ? (error as AuthError)
                            : makeAuthError(String(error)),
                };
            } finally {
                writeSession(null);
                emit("SIGNED_OUT", null);
            }
        },

        onAuthStateChange(callback: AuthCallback): {
            data: { subscription: { unsubscribe: () => void } };
        } {
            subscribers.add(callback);
            queueMicrotask(() => {
                if (subscribers.has(callback)) {
                    callback("INITIAL_SESSION", readSession());
                }
            });
            return {
                data: {
                    subscription: {
                        unsubscribe: () => {
                            subscribers.delete(callback);
                        },
                    },
                },
            };
        },
    },
};
