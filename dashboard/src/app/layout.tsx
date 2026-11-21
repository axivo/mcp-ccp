/**
 * @fileoverview Root layout for the CCP dashboard.
 *
 * Wraps the app in the Refine provider chain and the Ant Design
 * registry needed for SSR-friendly style extraction. The Refine
 * resources are intentionally empty here - they are added as
 * resource pages land.
 */

import { Refine } from '@refinedev/core'
import { useNotificationProvider } from '@refinedev/antd'
import routerProvider from '@refinedev/nextjs-router'
import '@refinedev/antd/dist/reset.css'
import { ConfigProvider } from 'antd'
import './globals.css'

export const metadata = {
  description: 'Claude Collaboration Platform - projects, tasks, conversations',
  title: 'CCP Dashboard'
}

/**
 * Root layout with Refine and Ant Design providers wired in.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children - Page content
 * @returns {JSX.Element}
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ConfigProvider>
          <Refine
            notificationProvider={useNotificationProvider}
            routerProvider={routerProvider}
            resources={[]}
          >
            {children}
          </Refine>
        </ConfigProvider>
      </body>
    </html>
  )
}
