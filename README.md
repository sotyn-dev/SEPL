# SEPL

A full-stack ERP & business automation platform by **Secured Engineers Pvt. Ltd.**

The application combines a client-facing frontend and a Node.js backend to manage sales, billing, ERP automation, and team engagement (gamification) — deployable to a VPS (PM2) or Render.

---

## Features

- **Sales & Billing Module** — invoicing, billing workflows, and sales tracking (see `SALES-BILLING-MODULE.md`)
- **ERP Automation** — automated ERP processes with an audit trail (see `ERP-AUTOMATION-AUDIT.md`)
- **Gamification** — engagement and rewards system (see `GAMIFICATION.md`)
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
