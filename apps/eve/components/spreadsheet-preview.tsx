"use client";

import { Loader } from "@cloudflare/kumo";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

type Cell = string | number | boolean | Date | null;

function parseCsv(text: string): Cell[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function columnLabel(index: number): string {
  let label = "";
  let value = index + 1;
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function displayCell(value: Cell): string {
  if (value === null) return "";
  if (value instanceof Date) return value.toLocaleString();
  return String(value);
}

export function SpreadsheetPreview({
  contentUrl,
  filename,
  onSelection,
}: {
  contentUrl: string;
  filename: string;
  onSelection?: (selection: unknown) => void;
}) {
  const [sheets, setSheets] = useState<{ name: string; rows: Cell[][] }[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [selected, setSelected] = useState<{ row: number; column: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets([]);
    setError(null);
    void fetch(contentUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the spreadsheet.");
        const buffer = await response.arrayBuffer();
        if (filename.toLowerCase().endsWith(".csv")) {
          return [{ name: "CSV", rows: parseCsv(new TextDecoder().decode(buffer)) }];
        }
        const { default: readXlsxFile, readSheetNames } = await import("read-excel-file");
        const names = await readSheetNames(buffer);
        const parsed = await Promise.all(
          names.slice(0, 30).map(async (name) => ({
            name,
            rows: (await readXlsxFile(buffer, { sheet: name })) as Cell[][],
          })),
        );
        return parsed;
      })
      .then((next) => {
        if (!cancelled) {
          setActiveSheet(0);
          setSheets(next);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not read the spreadsheet.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contentUrl, filename]);

  const sheet = sheets[activeSheet];
  const width = useMemo(
    () => Math.min(Math.max(0, ...(sheet?.rows.map((row) => row.length) ?? [0])), 100),
    [sheet],
  );

  if (error !== null) {
    return <p className="p-4 text-sm text-kumo-danger">{error}</p>;
  }
  if (sheet === undefined) {
    return (
      <div className="flex min-h-64 items-center justify-center text-kumo-subtle">
        <Loader size={20} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sheets.length > 1 && (
        <div
          role="tablist"
          aria-label="Workbook sheets"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-kumo-hairline p-2"
        >
          {sheets.map((entry, index) => (
            <button
              key={entry.name}
              type="button"
              role="tab"
              aria-selected={index === activeSheet}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-xs",
                index === activeSheet
                  ? "bg-kumo-tint text-kumo-strong"
                  : "text-kumo-subtle hover:bg-kumo-base",
              )}
              onClick={() => {
                setActiveSheet(index);
                setSelected(null);
              }}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-kumo-elevated">
            <tr>
              <th className="sticky start-0 z-20 w-10 border-e border-b border-kumo-hairline bg-kumo-elevated" />
              {Array.from({ length: width }, (_, column) => (
                <th
                  key={column}
                  className="min-w-24 border-e border-b border-kumo-hairline px-2 py-1 text-center font-medium text-kumo-subtle"
                >
                  {columnLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.slice(0, 5_000).map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th className="sticky start-0 z-10 border-e border-b border-kumo-hairline bg-kumo-elevated px-2 py-1 text-end font-medium text-kumo-subtle">
                  {rowIndex + 1}
                </th>
                {Array.from({ length: width }, (_, columnIndex) => {
                  const isSelected =
                    selected?.row === rowIndex && selected.column === columnIndex;
                  return (
                    <td
                      key={columnIndex}
                      className={cn(
                        "max-w-80 border-e border-b border-kumo-hairline px-2 py-1.5 align-top whitespace-pre-wrap",
                        isSelected && "bg-kumo-tint ring-1 ring-inset ring-kumo-focus",
                      )}
                      onClick={() => {
                        setSelected({ row: rowIndex, column: columnIndex });
                        onSelection?.({
                          type: "sheet-range",
                          sheet: sheet.name,
                          range: `${columnLabel(columnIndex)}${rowIndex + 1}`,
                          value: displayCell(row[columnIndex] ?? null),
                        });
                      }}
                    >
                      {displayCell(row[columnIndex] ?? null)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
