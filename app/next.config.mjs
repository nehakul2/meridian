/** Static export (spec 3.1, C2: "Nothing server-side"). Served from a CDN in production. */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // The No view and the question copy are imported from services/shared so the UI and the API agree.
  experimental: { externalDir: true },
};
export default nextConfig;
