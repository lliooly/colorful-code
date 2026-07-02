import type { ReactNode } from 'react';
import './globals.css';
import { DisableContextMenu } from './disable-context-menu';

export default function RootLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="font-sans">
      <body>
        {children}
        <DisableContextMenu />
      </body>
    </html>
  );
}
