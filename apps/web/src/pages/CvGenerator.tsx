import { useEffect, useState } from "react";
import { Button, Card, Input, PageTitle, cx } from "../components/ui";

type TemplateKind = "basic" | "professional" | "creative";

interface ExperienceRow {
  role: string;
  company: string;
  period: string;
  details: string;
}

interface EducationRow {
  degree: string;
  school: string;
  period: string;
}

interface CvData {
  name: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  website: string;
  summary: string;
  skills: string;
  experience: ExperienceRow[];
  education: EducationRow[];
}

const STORAGE_KEY = "mbos.cv.v1";

const EMPTY: CvData = {
  name: "",
  headline: "",
  email: "",
  phone: "",
  location: "",
  website: "",
  summary: "",
  skills: "",
  experience: [{ role: "", company: "", period: "", details: "" }],
  education: [{ degree: "", school: "", period: "" }],
};

const TEMPLATES: { id: TemplateKind; name: string; blurb: string }[] = [
  { id: "basic", name: "Minimal", blurb: "Clean serif layout — recruiters' favourite for ATS scanning." },
  { id: "professional", name: "Professional", blurb: "Structured sections with an accent rule. Great for corporate roles." },
  { id: "creative", name: "Creative", blurb: "Bolder header block with color. Creative and client-facing roles." },
];

export default function CvGenerator() {
  const [template, setTemplate] = useState<TemplateKind>(() => loadPrefs().template);
  const [data, setData] = useState<CvData>(() => loadPrefs().data);

  // Autosave to localStorage so work survives refreshes. No server storage yet.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ template, data }));
    } catch {
      // Storage may be unavailable (private mode) — the builder still works.
    }
  }, [template, data]);

  function set<K extends keyof CvData>(key: K, value: CvData[K]) {
    setData((d) => ({ ...d, [key]: value }));
  }

  function updateRow(
    key: "experience" | "education",
    index: number,
    field: string,
    value: string
  ) {
    setData((d) => {
      if (key === "experience") {
        const rows = [...d.experience];
        rows[index] = { ...rows[index], [field]: value } as ExperienceRow;
        return { ...d, experience: rows };
      }
      const rows = [...d.education];
      rows[index] = { ...rows[index], [field]: value } as EducationRow;
      return { ...d, education: rows };
    });
  }

  function addRow(key: "experience" | "education") {
    setData((d) => {
      if (key === "experience") {
        return { ...d, experience: [...d.experience, { role: "", company: "", period: "", details: "" }] };
      }
      return { ...d, education: [...d.education, { degree: "", school: "", period: "" }] };
    });
  }

  function removeRow(key: "experience" | "education", index: number) {
    setData((d) => {
      if (key === "experience") {
        return { ...d, experience: d.experience.filter((_, i) => i !== index) };
      }
      return { ...d, education: d.education.filter((_, i) => i !== index) };
    });
  }

  return (
    <div>
      <PageTitle
        title="📋 CV Generator"
        subtitle="Fill the form, pick a template and export a PDF via the print dialog — free, no third-party service."
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 no-print">
        <div className="flex flex-wrap gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTemplate(t.id)}
              title={t.blurb}
              className={cx(
                "rounded-full px-3 py-1.5 text-xs font-medium transition",
                template === t.id
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
              )}
            >
              {t.name}
            </button>
          ))}
        </div>
        <Button onClick={() => window.print()}>Print / Save as PDF</Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Editor ------------------------------------------------------------ */}
        <div className="space-y-4 no-print">
          <Card title="Profile">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name">
                <Input value={data.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
              </Field>
              <Field label="Headline">
                <Input value={data.headline} onChange={(e) => set("headline", e.target.value)} maxLength={80} placeholder="e.g. Frontend Developer" />
              </Field>
              <Field label="Email">
                <Input type="email" value={data.email} onChange={(e) => set("email", e.target.value)} />
              </Field>
              <Field label="Phone">
                <Input value={data.phone} onChange={(e) => set("phone", e.target.value)} />
              </Field>
              <Field label="Location">
                <Input value={data.location} onChange={(e) => set("location", e.target.value)} />
              </Field>
              <Field label="Website / LinkedIn">
                <Input value={data.website} onChange={(e) => set("website", e.target.value)} />
              </Field>
            </div>
            <div className="mt-3">
              <Field label="Summary">
                <textarea className="input min-h-[90px]" maxLength={600} value={data.summary} onChange={(e) => set("summary", e.target.value)} />
              </Field>
            </div>
            <div className="mt-3">
              <Field label="Skills (comma separated)">
                <Input value={data.skills} onChange={(e) => set("skills", e.target.value)} placeholder="React, Arabic typing, QuickBooks" />
              </Field>
            </div>
          </Card>

          <Card
            title="Experience"
            action={
              <Button variant="ghost" onClick={() => addRow("experience")}>
                + Add
              </Button>
            }
          >
            <div className="space-y-4">
              {data.experience.map((row, i) => (
                <div key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Role">
                      <Input value={row.role} onChange={(e) => updateRow("experience", i, "role", e.target.value)} />
                    </Field>
                    <Field label="Company">
                      <Input value={row.company} onChange={(e) => updateRow("experience", i, "company", e.target.value)} />
                    </Field>
                  </div>
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    <Field label="Period">
                      <Input value={row.period} onChange={(e) => updateRow("experience", i, "period", e.target.value)} placeholder="2023 — 2026" />
                    </Field>
                  </div>
                  <div className="mt-2">
                    <Field label="Achievements (one per line)">
                      <textarea className="input min-h-[70px]" value={row.details} onChange={(e) => updateRow("experience", i, "details", e.target.value)} />
                    </Field>
                  </div>
                  <Button variant="ghost" onClick={() => removeRow("experience", i)} disabled={data.experience.length === 1}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="Education"
            action={
              <Button variant="ghost" onClick={() => addRow("education")}>
                + Add
              </Button>
            }
          >
            <div className="space-y-4">
              {data.education.map((row, i) => (
                <div key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Degree">
                      <Input value={row.degree} onChange={(e) => updateRow("education", i, "degree", e.target.value)} />
                    </Field>
                    <Field label="School">
                      <Input value={row.school} onChange={(e) => updateRow("education", i, "school", e.target.value)} />
                    </Field>
                    <Field label="Period">
                      <Input value={row.period} onChange={(e) => updateRow("education", i, "period", e.target.value)} />
                    </Field>
                  </div>
                  <Button variant="ghost" onClick={() => removeRow("education", i)} disabled={data.education.length === 1}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </Card>

          <p className="text-xs text-slate-500">
            Your CV is stored privately in this browser (localStorage). Server-side CV saving and
            metered generation arrive in the next iteration.
          </p>
        </div>

        {/* Live A4 preview --------------------------------------------------- */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400 no-print">Live preview</p>
          <div className="cv-sheet rounded-xl bg-white p-8 text-slate-900 shadow-sm">
            <CvSheet data={data} template={template} />
          </div>
        </div>
      </div>

      <style>{`@media print {
    .no-print, header, aside, nav { display: none !important; }
    main { padding: 0 !important; }
    body, .cv-sheet { background: #fff !important; }
    .cv-sheet { border-radius: 0 !important; box-shadow: none !important; padding: 32px !important; }
  }`}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ sheet */

function CvSheet({ data, template }: { data: CvData; template: TemplateKind }) {
  const skills = data.skills.split(",").map((s) => s.trim()).filter(Boolean);
  const section = cx(
    "mt-5",
    template === "basic"
      ? "border-t border-slate-300 pt-3"
      : template === "professional"
        ? "border-t-2 border-brand-600 pt-3"
        : "border-t border-slate-200 pt-3"
  );
  const heading = cx(
    "text-[11px] font-semibold uppercase tracking-widest",
    template === "creative" ? "text-brand-700" : "text-slate-500"
  );

  const headerBlock =
    template === "creative" ? (
      <div className="-mx-8 -mt-8 mb-4 bg-brand-600 px-8 py-6 text-white">
        <p className="text-2xl font-bold">{data.name || "Your Name"}</p>
        {data.headline && <p className="mt-0.5 text-sm text-white/90">{data.headline}</p>}
        <ContactLine data={data} className="mt-2 text-white/90" />
      </div>
    ) : template === "professional" ? (
      <header className="border-b-4 border-brand-600 pb-4">
        <p className="text-3xl font-bold text-slate-900">{data.name || "Your Name"}</p>
        {data.headline && <p className="mt-1 text-sm font-medium text-brand-700">{data.headline}</p>}
        <ContactLine data={data} className="mt-2" />
      </header>
    ) : (
      <header>
        <p className="font-serif text-3xl tracking-tight text-slate-900">{data.name || "Your Name"}</p>
        {data.headline && <p className="mt-1 font-serif text-sm text-slate-600">{data.headline}</p>}
        <ContactLine data={data} className="mt-2 border-t border-slate-200 pt-2" />
      </header>
    );

  return (
    <div className={template === "basic" ? "font-serif" : "font-sans"}>
      {headerBlock}

      {data.summary && (
        <section className={section}>
          <p className={heading}>Summary</p>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-700">{data.summary}</p>
        </section>
      )}

      {data.experience.some((r) => r.role || r.company || r.details) && (
        <section className={section}>
          <p className={heading}>Experience</p>
          {data.experience.map((row, i) =>
            row.role || row.company || row.details ? (
              <div key={i} className="mt-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold">{row.role || "—"}</p>
                  <p className="text-xs text-slate-500">{row.period}</p>
                </div>
                <p className="text-xs text-slate-600">{row.company}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-slate-700">
                  {row.details.split("\n").filter(Boolean).map((line, j) => (
                    <li key={j}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null
          )}
        </section>
      )}

      {data.education.some((r) => r.degree || r.school) && (
        <section className={section}>
          <p className={heading}>Education</p>
          {data.education.map((row, i) =>
            row.degree || row.school ? (
              <div key={i} className="mt-2 flex items-baseline justify-between gap-2">
                <p className="text-sm">
                  {row.degree}
                  {row.school && <span className="text-slate-600"> · {row.school}</span>}
                </p>
                <p className="text-xs text-slate-500">{row.period}</p>
              </div>
            ) : null
          )}
        </section>
      )}

      {skills.length > 0 && (
        <section className={section}>
          <p className={heading}>Skills</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {skills.map((s, i) => (
              <span
                key={i}
                className={cx(
                  "rounded-full px-2 py-0.5 text-[11px]",
                  template === "creative" ? "bg-brand-100 text-brand-800" : "bg-slate-100 text-slate-700"
                )}
              >
                {s}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ContactLine({ data, className }: { data: CvData; className?: string }) {
  const parts = [data.email, data.phone, data.location, data.website].filter(Boolean);
  if (parts.length === 0) return null;
  return <p className={cx("text-xs", className)}>{parts.join("  ·  ")}</p>;
}

/* ------------------------------------------------------------------ bits */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function loadPrefs(): { template: TemplateKind; data: CvData } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { template?: TemplateKind; data?: Partial<CvData> };
      return { template: parsed.template ?? "basic", data: { ...EMPTY, ...parsed.data } };
    }
  } catch {
    // fall through to a fresh CV
  }
  return { template: "basic", data: EMPTY };
}
