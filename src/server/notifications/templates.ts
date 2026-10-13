/**
 * Transactional email templates. Every interpolated value goes through esc().
 * Emails never contain another resident's financial data.
 */
import { formatCents, type Cents } from "../finance/money";
import { formatDate, formatPeriod, type Period } from "../finance/period";

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, bodyHtml: string, action?: { label: string; url: string }): string {
  const button = action
    ? `<p style="margin:28px 0"><a href="${esc(action.url)}" style="background:#0f766e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${esc(action.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;border:1px solid #e7e5e4"><tr><td style="padding:28px">
<h1 style="font-size:18px;margin:0 0 16px">${esc(title)}</h1>${bodyHtml}${button}
<p style="font-size:12px;color:#78716c;margin-top:28px">This is an automated message from your apartment's rent management app. Please don't reply to this email.</p>
</td></tr></table></td></tr></table></body></html>`;
}

const p = (s: string) => `<p style="margin:0 0 12px;line-height:1.5">${s}</p>`;

function table(rows: string[][], header?: string[]): string {
  const th = header ? `<tr>${header.map((h, i) => `<th style="text-align:${i === 0 ? "left" : "right"};padding:6px 8px;border-bottom:1px solid #e7e5e4;font-size:13px;color:#57534e">${esc(h)}</th>`).join("")}</tr>` : "";
  const trs = rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${i === 0 ? "left" : "right"};padding:6px 8px;border-bottom:1px solid #f5f5f4;font-size:14px">${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 16px">${th}${trs}</table>`;
}

export function inviteEmail(o: { name: string; apartmentName: string; invitedBy: string; url: string; expiresHours: number }): EmailContent {
  const subject = `You're invited to ${o.apartmentName}`;
  return {
    subject,
    html: layout(subject, p(`Hi ${esc(o.name)},`) + p(`${esc(o.invitedBy)} invited you to the rent management app for <strong>${esc(o.apartmentName)}</strong>. There you can check what you owe, submit payments and find apartment documents.`) + p(`The link is valid for ${o.expiresHours} hours.`), { label: "Set up your account", url: o.url }),
    text: `Hi ${o.name},\n\n${o.invitedBy} invited you to the rent management app for ${o.apartmentName}.\nSet up your account (valid ${o.expiresHours} hours):\n${o.url}\n`,
  };
}

export function passwordResetEmail(o: { name: string; url: string; expiresMinutes: number }): EmailContent {
  const subject = "Reset your password";
  return {
    subject,
    html: layout(subject, p(`Hi ${esc(o.name)},`) + p(`Someone asked to reset the password for your account. If that was you, use the button below within ${o.expiresMinutes} minutes. If it wasn't, you can ignore this email; your password stays the same.`), { label: "Choose a new password", url: o.url }),
    text: `Hi ${o.name},\n\nReset your password (valid ${o.expiresMinutes} minutes):\n${o.url}\n\nIf you didn't ask for this, ignore this email.`,
  };
}

export function securityNoticeEmail(o: { name: string; what: string; url: string }): EmailContent {
  const subject = "Security notice for your account";
  return {
    subject,
    html: layout(subject, p(`Hi ${esc(o.name)},`) + p(esc(o.what)) + p("If this wasn't you, reset your password right away and contact the apartment administrator."), { label: "Open the app", url: o.url }),
    text: `Hi ${o.name},\n\n${o.what}\nIf this wasn't you, reset your password and contact the apartment administrator.\n${o.url}`,
  };
}

export function simpleEmail(o: { name: string; subject: string; lines: string[]; url: string; action?: string }): EmailContent {
  return {
    subject: o.subject,
    html: layout(o.subject, p(`Hi ${esc(o.name)},`) + o.lines.map((l) => p(esc(l))).join(""), { label: o.action ?? "Open the app", url: o.url }),
    text: `Hi ${o.name},\n\n${o.lines.join("\n\n")}\n\n${o.url}`,
  };
}

export interface ReminderMonthRow {
  period: Period;
  due: Cents;
  confirmed: Cents;
  outstanding: Cents;
}

export function reminderEmail(o: {
  name: string;
  period: Period;
  dueDate: Date;
  kind: "upcoming" | "due" | "overdue";
  current: ReminderMonthRow;
  overdueMonths: ReminderMonthRow[];
  totalOutstanding: Cents;
  pendingCents: Cents | null;
  url: string;
}): EmailContent {
  const subject =
    o.kind === "overdue"
      ? `Overdue balance: ${formatCents(o.totalOutstanding)}`
      : o.kind === "due"
        ? `Rent for ${formatPeriod(o.period)} is due today`
        : `Reminder: rent for ${formatPeriod(o.period)} is due ${formatDate(o.dueDate)}`;
  const rows = [...o.overdueMonths, ...(o.current.outstanding > 0 && !o.overdueMonths.some((m) => m.period === o.current.period) ? [o.current] : [])];
  const tableRows = rows.map((m) => [formatPeriod(m.period), formatCents(m.due), formatCents(m.confirmed), formatCents(m.outstanding)]);
  const pendingLine = o.pendingCents && o.pendingCents > 0 ? `You also have payments of ${formatCents(o.pendingCents)} waiting for verification. They are not included in the confirmed amounts above.` : null;
  const html =
    p(`Hi ${esc(o.name)},`) +
    p(`Here is your rent status for <strong>${esc(formatPeriod(o.period))}</strong> (due ${esc(formatDate(o.dueDate))}).`) +
    table(tableRows, ["Month", "Amount due", "Confirmed payments", "Outstanding"]) +
    p(`<strong>Total outstanding: ${esc(formatCents(o.totalOutstanding))}</strong>`) +
    (pendingLine ? p(esc(pendingLine)) : "") +
    p("If you have already paid, submit the transfer in the app so it can be verified.");
  const text =
    `Hi ${o.name},\n\nRent status for ${formatPeriod(o.period)} (due ${formatDate(o.dueDate)}):\n` +
    rows.map((m) => `- ${formatPeriod(m.period)}: due ${formatCents(m.due)}, confirmed ${formatCents(m.confirmed)}, outstanding ${formatCents(m.outstanding)}`).join("\n") +
    `\n\nTotal outstanding: ${formatCents(o.totalOutstanding)}\n` +
    (pendingLine ? `\n${pendingLine}\n` : "") +
    `\nOpen your dashboard: ${o.url}\n`;
  return { subject, html: layout(subject, html, { label: "Open my dashboard", url: o.url }), text };
}

export function priceChangeEmail(o: {
  name: string;
  categoryLabel: string;
  effectiveFrom: Period;
  reason: string;
  previousCents: Cents;
  newCents: Cents;
  revisedMonthlyCents: Cents | null;
  url: string;
}): EmailContent {
  const subject = `${o.categoryLabel} changes from ${formatPeriod(o.effectiveFrom)}`;
  const rows = [
    ["Previous amount", formatCents(o.previousCents)],
    ["New amount", formatCents(o.newCents)],
    ["Effective from", formatPeriod(o.effectiveFrom)],
    ...(o.revisedMonthlyCents != null ? [["Your new monthly total", formatCents(o.revisedMonthlyCents)]] : []),
  ];
  return {
    subject,
    html: layout(subject, p(`Hi ${esc(o.name)},`) + p(`Your ${esc(o.categoryLabel.toLowerCase())} share is changing.`) + table(rows) + p(`<strong>Reason:</strong> ${esc(o.reason)}`) + p("Months before the effective date are not affected."), { label: "View the announcement", url: o.url }),
    text: `Hi ${o.name},\n\nYour ${o.categoryLabel.toLowerCase()} share is changing.\n${rows.map((r) => `${r[0]}: ${r[1]}`).join("\n")}\nReason: ${o.reason}\n\n${o.url}`,
  };
}
