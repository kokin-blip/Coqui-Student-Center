import type { Metadata, Viewport } from "next";
import { DM_Sans, Manrope } from "next/font/google";
import "./globals.css";

const display = Manrope({
  variable: "--font-display",
  subsets: ["latin"],
});

const body = DM_Sans({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "https://student-center.app"),
  title: "Student Center — Your day, realistically planned",
  description:
    "Import your academic life, build a realistic plan, and always know what to do next.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/favicon.svg", apple: "/icon-192.png" },
  openGraph: {
    title: "Student Center",
    description: "Your day, realistically planned.",
    type: "website",
    images: [{ url:"/og.png", width:1664, height:936, alt:"Student Center planning dashboard" }],
  },
  twitter: {
    card:"summary_large_image",
    title:"Student Center",
    description:"Your day, realistically planned.",
    images:["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#f8f9f2",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable}`}>{children}</body>
    </html>
  );
}
