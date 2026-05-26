import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    /* config options here */
    reactCompiler: true,
    output: process.env.MIKE_DESKTOP_BUILD === "1" ? "standalone" : undefined,
    async rewrites() {
        return [
            {
                source: "/sitemap.xml",
                destination: "/api/sitemap/sitemap.xml",
            },
            {
                source: "/sitemap_:slug.xml",
                destination: "/api/sitemap/sitemap_:slug.xml",
            },
        ];
    },
    skipTrailingSlashRedirect: true,
};

export default nextConfig;
