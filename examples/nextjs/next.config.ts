import type { NextConfig } from 'next'

const config: NextConfig = {
  /**
   * `@retick/client` is server-side here, and this keeps it that way. Listing it
   * as external means the bundler does not try to fold it into a client chunk,
   * so a stray import from a client component fails at build time instead of
   * shipping the module that reads `process.env.RETICK_TOKEN`.
   */
  serverExternalPackages: ['@retick/client'],
}

export default config
