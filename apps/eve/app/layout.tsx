import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import Script from "next/script";
import type { ReactNode } from "react";
import { VoiceOrb } from "@/components/voice-orb";
import { AGENT_NAME } from "@/lib/identity";
import { cn } from "@/lib/utils";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: AGENT_NAME,
  description: `Chat with your personal ${AGENT_NAME} agent`,
};

export const viewport: Viewport = {
  themeColor: "#111111",
};

const COLOR_MODE_SCRIPT = `
try {
  const mode = localStorage.getItem("eve-color-mode") === "light" ? "light" : "dark";
  document.documentElement.dataset.mode = mode;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", mode === "light" ? "#fbfbfb" : "#111111");
} catch {}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-mode="dark"
      suppressHydrationWarning
      className={cn("font-sans", inter.variable, geist.variable, geistMono.variable)}
    >
      <head>
        <Script id="color-mode" strategy="beforeInteractive">
          {COLOR_MODE_SCRIPT}
        </Script>
      </head>
      <body className="antialiased">
        {children}
        <VoiceOrb />
      </body>
    </html>
  );
}
