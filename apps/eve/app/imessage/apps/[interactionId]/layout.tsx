import type { Metadata } from "next";

import "./mini-app.css";

export const metadata: Metadata = {
  title: "Ruth interaction",
  robots: { index: false, follow: false, noarchive: true },
};

export default function IMessageAppLayout(props: {
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  );
}
