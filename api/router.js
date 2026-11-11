// Single Vercel function for every /api/* endpoint.
//
// The Hobby plan allows at most 12 functions per deployment, so each endpoint lives in
// api/_handlers/<name>.js (folders starting with "_" are not deployed as functions) and
// vercel.json rewrites /api/<name> to this router. URLs, methods, headers and query
// strings are unchanged for callers, including Vercel crons.
//
// Adding an endpoint: create api/_handlers/<name>.js and add one line to ROUTES below.
// Imports are lazy and literal so each request only loads the code its endpoint needs,
// and Vercel's bundler can still trace every handler.

const ROUTES = {
  "admin-analytics": () => import("./_handlers/admin-analytics.js"),
  "admin-availability-clear": () => import("./_handlers/admin-availability-clear.js"),
  "admin-availability-list": () => import("./_handlers/admin-availability-list.js"),
  "admin-availability-upsert": () => import("./_handlers/admin-availability-upsert.js"),
  "admin-bookings": () => import("./_handlers/admin-bookings.js"),
  "admin-cancel-booking": () => import("./_handlers/admin-cancel-booking.js"),
  "admin-cancel-subscription": () => import("./_handlers/admin-cancel-subscription.js"),
  "admin-change-subscription-plan": () => import("./_handlers/admin-change-subscription-plan.js"),
  "admin-complete-booking": () => import("./_handlers/admin-complete-booking.js"),
  "admin-checklists": () => import("./_handlers/admin-checklists.js"),
  "admin-create-booking": () => import("./_handlers/admin-create-booking.js"),
  "admin-create-customer": () => import("./_handlers/admin-create-customer.js"),
  "admin-create-vehicle": () => import("./_handlers/admin-create-vehicle.js"),
  "admin-crm-analytics": () => import("./_handlers/admin-crm-analytics.js"),
  "admin-crm-complete-task-outcome": () => import("./_handlers/admin-crm-complete-task-outcome.js"),
  "admin-crm-create-lead": () => import("./_handlers/admin-crm-create-lead.js"),
  "admin-crm-customer-detail": () => import("./_handlers/admin-crm-customer-detail.js"),
  "admin-crm-customers": () => import("./_handlers/admin-crm-customers.js"),
  "admin-crm-duplicates": () => import("./_handlers/admin-crm-duplicates.js"),
  "admin-crm-follow-up-task": () => import("./_handlers/admin-crm-follow-up-task.js"),
  "admin-crm-log-outreach": () => import("./_handlers/admin-crm-log-outreach.js"),
  "admin-crm-notes": () => import("./_handlers/admin-crm-notes.js"),
  "admin-crm-send-email": () => import("./_handlers/admin-crm-send-email.js"),
  "admin-crm-tags": () => import("./_handlers/admin-crm-tags.js"),
  "admin-crm-tasks": () => import("./_handlers/admin-crm-tasks.js"),
  "admin-crm-update-customer": () => import("./_handlers/admin-crm-update-customer.js"),
  "admin-crm-update-profile": () => import("./_handlers/admin-crm-update-profile.js"),
  "admin-crm-vehicle": () => import("./_handlers/admin-crm-vehicle.js"),
  "admin-customer-vehicles": () => import("./_handlers/admin-customer-vehicles.js"),
  "admin-delete-expense": () => import("./_handlers/admin-delete-expense.js"),
  "admin-deny-booking": () => import("./_handlers/admin-deny-booking.js"),
  "admin-discount-codes-create": () => import("./_handlers/admin-discount-codes-create.js"),
  "admin-discount-codes-disable": () => import("./_handlers/admin-discount-codes-disable.js"),
  "admin-discount-codes-list": () => import("./_handlers/admin-discount-codes-list.js"),
  "admin-expense-review": () => import("./_handlers/admin-expense-review.js"),
  "admin-extend-subscription-cycle": () => import("./_handlers/admin-extend-subscription-cycle.js"),
  "admin-force-create-subscription-cycle": () => import("./_handlers/admin-force-create-subscription-cycle.js"),
  "admin-history": () => import("./_handlers/admin-history.js"),
  "admin-job": () => import("./_handlers/admin-job.js"),
  "admin-list-expenses": () => import("./_handlers/admin-list-expenses.js"),
  "admin-login": () => import("./_handlers/admin-login.js"),
  "admin-pause-subscription": () => import("./_handlers/admin-pause-subscription.js"),
  "admin-record-expense": () => import("./_handlers/admin-record-expense.js"),
  "admin-reschedule-booking": () => import("./_handlers/admin-reschedule-booking.js"),
  "admin-payroll": () => import("./_handlers/admin-payroll.js"),
  "admin-request-reschedule": () => import("./_handlers/admin-request-reschedule.js"),
  "admin-resume-subscription": () => import("./_handlers/admin-resume-subscription.js"),
  "admin-schedule": () => import("./_handlers/admin-schedule.js"),
  "admin-search-customers": () => import("./_handlers/admin-search-customers.js"),
  "admin-service-variants": () => import("./_handlers/admin-service-variants.js"),
  "admin-staff": () => import("./_handlers/admin-staff.js"),
  "admin-staffing-clear": () => import("./_handlers/admin-staffing-clear.js"),
  "admin-staffing-enable": () => import("./_handlers/admin-staffing-enable.js"),
  "admin-staffing-list": () => import("./_handlers/admin-staffing-list.js"),
  "admin-subscription-cycle-action": () => import("./_handlers/admin-subscription-cycle-action.js"),
  "admin-subscription-detail": () => import("./_handlers/admin-subscription-detail.js"),
  "admin-subscriptions": () => import("./_handlers/admin-subscriptions.js"),
  "admin-time": () => import("./_handlers/admin-time.js"),
  "admin-waitlist": () => import("./_handlers/admin-waitlist.js"),
  "check-availability": () => import("./_handlers/check-availability.js"),
  "confirm-booking": () => import("./_handlers/confirm-booking.js"),
  "create-booking": () => import("./_handlers/create-booking.js"),
  "create-calendar-event": () => import("./_handlers/create-calendar-event.js"),
  "create-member-booking": () => import("./_handlers/create-member-booking.js"),
  "create-subscription": () => import("./_handlers/create-subscription.js"),
  "cron-check-missed-cycles": () => import("./_handlers/cron-check-missed-cycles.js"),
  "cron-crm-automation": () => import("./_handlers/cron-crm-automation.js"),
  "cron-generate-subscription-cycles": () => import("./_handlers/cron-generate-subscription-cycles.js"),
  "cron-send-booking-reminders": () => import("./_handlers/cron-send-booking-reminders.js"),
  "cron-send-subscription-reminders": () => import("./_handlers/cron-send-subscription-reminders.js"),
  "customer-cancel-booking": () => import("./_handlers/customer-cancel-booking.js"),
  "customer-cancel-subscription": () => import("./_handlers/customer-cancel-subscription.js"),
  "customer-reschedule-booking": () => import("./_handlers/customer-reschedule-booking.js"),
  "customer-subscription-pushback": () => import("./_handlers/customer-subscription-pushback.js"),
  "delete-calendar-event": () => import("./_handlers/delete-calendar-event.js"),
  "dev-create-test-booking": () => import("./_handlers/dev-create-test-booking.js"),
  "export-bookkeeping": () => import("./_handlers/export-bookkeeping.js"),
  "get-availability": () => import("./_handlers/get-availability.js"),
  "get-booking-by-token": () => import("./_handlers/get-booking-by-token.js"),
  "get-member-booking-context": () => import("./_handlers/get-member-booking-context.js"),
  "get-subscription-by-token": () => import("./_handlers/get-subscription-by-token.js"),
  "join-waitlist": () => import("./_handlers/join-waitlist.js"),
  "list-calendar-blocks": () => import("./_handlers/list-calendar-blocks.js"),
  "manage-booking-get": () => import("./_handlers/manage-booking-get.js"),
  "receipt-upload-url": () => import("./_handlers/receipt-upload-url.js"),
  "request-booking-access": () => import("./_handlers/request-booking-access.js"),
  "request-subscription-access": () => import("./_handlers/request-subscription-access.js"),
  "send-booking-cancelled-email": () => import("./_handlers/send-booking-cancelled-email.js"),
  "send-booking-completed-email": () => import("./_handlers/send-booking-completed-email.js"),
  "send-booking-confirmed-email": () => import("./_handlers/send-booking-confirmed-email.js"),
  "send-booking-created-email": () => import("./_handlers/send-booking-created-email.js"),
  "send-booking-denied-email": () => import("./_handlers/send-booking-denied-email.js"),
  "send-reschedule-link-email": () => import("./_handlers/send-reschedule-link-email.js"),
  "send-test-email": () => import("./_handlers/send-test-email.js"),
  "staff-availability": () => import("./_handlers/staff-availability.js"),
  "staff-clock": () => import("./_handlers/staff-clock.js"),
  "staff-complete-job": () => import("./_handlers/staff-complete-job.js"),
  "staff-expenses": () => import("./_handlers/staff-expenses.js"),
  "staff-job": () => import("./_handlers/staff-job.js"),
  "staff-job-photo": () => import("./_handlers/staff-job-photo.js"),
  "staff-jobs": () => import("./_handlers/staff-jobs.js"),
  "staff-login": () => import("./_handlers/staff-login.js"),
  "staff-me": () => import("./_handlers/staff-me.js"),
  "staff-pay": () => import("./_handlers/staff-pay.js"),
  "staff-shifts": () => import("./_handlers/staff-shifts.js"),
  "submit-reschedule": () => import("./_handlers/submit-reschedule.js"),
  "subscription-pushback": () => import("./_handlers/subscription-pushback.js"),
  "validate-discount-code": () => import("./_handlers/validate-discount-code.js"),
};

const ROUTE_PARAM = "__route";

function resolveRouteName(req) {
  const fromQuery = req.query?.[ROUTE_PARAM];
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  // Fallback: derive from the original path (/api/<name>).
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const match = pathname.match(/^\/api\/([^/]+)\/?$/);
  return match ? match[1] : "";
}

export default async function handler(req, res) {
  const name = resolveRouteName(req);
  if (req.query && ROUTE_PARAM in req.query) delete req.query[ROUTE_PARAM];

  const load = Object.prototype.hasOwnProperty.call(ROUTES, name) ? ROUTES[name] : null;
  if (!load) {
    return res.status(404).json({ error: "Not found" });
  }

  const mod = await load();
  return mod.default(req, res);
}

export const ROUTE_NAMES = Object.keys(ROUTES);
