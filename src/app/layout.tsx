import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import "./globals.css";

// Variable, with the optical-size axis so display figures draw from the
// display master and body copy from the text one.
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "MERIDIAN · Autonomous Capital Intelligence",
  description:
    "An AI-native hedge fund operating system — autonomous research, portfolio construction, and execution supervised by a small team of human operators.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Icon font for the desk and the public pages (Outlined, wght 300). It
            renders ligatures, so `display=block` keeps raw glyph names from
            flashing; this is the app root layout, so it loads on every route. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font, @next/next/google-font-display */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,300,0..1,0&display=block"
        />
      </head>
      <body
        className={`${newsreader.variable} ${plexSans.variable} ${plexMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
