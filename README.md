# WhatsApp Business Onboarding Bridge (Multi-Tenant)

A **multi-tenant bridge** that connects **any app’s onboarding flow** to **WhatsApp Business**.  
It supports **embedded signup**, **webhooks**, and **step-based onboarding automation** so you can onboard users faster and keep progress synced inside your product.

---

## ✨ What this does

This project acts as the middle layer between your app and WhatsApp Business:

- **Embedded Signup**: Start WhatsApp Business onboarding inside your app experience.
- **Step-Based Onboarding**: Move users through onboarding steps (connect, verify, finish, etc.).
- **Webhook Handling**: Receive WhatsApp events and update onboarding status automatically.
- **Multi-Tenant Ready**: Handle multiple apps/clients (tenants) with isolated data and settings.
- **Status Sync**: Keep your main app updated with onboarding state (pending / verified / completed / failed).
- **Automation Friendly**: Trigger messages/notifications at specific onboarding steps.

---

## 🧱 Tech Stack

- **Next.js**
- **TypeScript + JavaScript**
- API Routes / Server Actions (depending on your implementation)
- Webhooks + event processing

---

## ✅ Features

- Multi-tenant architecture (separate tenants, configs, and onboarding sessions)
- Embedded signup onboarding flow
- Secure webhook endpoint to receive WhatsApp Business events
- Onboarding session tracking + step progression
- Extendable structure to plug into any SaaS / mobile / web app onboarding

---

## 🚀 Getting Started

### 1) Install dependencies
```bash
npm install
# or
yarn
# or
pnpm install
