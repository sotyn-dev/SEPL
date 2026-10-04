# sotyn.ai (SEPL)

Source for **sotyn.ai** — construction ERP for Indian EPC, MEPF, solar and civil
contracting firms. Built and run by **Secured Engineers Pvt. Ltd.**, a 14-year MEPF
and solar EPC contractor that is also its first and largest user.

Product site: <https://www.sotyn.ai>

It covers the chain where contractor margin leaks: site staff raise indents against a
BOQ line from any phone browser; the purchase desk compares vendor rates; value-based
approvals are recorded with the comparison attached; and the PO, receipt and debit note
trace back to the original request. On the billing side it handles EPC bill types —
Sales, RA, MB, Installation and T&C — with GST, TDS and retention computed, and checks
subcontractor bills against measured quantity and the agreed rate master before they
are certified. Plus DPR and site reporting, inventory, AR/AP and cash flow, HRMS,
attendance and payroll.

A Node.js backend (`server/`) and a web client (`client/`), deployable to a VPS via PM2
or to Render.

---

## Features

- **Procurement** — site indent against a BOQ line → RFQ rate comparison → value-based approval → PO → receiving → debit note (see `INDENT-TO-DISPATCH.md`)
- **Billing** — EPC bill types (Sales, RA, MB, Installation, T&C) with GST, TDS and retention; subcontractor bills checked against measured quantity and the rate master (see `SALES-BILLING-MODULE.md`)
- **ERP automation** — automated processes with a full audit trail (see `ERP-AUTOMATION-AUDIT.md`)
- **Team engagement** — scorecards and rewards for site and office staff (see `GAMIFICATION.md`)
- **Health monitoring** — service health checks via `health-check.sh`
- **Production-ready deployment** — PM2 process management, VPS deploy script, log rotation, and Render support

---

## Tech Stack

| Layer      | Technology                          |
| ---------- | ----------------------------------- |
| Frontend   | `client/`                           |
| Backend    | Node.js (`server/`)                 |
| Process    | PM2 (`ecosystem.config.js`)         |
| Deployment | VPS (`deploy-vps.sh`) / Render (`render.yaml`) |

---

## Project Structure

```
SEPL/
├── client/                  # Frontend application
├── server/                  # Backend API / server
├── docs/                    # Project documentation
├── backups/                 # Backup files
├── .env.example             # Sample environment variables
├── ecosystem.config.js      # PM2 process configuration
├── deploy-vps.sh            # VPS deployment script
├── health-check.sh          # Service health check
├── setup-log-rotation.sh    # Log rotation setup
├── render.yaml              # Render deployment config
├── package.json
├── ERP-AUTOMATION-AUDIT.md
├── SALES-BILLING-MODULE.md
└── GAMIFICATION.md
```

---

## Getting Started

### Prerequisites

- Node.js (LTS) & npm
- PM2 (`npm install -g pm2`) for production

### Installation

```bash
# Clone the repository
git clone https://github.com/sotyn-dev/SEPL.git
cd SEPL

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# then edit .env with your values
```

### Running Locally

```bash
# Start the server
npm start

# (in a separate terminal) start the client
cd client
npm install
npm start
```

---

## Deployment

### VPS (with PM2)

```bash
bash deploy-vps.sh
pm2 start ecosystem.config.js
pm2 save
```

Set up log rotation:

```bash
bash setup-log-rotation.sh
```

### Render

Deployment is configured via `render.yaml`. Connect the repo in your Render dashboard and deploy.

---

## Health Check

```bash
bash health-check.sh
```

---

## Documentation

Detailed module docs live in the repo root and `docs/`:

- [ERP Automation Audit](./ERP-AUTOMATION-AUDIT.md)
- [Sales & Billing Module](./SALES-BILLING-MODULE.md)
- [Gamification](./GAMIFICATION.md)

---

## License

Proprietary — © Secured Engineers Pvt. Ltd. All rights reserved.
