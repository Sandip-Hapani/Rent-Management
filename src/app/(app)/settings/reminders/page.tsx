import { requirePageAdmin } from "@/server/auth/context";
import { emailHistory, getReminderSchedule } from "@/server/notifications/queries";
import { buildReport } from "@/server/reports/service";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ReportTableView } from "@/components/report-table";
import { Card, CardHeader, Field, Input, StatusBadge, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { reminderScheduleAction, runJobsNowAction } from "@/app/actions/admin";

export const metadata = { title: "Reminders & email" };

export default async function RemindersPage() {
  const ctx = await requirePageAdmin();
  const [s, history, emails] = await Promise.all([getReminderSchedule(ctx), buildReport(ctx, "reminders", {}), emailHistory(ctx)]);
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Rent reminder schedule" description="Sent automatically by the background worker, at most one email per resident per day. Each email only shows that resident's own figures." />
          <div className="p-5">
            <ActionForm action={reminderScheduleAction}>
              <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="enabled" defaultChecked={s.enabled} /> Automatic reminders enabled</label>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Days before the due date" htmlFor="daysBeforeDue" hint="Comma-separated, e.g. 5, 1"><Input id="daysBeforeDue" name="daysBeforeDue" defaultValue={s.daysBeforeDue.join(", ")} /></Field>
                <Field label="Follow-ups: days after the due date" htmlFor="daysAfterDue" hint="e.g. 3, 7"><Input id="daysAfterDue" name="daysAfterDue" defaultValue={s.daysAfterDue.join(", ")} /></Field>
                <Field label="Then repeat every … days (optional)" htmlFor="repeatEveryDays"><Input id="repeatEveryDays" name="repeatEveryDays" type="number" min={1} max={60} defaultValue={s.repeatEveryDays ?? ""} /></Field>
                <Field label="Max reminders per month" htmlFor="maxReminders"><Input id="maxReminders" name="maxReminders" type="number" min={1} max={20} defaultValue={s.maxReminders} /></Field>
                <Field label="Send at (hour, Berlin time)" htmlFor="sendHourLocal"><Input id="sendHourLocal" name="sendHourLocal" type="number" min={0} max={23} defaultValue={s.sendHourLocal} /></Field>
              </div>
              <div className="space-y-2 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" name="onDueDate" defaultChecked={s.onDueDate} /> Send a reminder on the due date</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="excludeFullyPaid" defaultChecked={s.excludeFullyPaid} /> Skip residents whose month is fully paid (verified)</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="stopWhenVerified" defaultChecked={s.stopWhenVerified} /> Stop follow-ups once the balance is verified as paid</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="mentionPending" defaultChecked={s.mentionPending} /> Mention payments still waiting for verification</label>
              </div>
              <SubmitButton>Save schedule</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardHeader title="Run now" description="Runs the reminder and email jobs immediately. Safe to repeat; nothing is sent twice." />
          <div className="p-5"><ActionForm action={runJobsNowAction}><SubmitButton variant="secondary" pendingText="Running…">Run reminder job</SubmitButton></ActionForm></div>
        </Card>
      </div>
      <Card>
        <CardHeader title="Reminder history" description="Sent, skipped and failed reminders for the last 12 months" />
        <ReportTableView table={history} maxRows={200} />
      </Card>
      <Card>
        <CardHeader title="Email log" description="All outgoing email (latest 300). Message contents are not shown here." />
        <Table>
          <thead><tr><Th>Created</Th><Th>To</Th><Th>Subject</Th><Th>Status</Th><Th>Detail</Th></tr></thead>
          <tbody>
            {emails.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap">{formatDateTime(e.createdAt)}</Td>
                <Td>{e.toEmail}</Td>
                <Td className="max-w-[16rem] truncate" ><span title={e.subject}>{e.subject}</span></Td>
                <Td><StatusBadge status={e.status} /></Td>
                <Td wrap className="!min-w-0 text-xs text-muted">{e.status === "SENT" && e.sentAt ? formatDateTime(e.sentAt) : e.skipReason ?? e.lastError ?? (e.attempts ? `${e.attempts} attempt(s)` : "")}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
