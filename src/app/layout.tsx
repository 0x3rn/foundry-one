import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Foundry One",
  description: "A provider-neutral control plane for modern backends.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
