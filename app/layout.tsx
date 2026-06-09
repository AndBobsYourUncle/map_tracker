import type { Metadata } from "next";
// MapLibre's base stylesheet is imported here (not in MapTracker) so it loads
// as root-layout global CSS, which Next.js consistently orders BEFORE route
// CSS modules — on hard loads and soft navigations alike. Imported from the
// component, its order relative to MapTracker.module.css's popup overrides
// flips on soft-nav, leaving the popup unstyled (white). Layout-level keeps the
// overrides reliably winning the cascade.
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Map Tracker",
  description: "Map Tracker",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
