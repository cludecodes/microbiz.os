/**
 * Money handling for MicroBiz OS.
 *
 * Rules:
 * - Every monetary amount is stored as an INTEGER in the smallest unit of the
 *   currency (paisa for PKR, cents for USD). Floating point is never used.
 * - Mixed-currency arithmetic is forbidden; journals always balance per
 *   currency. This is enforced in ledger.ts.
 */

export type CurrencyCode = "PKR" | "USD";

export interface CurrencyMeta {
  code: CurrencyCode;
  /** Locale display. */
  label: string;
  /** Fractional digits in the smallest unit (paisa/cents). */
  decimals: 0 | 2;
  symbol: string;
}

export const CURRENCIES: Record<CurrencyCode, CurrencyMeta> = {
  PKR: { code: "PKR", label: "Pakistani Rupee", decimals: 2, symbol: "₨" },
  USD: { code: "USD", label: "US Dollar", decimals: 2, symbol: "$" },
};

export function isCurrency(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

/**
 * Convert a decimal amount entered by a human (e.g. "1500.50") into minor
 * units. Throws on invalid input rather than silently truncating.
 */
export function toMinorUnits(majorAmount: string | number, currency: CurrencyCode): number {
  const meta = CURRENCIES[currency];
  const s = typeof majorAmount === "number" ? majorAmount.toString(10) : majorAmount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid amount: ${s}`);
  }
  const negative = s.startsWith("-");
  const [wholeRaw, fracRaw = ""] = negative ? s.slice(1).split(".") : s.split(".");
  const frac = (fracRaw + "0".repeat(meta.decimals)).slice(0, meta.decimals);
  if (fracRaw.length > meta.decimals && Number(fracRaw.slice(meta.decimals)) !== 0) {
    throw new Error(`Too many fractional digits for ${currency}: ${s}`);
  }
  const minor = Number(wholeRaw) * Math.pow(10, meta.decimals) + Number(frac || "0" as unknown as number);
  return negative ? -minor : minor;
}

/** Format minor units as a display string: "₨1,500.00" / "$45.99". */
export function formatMoney(minorUnits: number, currency: CurrencyCode): string {
  const meta = CURRENCIES[currency];
  const negative = minorUnits < 0;
  const abs = Math.abs(minorUnits);
  const whole = Math.floor(abs / Math.pow(10, meta.decimals));
  const frac = (abs - whole * Math.pow(10, meta.decimals))
    .toString()
    .padStart(meta.decimals, "0");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fracPart = meta.decimals > 0 ? `.${frac}` : "";
  return `${negative ? "-" : ""}${meta.symbol}${wholeStr}${fracPart}`;
}

/** Format per-market style: PKR uses South Asian comma grouping (1,50,000). */
export function formatMoneyLocalized(minorUnits: number, currency: CurrencyCode, _locale: string): string {
  // English-first interface: grouping refinements come with the i18n pass.
  return formatMoney(minorUnits, currency);
}
