import type { Metadata } from "next";
import { Geist, Geist_Mono, JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import "./tokens.css";

const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "MERIDIAN · Autonomous Capital Intelligence",
  description:
    "An AI-native hedge fund operating system — autonomous research, portfolio construction, and execution supervised by a small team of human operators.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        {/* Icon font for the v2 desk, landing and tour. It renders ligatures, so
            `display=block` keeps raw glyph names from flashing; this is the app
            root layout, so it loads on every route. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font, @next/next/google-font-display */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block"
        />
      </head>
      <body
        className={`${geist.variable} ${geistMono.variable} ${jetbrainsMono.variable} ${newsreader.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
