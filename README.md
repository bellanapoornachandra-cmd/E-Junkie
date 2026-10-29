# E-Junkie

Doorstep e-waste pickup booking and operations app for India, launching in Visakhapatnam. There are three roles — Customer, Collector, Admin — plus an Eco Wallet for verified recycling points.

It is a service marketplace and operations tool, not a store. It has no payment processing, live maps or route optimisation.

## Set up and run

Requires Node.js 24.7 or newer (it uses the built-in `node:sqlite` and argon2). There are no npm dependencies and no build step.

1. Copy `.env.example` to `.env` and fill in `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 10 characters). `.env` is listed in `.gitignore`; never commit it.
2. Initialise the database, then start the app:

```bash
npm run setup      # creates the database, configuration defaults and the first admin
npm start          # http://localhost:3000 (also runs setup automatically)
npm test           # API tests (in-memory database)
npm run reset      # stop the server first; DELETES the database for a clean install
```

Setup is safe to re-run:

- The admin is created only when no admin exists. Re-running never duplicates it or resets its password.
- The password is stored as an argon2id hash and is never logged or shown.
- The admin must choose a new password at first login.
- After the first admin exists, you can clear the two `.env` values.

### What a fresh install contains

- **One user: the admin.** There are no customers, collectors, bookings, addresses, wallet entries, recyclers or handoffs. Every table and dashboard shows an empty state until real data arrives.
- **Configuration defaults**, all editable by the admin:
  - one service area, *Visakhapatnam*, with an initial list of PIN codes
  - item categories
  - pickup slots for the next 14 days (three windows a day, 6 pickups each)
  - pickup fee ₹0
  - a 12-hour change cutoff
- **Not set until the admin configures them:**
  - Eco Points rules: none exist, so points cannot be approved until a rule exists.
  - The ₹ value per point: none is shown.
  - Redemption: off, so customers see "Redemption coming soon".
  - Support contact details.
  - Recyclers: there is no certification claim until a recycler is verified and the claim is switched on.

### Accounts

- **Customers** register themselves from *Sign up*.
- **Collectors** are created by the admin (Admin → Collectors) with a temporary password. They must change it at first login.
- **Recyclers** are records the admin adds under Admin → Recyclers.

## Structure

```
server/
  server.js   HTTP server, static files, security headers, JSON-only API
  app.js      every API route, with role checks and business rules
  db.js       schema, configuration defaults, first-admin setup, password hashing
  setup.js    one-off database initialisation (npm run setup)
  reset.js    deletes the database (npm run reset)
  util.js     IST date helpers, settings schema, points valuation
public/
  index.html, styles.css
  js/ui.js        escaping templates, formatting (en-IN, IST, ₹), shared widgets
  js/app.js       router, navigation, login/sign-up
  js/customer.js  home, booking flow, My pickups, receipt, Eco Wallet, account
  js/ops.js       pickup details (all roles) and the collector dashboard
  js/admin.js     dashboard and all admin tables
test/api.test.js
```

## Data tables

Users, sessions, service areas, addresses, item categories, pickup slots (capacity and booked count; remaining = capacity − booked) and bookings. Bookings carry booking items (estimates) and collected items (actuals). The remaining tables are status history, recyclers, recycler handoffs (with handoff bookings and handoff items), Eco Points rules, wallet transactions, redemptions, settings and the audit log.

## Rules the server enforces

- **Privacy.** Customers see only their own bookings, addresses and wallet. Collectors see only bookings assigned to them. Admins see everything. Customers see collectors by first name only. Reviewer names and the audit trail are admin-only.
- **Booking.** Customers can book only:
  - accepted categories
  - a PIN code in an active service area
  - an active slot for that area, inside the booking window, with the minimum notice, and with remaining capacity
- **Slot capacity.** Each booking takes one place in its slot, with a guarded update inside a transaction, so a full slot cannot be overbooked. Cancelling gives the place back. Rescheduling releases the old slot and takes the new one. An admin cannot lower capacity below the bookings already in a slot.
- **Fee.** The fee shown before confirmation is checked when the booking is submitted. If an admin changed it in between, the customer is asked to review again. The default is ₹0.
- **Data-wipe confirmation.** It is required to book.
- **Booking ID.** It is unique and readable, e.g. `EJ-261029-K7QD`.
- **Reschedule and cancel cutoff.** Customers can change a booking only while it is Booked or Collector assigned, and only before the cutoff (default 12 hours before the slot starts). Admins can change any booking that isn't closed.
- **Status flow.** Booked → Collector assigned → On the way → (Arrived) → Collected → Received by recycler. "Unable to collect" and "Cancelled" are exceptions.
  - Only an assigned collector or an admin can move a booking to **Collected**, and only by recording the actual categories, counts and weights.
  - Only a recorded recycler handoff can move it to **Received by recycler**.
  - "Unable to collect" requires a note.
- **Eco Wallet.**
  - Recording a collection creates one *Pending* transaction per collected category. It uses the active rule effective on the collection date, and stores a copy of the rule applied.
  - An admin approves (choosing the rule and verified count or weight) or rejects (a note is required).
  - Approval is a guarded single update, so the same entry cannot be approved twice.
  - The available balance counts only Approved points not tied up in a redemption. Pending, Rejected and Redeemed points are never counted.
  - Customers have no endpoint that edits points or transactions.
  - Approved points can be reversed with a reason, as an audited correction.
- **Redemption.** The button works only when an admin has enabled redemption and set a method. Requesting it locks the available points. The admin then marks it fulfilled (with a payment or voucher reference, which marks the points Redeemed) or rejects it (which unlocks them).
- **Certification claims.** A claim is shown to customers only when the recycler is marked verified and "show claim" is on.
- **Audit.** These all write to the audit log with who did it and when:
  - wallet reviews, reversals and redemptions
  - collections and handoffs
  - assignments and admin cancellations or reschedules
  - settings, rules, areas, categories and recyclers
  - users and slots

  Every booking also has its own status history.

## Needs an external automation or a manual admin process

| Rule or need | Why it is not automatic | Suggested handling |
|---|---|---|
| SMS/WhatsApp/email confirmations and reminders (including the data-wipe reminder the day before) | No messaging provider is configured | Add an SMS/WhatsApp provider (e.g. via a webhook on booking creation), or call customers manually for the MVP |
| Generating future pickup slots | Slots are created in batches, not on a schedule | Admin → Pickup slots → Generate (e.g. every Monday), or a scheduled job calling `/api/admin/slots/generate` |
| Recycler verification and certification wording | Needs document checks (e.g. PCB authorisation) | Manual: verify outside the app, then tick "verified" and "show claim" |
| Valuation approval (point value in ₹, rules) | A business and legal decision | Manual: add approved rules (tick "Provisional" for non-final rates), set the ₹ value per point, then untick "point value is a sample" |
| Paying out redemptions | No payment processing in this version | Manual: pay by the approved method outside the app, then record the reference |
| Collector route order | No route optimisation | Admin sets the stop number when assigning |
| Forgotten passwords and staff onboarding | No email delivery | Admin creates staff with a temporary password, shared privately; it must be changed at first login |
| Backups | SQLite file at `data/ejunkie.db` | Copy the file daily, or move to a managed database before scaling |

### If you rebuild this in Softr, Airtable or another no-code tool

The same tables map one-to-one. Softr's user groups and "logged-in user" filters can cover the page-level visibility rules. These rules need an automation (Airtable automations, Make or Zapier), or an admin-only form, because a no-code front end cannot enforce them safely on its own:

- capacity changes on book, cancel and reschedule
- the booking-ID format
- the fee re-check
- creating pending wallet transactions on collection
- guarded approve and redeem updates
- writing the audit log

Never give customers edit access to the wallet or rules tables.

## Before going live

- Serve it over HTTPS behind a reverse proxy, and add rate limiting to `/api/auth/login`.
- Set the support phone and email, the Eco Points rules and point value, and add verified recyclers.

## Follow-up prompt: Assign collectors to customer pickups

Add an admin feature to assign collectors to customer pickups. In the admin Pickup Bookings view, let admins assign or change a collector for a booking. Only show active collectors who serve that booking’s area. Save the assignment, update the booking status to “Collector assigned,” and add an auditable status-history entry with the admin and timestamp. Make assignments available from both the bookings table and booking details. Keep the assignment restricted to admins in the server/API, and show the assigned collector to the customer and the booking to that collector. Include clear feedback for successful assignment and validation errors.
