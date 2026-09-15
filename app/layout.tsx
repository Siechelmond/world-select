import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "World Select",
  description: "Spatial intelligence across Earth, orbit and space.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
