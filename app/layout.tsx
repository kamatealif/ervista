import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Traditional ER Diagram Generator",
  description:
    "Paste SQL CREATE TABLE schema and generate traditional ER diagrams with export to PNG, JPG, or SVG.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
