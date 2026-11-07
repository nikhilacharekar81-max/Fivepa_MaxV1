# PayPal Sandbox Setup & 50-Run Verification Guide

This guide explains how to configure, test, and verify the **FivePA / WorkPerHour** PayPal integration across Wallet Top-Ups, Gig Orders, Project Proposals, WorkStream Deposits, and WorkStream Invoices.

---

## 1. Create a PayPal Sandbox REST App & Test Accounts

1. Sign in to the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/).
2. Toggle the top-right environment switch to **Sandbox**.
3. Go to **Testing Tools → Sandbox Accounts**:
   - Confirm you have two Sandbox accounts:
     - **Business (Merchant) Account** (e.g., `sb-merchant@business.example.com`) — receives platform payments.
     - **Personal (Buyer) Account** (e.g., `sb-buyer@personal.example.com`) — used to log into the PayPal checkout popup/redirect and approve payments.
   - Click the three dots (`...`) → **View/Edit Account** on the Personal account to see its Sandbox email and password, or create additional buyer test accounts with varying balances.
4. Go to **Apps & Credentials** (under **Sandbox**):
   - Click **Create App**, name it `FivePA Sandbox`, and associate it with your Sandbox Business account.
   - Copy the **Client ID** (`PAYPAL_CLIENT_ID`) and **Secret** (`PAYPAL_CLIENT_SECRET`).

---

## 2. Expose Your Local Server & Register the PayPal Webhook

PayPal's servers need a public HTTPS URL to deliver signed webhook events (`PAYMENT.CAPTURE.COMPLETED`, etc.) to your instance.

### Local Development (via ngrok or Cloud Tunnel)
1. Start the app on port `3000`:
   ```bash
   npm run dev
   ```
2. Start an HTTPS tunnel pointing to port `3000`:
   ```bash
   ngrok http 3000
   ```
3. Copy your public HTTPS forwarding URL (e.g., `https://abc12345.ngrok-free.app`) and set `APP_URL` in `.env`:
   ```env
   APP_URL="https://abc12345.ngrok-free.app"
   ```

### Register the Webhook in PayPal Developer Dashboard
1. Open your `FivePA Sandbox` app in **Apps & Credentials**.
2. Scroll down to **SandBox Webhooks** and click **Add Webhook**.
3. Enter your **Webhook URL**:
   ```text
   https://<your-domain-or-ngrok>/api/payments/webhook?gateway=paypal
   ```
   *(Note: `/api/webhooks/payment?gateway=paypal` is also mounted as a compatible alias.)*
4. Subscribe to the following **Event types**:
   - `Checkout order approved` (`CHECKOUT.ORDER.APPROVED`)
   - `Payment capture completed` (`PAYMENT.CAPTURE.COMPLETED`)
   - `Payment capture denied` (`PAYMENT.CAPTURE.DENIED`)
   - `Payment capture declined` (`PAYMENT.CAPTURE.DECLINED`)
   - `Payment capture pending` (`PAYMENT.CAPTURE.PENDING`)
   - `Payment capture refunded` (`PAYMENT.CAPTURE.REFUNDED`)
   - `Payment capture reversed` (`PAYMENT.CAPTURE.REVERSED`)
5. Click **Save** and copy the generated **Webhook ID** (e.g., `4JH82910...`).

---

## 3. Configure Environment Variables or Admin Panel

### Option A: `.env` Configuration
```env
APP_URL="https://<your-domain-or-ngrok>"
GATEWAY_ENCRYPTION_KEY="replace-with-32-char-random-secret-key-distinct-from-jwt"
PAYMENT_SIMULATION_ENABLED="false"
PAYPAL_MODE="sandbox"
PAYPAL_CLIENT_ID="your-paypal-sandbox-client-id"
PAYPAL_CLIENT_SECRET="your-paypal-sandbox-client-secret"
PAYPAL_WEBHOOK_ID="your-paypal-sandbox-webhook-id"
```

### Option B: Super Admin Panel (`Admin → Payment Gateways`)
1. Sign in as Super Admin and open **Admin → Payment Gateways**.
2. Under **PayPal**, toggle **Enabled** to ON, set **Environment** to `sandbox`, and enter:
   - **Client ID**
   - **Client Secret**
   - **Webhook ID**
3. Set **Primary Gateway** to `PayPal` and click **Save Changes**.
   - Both `clientSecret` and `webhookId` are encrypted at rest with AES-256-GCM and masked (`••••••••1234`) when reloaded.

---

## 4. Run the Automated Smoke & Webhook Verification Suites

Before running manual browser tests, verify your credentials and webhook state machine from the terminal:

1. **Automated Unit/Integration Webhook & Idempotency Suite (7 scenarios)**:
   ```bash
   npm run test:paypal
   ```
2. **Live PayPal Sandbox API Smoke Script**:
   ```bash
   npm run paypal:smoke
   ```
   This script:
   - Obtains a real OAuth2 bearer token from `https://api-m.sandbox.paypal.com/v1/oauth2/token`
   - Creates a `$10.00 USD` PayPal v2 order (`intent: CAPTURE`) with `reference_id`, `custom_id`, and `invoice_id`
   - Prints the live buyer `approve` URL and verifies local webhook processing.

---

## 5. 50-Run Manual Sandbox Test Matrix (10 Core Scenarios × 5 Repetitions)

| # | Scenario | Action Taken | Expected Result |
|---|----------|--------------|-----------------|
| **1** | **Happy-Path Wallet Top-Up ($25.00)** | Go to `/payments` → **Add Funds** → enter `$25.00` → approve on PayPal Sandbox with personal buyer account. | Redirects to `/checkout/success?session_id=...&token=...`. Captures order via `POST /api/payments/paypal/capture`. Wallet increases by exactly `$25.00`. Ledger records balanced `DEPOSIT` (`1020 -> 2010`). |
| **2** | **Gig Order with $0 Wallet Balance** | With `$0.00` wallet balance, open a `$50.00` Gig and click **Order Now**. | Automatically creates checkout session for `$51.50` (`$50` + `$0.50` 1% buyer fee + `$1.00` small-order fee), redirects to PayPal Sandbox, captures on return, creates the Gig Order, and locks `$51.50` in Escrow (`2010 -> 2020`). |
| **3** | **Project Proposal Acceptance via PayPal** | On a Project page, click **Accept & Hire** on a `$100.00` freelancer proposal when wallet is empty. | Redirects to PayPal Sandbox for `$102.00` (`$100` + `$1` 1% fee + `$1` small-order fee), captures on return, accepts proposal, funds escrow, and shows **Open WorkStream** button. |
| **4** | **WorkStream Proposal / Deposit / Invoice Payment** | Inside `/workstream/:id`, click **Accept & Fund** on a seller's Custom Proposal, Deposit Request, or Invoice. | Redirects to PayPal Sandbox for the exact shortfall, captures on return, marks the offer/invoice `accepted`/`paid`, and updates the WorkStream live. |
| **5** | **Success Page Refresh & Back-Button (5x Reload)** | On `/checkout/success?session_id=...&token=...`, press `F5` / Cmd+R 5 times in a row. | Returns `alreadyProcessed: true` with HTTP 200. Wallet is credited **exactly once**; no duplicate order or ledger entry is created. |
| **6** | **Buyer Cancels on PayPal Approval Screen** | Click **Cancel and return to FivePA** on the PayPal Sandbox login/approval screen. | Redirects to `/checkout/cancel?session_id=...`. Marks session `cancelled`. Wallet balance is unchanged (`$0.00` delta) and no ledger entry is written. |
| **7** | **Webhook Arrives Before Return Page Loads** | Approve payment on PayPal, wait 5 seconds before following redirect (or trigger `PAYMENT.CAPTURE.COMPLETED` first), then load `/checkout/success`. | Webhook credits wallet and marks session `completed`. Subsequent `POST /api/payments/paypal/capture` sees `status === 'completed'`, skips re-capture, and runs any pending order continuation once. |
| **8** | **Duplicate Webhook Replay from PayPal Dashboard** | In PayPal Developer Dashboard → **Webhook Events**, click **Resend** on a delivered `PAYMENT.CAPTURE.COMPLETED` event 3 times. | Server responds `200 OK` (`duplicate: true`) on each replay. `payment_webhook_events` records the event ID once; wallet balance does not change. |
| **9** | **Amount or Currency Tampering Rejection** | Send a webhook where `resource.amount.currency_code` is `EUR` or `value` is `5.00` for a `$25.00 USD` session. | Server logs the mismatch, returns HTTP `400`, leaves checkout session uncredited, and writes zero ledger entries. |
| **10** | **Declined / Refunded Capture Handling** | Trigger `PAYMENT.CAPTURE.DENIED` (via PayPal Negative Testing) or refund a completed capture (`PAYMENT.CAPTURE.REFUNDED`). | `DENIED` marks session `failed` with zero credit. `REFUNDED` marks session `refunded` and reverses the unspent wallet deposit (`2010 -> 1020`) or logs a `GATEWAY_CHARGEBACK_OR_REFUND` alert if already locked in escrow. |
