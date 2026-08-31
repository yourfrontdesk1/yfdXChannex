import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Channel Hub",
  description: "Rates, availability and restrictions for every connected property.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <div className="topbar">
            <div className="brand">
              Channel <span>Hub</span>
            </div>
            <div className="crumb">One integration, every account</div>
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
