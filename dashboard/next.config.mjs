/**
 * @fileoverview Next.js configuration for the CCP dashboard.
 *
 * Standalone output bundles all server-side dependencies so the
 * MCP server can launch the dashboard from the published tarball
 * without a separate install step.
 */

import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  serverExternalPackages: ['postgres'],
  turbopack: {
    root: __dirname
  }
}

export default nextConfig
