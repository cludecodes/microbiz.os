import { useCallback, useEffect, useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import { api } from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { Badge, Button, Card, ErrorText, Input, PageTitle, Select, Table, cx } from "../components/ui";

type Kind = "merge" | "split" | "compress";

interface Operation {
  id: string;
  kind: Kind;
  status: string;
  input_files: string;
  output_file: string;
  created_at: string;
}

const KIND_LABEL: Record<Kind, string> = {
  merge: "Merge PDFs",
  split: "Extract pages",
  compress: "Optimize size",
};

const KIND_HINT: Record<Kind, string> = {
  merge: "Combine 2–20 PDFs into one document, in the order you pick them.",
  split: "Extract a page range (e.g. 1-3,7) from a PDF into a new file.",
  compress: "Re-save with compressed object streams to shrink file size.",
};

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export default function PdfTools() {
  const { workspaces } = useAuth();
  const [wsIndex, setWsIndex] = useState(0);
  const ws = workspaces[wsIndex] ?? workspaces[0];

  const [kind, setKind] = useState<Kind>("merge");
  const [files, setFiles] = useState<File[]>([]);
  const [range, setRange] = useState("");
  const [usage, setUsage] = useState<{ used: number; limit: number | null; allowed: boolean } | null>(null);
  const [history, setHistory] = useState<Operation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!ws) return;
    const [meter, ops] = await Promise.all([
      api.get<{ used: number; limit: number | null; allowed: boolean }>(
        `/api/apps/workspace/${ws.id}/usage/pdf-tools`
      ),
      api.get<{ operations: Operation[] }>(`/api/pdftools/${ws.id}`),
    ]);
    if (meter.ok && meter.data) setUsage(meter.data);
    if (ops.ok && ops.data) setHistory(ops.data.operations);
  }, [ws]);

  useEffect(() => {
    load();
  }, [load]);

  function pick(fs: FileList | null) {
    setError(null);
    setNote(null);
    const pdfs = Array.from(fs ?? []).filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (pdfs.length !== (fs?.length ?? 0)) {
      setError("Only PDF files are supported.");
    }
    if (kind === "merge" && pdfs.length > 20) {
      setError("Merge supports up to 20 files at once.");
      return;
    }
    if (kind !== "merge" && pdfs.length > 1) {
      setError(`${KIND_LABEL[kind]} works on one file at a time — the first file was kept.`);
      setFiles(pdfs.slice(0, 1));
      return;
    }
    setFiles(pdfs);
  }

  function switchKind(next: Kind) {
    setKind(next);
    setFiles([]);
    setError(null);
    setNote(null);
  }

  function parseRange(input: string, pageCount: number): number[] {
    const pages = new Set<number>();
    for (const part of input.split(",")) {
      const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) throw new Error(`"${part}" is not a page number or range.`);
      const from = Number(m[1]);
      const to = Number(m[2] ?? m[1]);
      if (from < 1 || to > pageCount || from > to) throw new Error(`Range "${part.trim()}" is outside 1–${pageCount}.`);
      for (let p = from; p <= to; p++) pages.add(p);
    }
    if (pages.size === 0) throw new Error("Select at least one page.");
    return [...pages].sort((a, b) => a - b).map((p) => p - 1);
  }

  async function run() {
    if (!ws || files.length === 0) return;
    setRunning(true);
    setError(null);
    setNote(null);
    try {
      let outBytes = 0;
      let resultName = "output.pdf";
      let merged: PDFDocument | null = null;

      if (kind === "merge") {
        merged = await PDFDocument.create();
        for (const f of files) {
          const src = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
          const pages = await merged.copyPages(src, src.getPageIndices());
          pages.forEach((p) => merged!.addPage(p));
        }
        resultName = "merged.pdf";
      } else {
        const file = files[0];
        const src = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
        const base = file.name.replace(/\.pdf$/i, "");
        if (kind === "split") {
          const pages = parseRange(range, src.getPageCount());
          merged = await PDFDocument.create();
          const copied = await merged.copyPages(src, pages);
          copied.forEach((p) => merged!.addPage(p));
          resultName = `${base}-pages.pdf`;
        } else {
          merged = src;
          resultName = `${base}-optimized.pdf`;
        }
      }

      const optimized = kind === "compress";
      const bytes = await merged.save({ useObjectStreams: true });
      outBytes = bytes.byteLength;

      // Deliver the result, then tell the server for metering/history.
      download(bytes, resultName);

      const before = await totalInputBytes(files);
      setNote(
        optimized && before > 0
          ? `Saved ${resultName} — ${fmtBytes(before)} → ${fmtBytes(outBytes)}.`
          : `Saved ${resultName} (${fmtBytes(outBytes)}).`
      );

      const rec = await api.post(`/api/pdftools/${ws.id}`, {
        kind,
        input_names: files.map((f) => f.name),
        output_name: resultName,
        output_bytes: outBytes,
      });
      if (!rec.ok) {
        setError(
          rec.detail ??
            "The file was downloaded, but the operation could not be recorded against your monthly allowance."
        );
      }
      setFiles([]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function totalInputBytes(files: File[]): Promise<number> {
    if (files.length !== 1 || kind !== "compress") return 0;
    return files[0].size;
  }

  if (!ws) return <Card title="No workspace">Create a workspace first to use the PDF tools.</Card>;

  const blocked = usage !== null && !usage.allowed;

  return (
    <div>
      <PageTitle
        title="📄 PDF Utilities"
        subtitle="Merge, extract and optimize PDFs right in your browser — files never leave your device."
      />

      {workspaces.length > 1 && (
        <div className="mb-4 max-w-sm">
          <label className="mb-1 block text-xs font-medium text-slate-500">Workspace</label>
          <Select value={wsIndex} onChange={(e) => setWsIndex(Number(e.target.value))}>
            {workspaces.map((w, i) => (
              <option key={w.id} value={i}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {(["merge", "split", "compress"] as Kind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => switchKind(k)}
            className={cx(
              "card text-left transition",
              kind === k ? "ring-2 ring-brand-500" : "opacity-90 hover:opacity-100"
            )}
          >
            <p className="font-semibold text-slate-900 dark:text-slate-100">{KIND_LABEL[k]}</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{KIND_HINT[k]}</p>
          </button>
        ))}
      </div>

      <Card
        title={KIND_LABEL[kind]}
        action={
          usage && (
            <span className="text-xs text-slate-500">
              {usage.used}
              {usage.limit === null ? " operations this month" : ` / ${usage.limit} operations this month`}
            </span>
          )
        }
      >
        <ErrorText>{blocked ? "Monthly PDF operation limit reached for your plan. Upgrade in Billing to continue." : error}</ErrorText>

        {blocked ? null : (
          <div className="space-y-4">
            <div
              onClick={() => fileRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 py-8 text-center dark:border-slate-600"
            >
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                Click to choose {kind === "merge" ? "PDF files" : "a PDF file"}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {files.length > 0
                  ? files.map((f) => `${f.name} (${fmtBytes(f.size)})`).join(", ")
                  : kind === "merge"
                    ? "Up to 20 files — order of selection is preserved"
                    : "Processed locally, never uploaded"}
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,application/pdf"
                multiple={kind === "merge"}
                className="hidden"
                onChange={(e) => pick(e.target.files)}
              />
            </div>

            {kind === "split" && files.length > 0 && (
              <div className="max-w-xs">
                <label className="mb-1 block text-xs font-medium text-slate-500">
                  Pages to extract
                </label>
                <Input
                  value={range}
                  onChange={(e) => setRange(e.target.value)}
                  placeholder="e.g. 1-3,7"
                  maxLength={40}
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <Button onClick={() => fileRef.current?.click()} variant="secondary">
                Choose files
              </Button>
              <Button onClick={run} disabled={files.length === 0 || running || (kind === "split" && !range.trim())}>
                {running ? "Working…" : `Run: ${KIND_LABEL[kind]}`}
              </Button>
            </div>
            {usage && usage.limit !== null && (
              <p className="text-xs text-slate-400">
                Each completed operations counts against your monthly allowance (Starter 10, Pro unlimited).
              </p>
            )}
          </div>
        )}

        {note && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">{note}</p>}
      </Card>

      <Card title="History">
        <Table head={["Operation", "Input", "Output", "When"]}>
          {history.map((op) => (
            <tr key={op.id}>
              <td className="px-3 py-3">
                <Badge tone={op.kind === "merge" ? "blue" : op.kind === "split" ? "amber" : "green"}>{op.kind}</Badge>
              </td>
              <td className="px-3 py-3 text-xs text-slate-600 dark:text-slate-300">
                {safeInputCount(op.input_files)} file(s)
              </td>
              <td className="px-3 py-3 max-w-[220px] truncate text-sm text-slate-700 dark:text-slate-200">{op.output_file}</td>
              <td className="px-3 py-3 text-xs text-slate-400">{new Date(op.created_at).toLocaleString()}</td>
            </tr>
          ))}
          {history.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center text-sm text-slate-400">
                No operations yet.
              </td>
            </tr>
          )}
        </Table>
      </Card>
    </div>
  );
}

function safeInputCount(inputFiles: string): number {
  try {
    const arr = JSON.parse(inputFiles) as string[];
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

function download(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
