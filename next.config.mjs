/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The accounting services import node built-ins and the Postgres driver;
  // keeping them external avoids bundling the driver into route handlers.
  serverExternalPackages: ['@neondatabase/serverless', 'bcryptjs'],
};

export default nextConfig;
