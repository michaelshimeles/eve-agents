import { Theme } from "frosted-ui";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "eveclaw — Eve Agent Builder",
  description: "Configure your own Eve agent and deploy it to your Vercel account in one click.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        {/* Whop-style frosted dark theme with the classic blue accent. */}
        <Theme appearance="dark" accentColor="blue" className="min-h-dvh bg-canvas text-gray-12">
          {children}
        </Theme>
      </body>
    </html>
  );
}
