# EmpCloud

A full-stack HR Management System built as a monorepo. It handles everything from employee onboarding to attendance, leave, documents, payroll integration, and AI-assisted HR queries — all under one roof.

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

---

## What It Is

EmpCloud is the core of an HR ecosystem. It acts as three things at once:

- **Identity server** — OAuth2/OIDC authorization server with RS256 JWT signing, SSO across all connected modules, and role-based access control
- **Core HRMS** — Employee profiles, attendance, leave, documents, announcements, policies, org chart, helpdesk, surveys, assets, wellness, forum, events, and more — all built in
- **Module gateway** — Connects external modules (Payroll, Recruit, Performance, Rewards, Exit, LMS, Monitor, Projects, Field, Biometrics) via OAuth2 and SSO token exchange

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite 6, TypeScript, Tailwind CSS, Radix UI |
| Backend | Node.js 20, Express 5, TypeScript |
| Database | MySQL 8 via Knex.js |
| Cache | Redis 7 |
| Auth | OAuth2/OIDC, RS256 JWT, PKCE, bcryptjs |
| Queue | BullMQ |
| Monorepo | pnpm workspaces |
| Infra | Docker, Docker Compose |
| i18n | 9 languages (react-i18next) |
| Payments | Stripe, Razorpay, PayPal |

---

## Project Structure

```
empcloud/
├── packages/
│   ├── server/          # Express API + OAuth2 server
│   │   └── src/
│   │       ├── api/routes/      # 35+ route files
│   │       ├── services/        # Business logic (50+ services)
│   │       ├── db/migrations/   # 107 database migrations
│   │       └── utils/
│   ├── client/          # React SPA (90+ pages)
│   │   └── src/
│   │       ├── pages/
│   │       ├── components/
│   │       └── api/
│   └── shared/          # Shared types, validators, constants
├── e2e/                 # Playwright E2E test specs
├── docker-compose.yml
└── .env.example
```

---

## Modules

EmpCloud is the core. These are the connected modules:

| Module | Port | Database |
|--------|------|----------|
| EMP Cloud (core) | 3000 | empcloud |
| EMP Payroll | 4000 | emp_payroll |
| EMP Billing (internal) | 4001 | emp_billing |
| EMP Performance | 4300 | emp_performance |
| EMP Exit | 4400 | emp_exit |
| EMP Recruit | 4500 | emp_recruit |
| EMP Rewards | 4600 | emp_rewards |
| EMP LMS | 6021 | emp_lms |
| EMP Field | 4800 | emp_field |
| EMP Monitor | 5000 | emp_monitor |
| EMP Projects | 9000 | MongoDB |

---

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker Desktop

### 1. Clone and install

```bash
git clone https://github.com/Atharv-396/Globle-Employer-of-Record-EOR-.git
cd EmpCloud-main
pnpm install
```

### 2. Set up environment

```bash
cp .env.example .env
```

The defaults in `.env.example` work for local development with Docker. No changes needed to get started.

### 3. Start Docker services

```bash
docker compose up -d
```

This starts MySQL (port 3306), Redis (port 6379), and Mailpit for email testing (port 8025).

### 4. Generate RSA keys

JWT signing uses RS256 asymmetric keys. Generate them once:

```bash
pnpm generate-keys
```

Keys are written to `packages/server/keys/` and are gitignored.

### 5. Run database migrations

```bash
pnpm migrate
```

Applies all 107 migrations and seeds default data.

### 6. Start the dev servers

```bash
# Terminal 1 — backend
cd packages/server && pnpm dev

# Terminal 2 — frontend
cd packages/client && pnpm dev
```

Or run both from the root with:

```bash
pnpm dev
```

### 7. Open the app

| URL | What it is |
|-----|------------|
| http://localhost:5173 | Frontend |
| http://localhost:3000 | Backend API |
| http://localhost:3000/health | Health check |
| http://localhost:8025 | Mailpit (email preview) |
| http://localhost:8080 | phpMyAdmin (optional, see below) |

---

## Default Accounts

There are no pre-seeded users. Register a new organization at http://localhost:5173/register — this creates an `org_admin` account for your org.

To create a `super_admin` (platform-level), it must be inserted directly into the database. See the roles section below.

---

## Roles

Five roles, in order of access level:

| Role | Level | What they can do |
|------|-------|-----------------|
| `super_admin` | 100 | Full platform access across all organizations |
| `org_admin` | 80 | Full access within their organization |
| `hr_admin` | 60 | HR operations — leave, attendance, documents, policies |
| `manager` | 20 | Approve leave/regularizations for direct reports |
| `employee` | 0 | Self-service only |

---

## Database Access

MySQL runs on `localhost:3306`. Connect with:

- **Username:** `root`
- **Password:** `secret`
- **Database:** `empcloud`

### phpMyAdmin (browser-based GUI)

```bash
docker run -d --name empcloud-phpmyadmin \
  --network empcloud-main_default \
  -e PMA_HOST=empcloud-mysql \
  -p 8080:80 \
  phpmyadmin:latest
```

Then open http://localhost:8080 and log in with `root` / `secret`.

### MySQL CLI

```bash
docker exec -it empcloud-mysql mysql -uroot -psecret empcloud
```

---

## Core Features

- **Authentication & SSO** — OAuth2/OIDC, Authorization Code + PKCE, token introspection, refresh token rotation
- **Employee Management** — Profiles, directory, org chart, probation tracking, bulk CSV import
- **Attendance** — Shifts, geo-fencing, check-in/out, regularizations, reports
- **Leave** — Custom leave types, accrual policies, multi-level approvals, calendar view, comp-off
- **Documents** — Categories, upload, verification workflow, expiry alerts
- **Announcements & Policies** — Targeting by role/department, acknowledgment tracking
- **Helpdesk** — Ticket management, knowledge base, SLA tracking
- **Surveys** — Pulse surveys, eNPS, engagement surveys
- **Assets** — Asset registry, assignment tracking, history
- **Wellness** — Daily check-ins, mood tracking, wellness programs
- **Forum** — Discussion categories, posts, replies, likes
- **Events** — Company events, RSVP management
- **Biometrics** — Face enrollment, QR-based attendance, device management
- **Whistleblowing** — Anonymous report submission and tracking
- **Custom Fields** — Add custom fields to any entity type
- **AI Assistant** — Natural language HR queries across modules
- **Billing** — Stripe, Razorpay, PayPal payment processing for subscriptions
- **Audit Trail** — Full audit log for all actions
- **Multi-language** — 9 languages supported

---

## Environment Variables

Key variables in `.env`:

```env
# Server
NODE_ENV=development
PORT=3000
BASE_URL=http://localhost:3000

# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=secret
DB_NAME=empcloud
DB_AUTO_MIGRATE=true

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# RSA Keys (generated by pnpm generate-keys)
RSA_PRIVATE_KEY_PATH=./keys/private.pem
RSA_PUBLIC_KEY_PATH=./keys/public.pem

# CORS — add your frontend origin
ALLOWED_ORIGINS=http://localhost:5173

# Email (Mailpit for local dev — no config needed)
SMTP_HOST=localhost
SMTP_PORT=1025

# AI Assistant (optional)
OPENAI_API_KEY=
ASSISTANT_MODEL=gpt-4o
```

Full list of variables with descriptions is in `.env.example`.

---

## API Documentation

Swagger UI is available at `http://localhost:3000/api/docs` when the server is running.

---

## License

[GPL-3.0](LICENSE)
