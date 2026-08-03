import type { Metadata } from "next";
import "./globals.css";

const defaultSiteUrl = "https://turnline-airline-simulator.arnavjain20042.chatgpt.site";
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? defaultSiteUrl;
const normalizedSiteUrl = siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
const imageUrl = new URL("og.png", normalizedSiteUrl).toString();
const description =
  "Explore a domestic airline network and see how flight delays and airport ground stops ripple through aircraft rotations.";

export const metadata: Metadata = {
  metadataBase: new URL(normalizedSiteUrl),
  title: "Aircraft Delay Visualizer",
  description,
  openGraph: {
    title: "Aircraft Delay Visualizer",
    description,
    type: "website",
    images: [{
      url: imageUrl,
      width: 1731,
      height: 909,
      alt: "Aircraft Delay Visualizer airline network disruption simulator",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Aircraft Delay Visualizer",
    description,
    images: [imageUrl],
  },
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
