const DEFAULT_LOCAL_API_BASE_URL = "http://localhost:3001";

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

export function getMikeApiBaseUrl(): string {
    const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
    if (configured) return trimTrailingSlash(configured);

    if (process.env.NEXT_PUBLIC_MIKE_DESKTOP_BUILD === "1") {
        throw new Error(
            "NEXT_PUBLIC_API_BASE_URL must be set when building Mike desktop.",
        );
    }

    return DEFAULT_LOCAL_API_BASE_URL;
}
