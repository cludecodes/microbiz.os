import { Link } from "react-router-dom";
import { PHASE1_APP_IDS } from "@microbiz/shared";
import { Badge, Button, Logo } from "../components/ui";

const PRODUCT_CARDS = [
  {
    id: "whatsapp-crm",
    name: "WhatsApp CRM & Orders",
    desc: "Contacts, catalogs and WhatsApp order pipelines for shops that sell in chat.",
    icon: "💬",
  },
  {
    id: "qr-menu",
    name: "Restaurant QR Menu",
    desc: "Mobile-first QR menus with live ordering — no app install for guests.",
    icon: "🍽️",
  },
  {
    id: "invoices",
    name: "Invoice & Quotations",
    desc: "Professional invoices, quotations and automated payment reminders.",
    icon: "🧾",
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <nav className="flex items-center gap-3">
          <Link to="/login">
            <Button variant="ghost">Log in</Button>
          </Link>
          <Link to="/register">
            <Button>Get started free</Button>
          </Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-6 pb-16 pt-10 text-center md:pt-20">
          <Badge tone="blue">Built for 🇵🇰 Pakistan & 🇺🇸 United States</Badge>
          <h1 className="mx-auto mt-5 max-w-3xl text-4xl font-bold tracking-tight md:text-5xl">
            One account. Every micro-app your small business needs.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-600 dark:text-slate-400">
            MicroBiz OS unifies workspaces, authentication, billing and analytics across
            independent web apps — start free, pay only as your business grows.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/register">
              <Button className="px-6 py-3 text-base">Create free account</Button>
            </Link>
            <Link to="/login">
              <Button variant="secondary" className="px-6 py-3 text-base">
                Log in
              </Button>
            </Link>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-16">
          <div className="grid gap-5 md:grid-cols-3">
            {PRODUCT_CARDS.map((p) => (
              <article key={p.id} className="card !p-6">
                <div className="text-3xl">{p.icon}</div>
                <h3 className="mt-3 font-semibold">{p.name}</h3>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{p.desc}</p>
                <span className="mt-4 inline-block text-xs font-medium uppercase tracking-wide text-brand-600 dark:text-brand-400">
                  Phase 1
                </span>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-20 text-sm text-slate-500 dark:text-slate-400">
          <p>
            Payments: Safepay (Pakistan) · Lemon Squeezy (global SaaS) · Raast/bank
            reconciliation. PKR and USD supported. Money handling uses an auditable
            double-entry ledger — balances shown are always provider-verified figures.
          </p>
        </section>
      </main>

      <footer className="border-t border-slate-200 py-8 text-center text-xs text-slate-500 dark:border-slate-800">
        © {new Date().getFullYear()} MicroBiz OS · English-first, Urdu-ready · Mobile-first PWA
      </footer>
    </div>
  );
}
