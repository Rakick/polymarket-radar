import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polymarket Radar | Market Intelligence",
  description: "Plateforme d’intelligence et de détection des activités atypiques sur les marchés prédictifs.",
  icons: { icon: "/radar-mark.svg", shortcut: "/radar-mark.svg", apple: "/radar-mark.svg" },
  applicationName: "Polymarket Radar",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="fr"><body>{children}</body></html>;
}
