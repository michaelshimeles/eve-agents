"use client";

import CodeMirror from "@uiw/react-codemirror";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";
import { useMemo } from "react";

function languageFor(path: string): Extension[] {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "js" || extension === "jsx" || extension === "mjs" || extension === "cjs") {
    return [javascript({ jsx: extension === "jsx" })];
  }
  if (extension === "ts" || extension === "tsx" || extension === "mts" || extension === "cts") {
    return [javascript({ jsx: extension === "tsx", typescript: true })];
  }
  if (extension === "json" || extension === "jsonc") return [json()];
  if (extension === "html" || extension === "htm") return [html()];
  if (extension === "css" || extension === "scss" || extension === "less") return [css()];
  if (extension === "md" || extension === "mdx") return [markdown()];
  if (extension === "py") return [python()];
  if (extension === "yaml" || extension === "yml") return [yaml()];
  return [];
}

export function WorkspaceEditor({
  path,
  value,
  onChange,
  onSave,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const extensions = useMemo(() => languageFor(path), [path]);

  return (
    <CodeMirror
      value={value}
      height="100%"
      className="h-full min-h-0 overflow-auto bg-kumo-base text-sm [&_.cm-editor]:h-full [&_.cm-editor]:bg-transparent [&_.cm-gutters]:bg-kumo-tint [&_.cm-gutters]:text-kumo-subtle"
      extensions={extensions}
      basicSetup={{
        autocompletion: true,
        bracketMatching: true,
        closeBrackets: true,
        foldGutter: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        lineNumbers: true,
      }}
      onChange={onChange}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSave();
        }
      }}
    />
  );
}
