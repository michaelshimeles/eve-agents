"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState, type ComponentProps } from "react";
import remarkBreaks from "remark-breaks";
import { defaultRemarkPlugins, Streamdown, type Components } from "streamdown";
import { cn } from "@/lib/utils";

// Chat replies often separate list-like lines with single newlines, which
// plain markdown collapses into one paragraph. remark-breaks renders them as
// hard line breaks. Passing remarkPlugins replaces Streamdown's defaults, so
// keep those (GFM tables, code meta) and append.
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

// A bare <pre> wrapped with a hover copy button. The wrapper stays outside
// typeset's element styles; the button opts out via not-typeset.
function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code relative">
      <pre ref={preRef} {...props}>
        {children}
      </pre>
      <button
        type="button"
        aria-label="Copy code"
        className="not-typeset absolute end-2 top-2 rounded-md border border-border bg-background/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100"
        onClick={() => {
          const text = preRef.current?.innerText ?? "";
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
    </div>
  );
}

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
  pre: ({ node: _node, ...props }: ComponentProps<"pre"> & { node?: unknown }) => (
    <CodeBlock {...props} />
  ),
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
      remarkPlugins={remarkPlugins}
    >
      {children}
    </Streamdown>
  );
}
