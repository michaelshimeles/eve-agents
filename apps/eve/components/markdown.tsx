"use client";

import { CheckIcon, CopyIcon, EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import {
  isValidElement,
  memo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import remarkBreaks from "remark-breaks";
import { defaultRemarkPlugins, Streamdown, type Components } from "streamdown";
import {
  artifactIdFromHref,
  openArtifactWorkspace,
} from "@/lib/artifact-client";
import { cn } from "@/lib/utils";

// Chat replies often separate list-like lines with single newlines, which
// plain markdown collapses into one paragraph. remark-breaks renders them as
// hard line breaks. Passing remarkPlugins replaces Streamdown's defaults, so
// keep those (GFM tables, code meta) and append.
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

// Detects the fenced block's language from the inner <code class="language-x">.
function codeLanguage(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(child)) return null;
  const className = (child.props as { className?: string }).className ?? "";
  const match = /language-([\w-]+)/.exec(className);
  return match ? match[1] : null;
}

// A bare <pre> wrapped with hover actions: copy, and for HTML blocks a live
// preview rendered in a sandboxed iframe (scripts allowed, same-origin not).
// The wrapper stays outside typeset's element styles; buttons opt out via
// not-typeset.
function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const previewable = codeLanguage(children) === "html";
  const actionClass =
    "not-typeset rounded-md bg-kumo-base/80 p-1.5 text-kumo-subtle ring ring-kumo-hairline opacity-0 backdrop-blur-sm transition-opacity hover:text-kumo-default focus-visible:opacity-100 group-hover/code:opacity-100";

  return (
    <div className="group/code relative">
      <pre
        ref={preRef}
        {...props}
        className={cn(
          // Code blocks scroll horizontally without showing a scrollbar.
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          props.className,
          previewHtml !== null && "hidden",
        )}
      >
        {children}
      </pre>
      {previewHtml !== null && (
        <iframe
          title="HTML preview"
          sandbox="allow-scripts"
          srcDoc={previewHtml}
          className="not-typeset h-96 w-full rounded-lg bg-white ring ring-kumo-hairline"
        />
      )}
      <div className="absolute end-2 top-2 flex gap-1">
        {previewable && (
          <button
            type="button"
            aria-label={previewHtml !== null ? "Show code" : "Preview HTML"}
            title={previewHtml !== null ? "Show code" : "Preview HTML"}
            className={cn(actionClass, previewHtml !== null && "opacity-100")}
            onClick={() =>
              setPreviewHtml((current) =>
                current !== null ? null : (preRef.current?.innerText ?? ""),
              )
            }
          >
            {previewHtml !== null ? (
              <EyeSlashIcon className="size-3.5" />
            ) : (
              <EyeIcon className="size-3.5" />
            )}
          </button>
        )}
        <button
          type="button"
          aria-label="Copy code"
          className={actionClass}
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
  a: ({
    node: _node,
    children,
    href,
    onClick,
    target: _target,
    ...props
  }: ComponentProps<"a"> & { node?: unknown }) => {
    // Agent-generated artifact links are relative. Avoid advertising them as
    // new-tab links during SSR; the click-time check below also handles an
    // absolute same-origin URL safely.
    const relativeArtifactId =
      href === undefined
        ? null
        : artifactIdFromHref(href, "https://ruth-artifact-link.invalid");
    return (
      <a
        {...props}
        href={href}
        target={relativeArtifactId === null ? "_blank" : undefined}
        rel={relativeArtifactId === null ? "noreferrer" : undefined}
        onClick={(event) => {
          onClick?.(event);
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            href === undefined
          ) {
            return;
          }
          const artifactId = artifactIdFromHref(href, window.location.origin);
          if (artifactId === null) return;
          event.preventDefault();
          openArtifactWorkspace(artifactId);
        }}
      >
        {children}
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <Streamdown
      className={cn("typeset typeset-docs max-w-[37em]", className)}
      components={bareComponents}
      remarkPlugins={remarkPlugins}
    >
      {children}
    </Streamdown>
  );
});
