import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, X } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib";
import { Empty } from "../ui";

function columnClass(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || !("className" in meta)) return undefined;
  const className = meta.className;
  return typeof className === "string" ? className : undefined;
}

export function DataTable<T>({
  columns,
  data,
  empty = "No records found",
  rowClassName,
}: {
  columns: ColumnDef<T>[];
  data: T[];
  empty?: string;
  rowClassName?(row: T): string | undefined;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const table = useReactTable({
    data,
    columns,
    defaultColumn: { filterFn: "includesString" },
    state: { columnFilters, sorting },
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  if (data.length === 0) return <Empty>{empty}</Empty>;
  const rows = table.getRowModel().rows;
  return (
    <div className="min-w-0 rounded-xl border border-slate-800">
      <div className="flex min-h-9 items-center justify-end gap-3 border-b border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-500">
        <span aria-live="polite">
          {rows.length === data.length
            ? `${data.length} ${data.length === 1 ? "row" : "rows"}`
            : `${rows.length} of ${data.length} rows`}
        </span>
        {columnFilters.length > 0 ? (
          <button
            className="inline-flex items-center gap-1 text-slate-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            type="button"
            onClick={() => setColumnFilters([])}
          >
            <X size={13} aria-hidden="true" />
            Clear filters
          </button>
        ) : null}
      </div>
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full table-fixed border-collapse text-left text-sm">
          <thead className="sticky top-0 z-20 bg-slate-900 text-xs uppercase tracking-wider text-slate-400 shadow-[0_1px_0_rgb(30_41_59)]">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    className={cn(
                      "px-3 py-2 font-medium",
                      columnClass(header.column.columnDef.meta),
                    )}
                    key={header.id}
                  >
                    {header.isPlaceholder ? null : (
                      <div className="space-y-2">
                        <button
                          className="inline-flex max-w-full items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          {header.column.getIsSorted() === "asc" ? (
                            <ArrowUp size={13} />
                          ) : header.column.getIsSorted() === "desc" ? (
                            <ArrowDown size={13} />
                          ) : header.column.getCanSort() ? (
                            <ChevronsUpDown size={13} />
                          ) : null}
                        </button>
                        {header.column.getCanFilter() ? (
                          <input
                            aria-label={`Filter ${header.column.id.replaceAll("_", " ")}`}
                            className="block h-7 w-full rounded border border-slate-700 bg-slate-950 px-2 text-xs font-normal normal-case tracking-normal text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
                            placeholder="Filter…"
                            type="search"
                            value={String(header.column.getFilterValue() ?? "")}
                            onChange={(event) =>
                              header.column.setFilterValue(event.target.value)
                            }
                            onClick={(event) => event.stopPropagation()}
                          />
                        ) : null}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length > 0 ? (
              rows.map((row) => (
                <tr
                  className={cn(
                    "border-t border-slate-800/80 hover:bg-slate-900/60",
                    rowClassName?.(row.original),
                  )}
                  key={row.id}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      className={cn(
                        "overflow-hidden px-3 py-3 align-top text-slate-200",
                        columnClass(cell.column.columnDef.meta),
                      )}
                      key={cell.id}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  className="px-3 py-8 text-center text-sm text-slate-500"
                  colSpan={table.getVisibleLeafColumns().length}
                >
                  No rows match these filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
