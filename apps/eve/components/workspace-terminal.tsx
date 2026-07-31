"use client";

import { Terminal, useTerminal, type WTerm } from "@wterm/react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkspaceTarget } from "@/lib/workspace-api";

function terminalSocketUrl(target: WorkspaceTarget, developmentRelay: string | null): string {
  const url =
    developmentRelay === null
      ? new URL("/api/workspace/terminal", window.location.href)
      : new URL(developmentRelay, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname =
    developmentRelay === null
      ? "/api/workspace/terminal"
      : `${url.pathname.replace(/\/$/, "")}/terminal`;
  url.searchParams.set("sessionId", target.sessionId);
  if (target.targetName) url.searchParams.set("targetName", target.targetName);
  return url.toString();
}

export function WorkspaceTerminal({
  target,
  developmentRelay,
  visible,
  onConnectionChange,
}: {
  target: WorkspaceTarget;
  developmentRelay: string | null;
  visible: boolean;
  onConnectionChange?: (state: "connecting" | "connected" | "closed") => void;
}) {
  const { ref, focus } = useTerminal();
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<WTerm | null>(null);
  const pendingRef = useRef<Array<string | Uint8Array>>([]);
  const [error, setError] = useState<string | null>(null);

  const sendResize = useCallback((cols: number, rows: number) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    terminalRef.current = null;
    pendingRef.current = [];
    const socket = new WebSocket(terminalSocketUrl(target, developmentRelay));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    onConnectionChange?.("connecting");

    socket.addEventListener("open", () => {
      if (disposed) return;
      setError(null);
      onConnectionChange?.("connected");
      socket.send(
        JSON.stringify({
          type: "start",
          command: "bash",
          args: ["-l"],
          cwd: "/workspace",
          env: [
            "TERM=xterm-256color",
            "COLORTERM=truecolor",
            "PS1=\\[\\e[36m\\]ruth\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]$ ",
          ],
          cols: 120,
          rows: 32,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (disposed) return;
      let frame: string | Uint8Array;
      if (event.data instanceof ArrayBuffer) {
        frame = new Uint8Array(event.data);
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((value) => {
          if (!disposed) {
            const bytes = new Uint8Array(value);
            if (terminalRef.current) terminalRef.current.write(bytes);
            else pendingRef.current.push(bytes);
          }
        });
        return;
      } else {
        const text = String(event.data);
        try {
          const control = JSON.parse(text) as { type?: string; code?: number };
          if (control.type === "exit") {
            frame = `\r\n[process exited${control.code === undefined ? "" : ` with code ${control.code}`}]\r\n`;
          } else {
            return;
          }
        } catch {
          frame = text;
        }
      }
      if (terminalRef.current) terminalRef.current.write(frame);
      else pendingRef.current.push(frame);
    });
    socket.addEventListener("close", (event) => {
      if (disposed) return;
      onConnectionChange?.("closed");
      if (event.code !== 1000) {
        setError(event.reason || "The terminal connection closed.");
      }
    });
    socket.addEventListener("error", () => {
      if (!disposed) setError("Could not open the terminal connection.");
    });

    return () => {
      disposed = true;
      terminalRef.current = null;
      socketRef.current = null;
      socket.close(1000, "Terminal tab closed.");
    };
  }, [developmentRelay, onConnectionChange, target.sessionId, target.targetName]);

  useEffect(() => {
    if (visible) focus();
  }, [focus, visible]);

  return (
    <div className={visible ? "relative h-full min-h-0" : "hidden"}>
      {error !== null && (
        <div className="absolute inset-x-3 top-3 z-10 rounded-lg bg-kumo-danger-tint px-3 py-2 text-xs text-kumo-danger ring ring-kumo-danger/30">
          {error}
        </div>
      )}
      <Terminal
        ref={ref}
        autoResize
        cursorBlink
        className="h-full min-h-0 bg-[#111318] p-2"
        theme="dark"
        onData={(data) => {
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(new TextEncoder().encode(data));
          }
        }}
        onResize={sendResize}
        onReady={(terminal) => {
          // React's development Strict Mode can let the first WTerm init promise
          // settle after that instance has already been torn down. Ignore that
          // stale callback so PTY frames always target the currently mounted
          // terminal instead of a destroyed bridge.
          if (!terminal.element.isConnected || ref.current?.instance !== terminal) return;
          terminalRef.current = terminal;
          for (const frame of pendingRef.current.splice(0)) terminal.write(frame);
          if (visible) focus();
        }}
        onError={(cause) => {
          setError(cause instanceof Error ? cause.message : "The terminal could not start.");
        }}
      />
    </div>
  );
}
