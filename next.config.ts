import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-host as a minimal Node server bundle (see Dockerfile).
  output: "standalone",
  // Map data (data.json + 18k+ tiles + media) is read from DATA_DIR at runtime
  // and is NOT part of the build. Exclude it from file tracing so the tracer
  // doesn't try to bundle the whole data dir into the standalone output.
  outputFileTracingExcludes: {
    "*": ["data/**", "**/data/**", "public/maps/**"],
  },
  // The map page resolves marker icons (built-ins + user overrides) by reading
  // Lucide's static SVGs at runtime. They're only read via fs (not imported),
  // so the tracer can't see them — force them into the standalone bundle.
  outputFileTracingIncludes: {
    "/[game]/[map]": ["./node_modules/lucide-static/icons/**"],
  },
};

export default nextConfig;
