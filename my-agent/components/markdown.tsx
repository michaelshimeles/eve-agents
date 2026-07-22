"use client";

import type { ComponentProps } from "react";
import { Streamdown, type Components } from "streamdown";
import { cn } from "@/lib/utils";

// Streamdown's default components carry their own Tailwind typography, which
// would fight shadcn/typeset. Mapping every element to its bare intrinsic tag
// keeps Streamdown's streaming-safe parsing while typeset owns all styling.
const bareComponents: Components = {
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  p: "p",
  strong: "strong",
  em: "em",
  ul: "ul",
  ol: "ol",
  li: "li",
  code: "code",
  pre: "pre",
  blockquote: "blockquote",
  table: "table",
  thead: "thead",
  tbody: "tbody",
  tr: "tr",
  th: "th",
  td: "td",
  img: "img",
  hr: "hr",
  sup: "sup",
  sub: "sub",
  a: ({ node: _node, children, ...props }: ComponentProps<"a"> & { node?: unknown }) => (
    <a target="_blank" rel="noreferrer" {...props}>
      {children}
    </a>
  ),
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <Streamdown
      className={cn("typeset typeset-docs max-w-[37em]", className)}
      components={bareComponents}
    >
      {children}
    </Streamdown>
  );
}
