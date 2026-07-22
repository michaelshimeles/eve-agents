import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./globals.css";

const inter = Inter({subsets:['latin'],variable:'--font-sans'});

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Eve",
  description: "Chat with your personal Eve agent",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("dark font-sans", geist.variable, geistMono.variable, "font-sans", inter.variable)}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
