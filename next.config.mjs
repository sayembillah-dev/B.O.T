import os from 'node:os';

/**
 * Next dev blocks cross-origin requests to /_next/* by default.
 * Friends joining via your LAN IP (http://192.168.x.x:3000) count as
 * "cross-origin" and get blocked — which kills hydration in dev.
 * Whitelist this machine's current LAN IPs automatically.
 */
function lanIps() {
  const ips = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: [
    ...lanIps(),
    // tunnels / custom hosts, e.g. ALLOWED_DEV_ORIGINS="myapp.ngrok.app"
    ...(process.env.ALLOWED_DEV_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
  ],
};

export default nextConfig;
