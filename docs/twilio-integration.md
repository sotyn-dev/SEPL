# Twilio WhatsApp Integration — Lead-to-Dispatch Funnel (L2D IndiaMart)

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Setup & Credentials](#setup--credentials)
4. [WhatsApp Templates](#whatsapp-templates)
5. [API Reference](#api-reference)
6. [Webhook Configuration](#webhook-configuration)
7. [Environment Variables](#environment-variables)
8. [Operational Workflow](#operational-workflow)
9. [Troubleshooting](#troubleshooting)
10. [Testing & Validation](#testing--validation)

---

## Overview

The Lead-to-Dispatch Funnel (L2D) uses **Twilio WhatsApp Business API** to automate customer engagement across 6 phases:

- **Qualify & Greet** — AI pre-qualification + coordinator review
- **Confirm Order** — Send welcome template (priced/unpriced) + capture confirmation
- **Get Paid** — Bank details template + payment confirmation
- **Procure & Dispatch** — PO drafting (AI-assisted) + dispatch confirmation
- **Billing** — Purchase and sales bill entry
- **Close & Nurture** — Delivery confirmation + keep-in-touch follow-ups (30+ day repeat sales cadence)

All customer-facing messages use **Meta-approved WhatsApp templates** (Twilio "Content" in API terms), never raw text, to comply with WhatsApp Business policies for cold outreach.

---

## Architecture

### Message Flow Diagram

```
Lead enters → AI scopes + sales coordinator approves (WELCOME_SENT)
  ↓
Customer taps "Confirm Order" button on welcome → triggers ORDER_CONFIRMED
  ↓
System auto-sends bank template → BANK_SENT
  ↓
Customer confirms payment → PAYMENT_CONFIRMED
  ↓
Coordinator drafts vendor PO → PO_DRAFTED
  ↓
Dispatch confirmed → DISPATCH_CONFIRMED
  ↓
Billing + receipt → PURCHASE_BILL → SALES_BILL → RECEIPT → KEEP_IN_TOUCH
  ↓
30-day follow-up cycle begins (manual nudges from Keep in Touch screen)
```

### Components

| Component | Purpose | Owned By |
|-----------|---------|----------|
| **WhatsApp Templates** | Meta-approved message templates with variable substitution & quick-reply buttons | Meta / Twilio |
| **Inbound Webhook** | Receives customer taps (quick-reply) and free-text replies | Twilio → Our `/api/lead-funnel/whatsapp/webhook` |
| **Message Log** | All inbound/outbound messages stored in `l2d_messages` table | Our Backend |
| **Template Versioning** | Templates are updated in the database when new versions are approved in Meta | Admin Settings |
| **Opt-Out Handling** | Leads marked `opted_out=1` skip all sends automatically | Our Backend |

---

## Setup & Credentials

### Step 1: Twilio Account Setup

1. **Create a Twilio account** at [twilio.com](https://twilio.com)
2. **Navigate to Messaging → Try it out → WhatsApp**
3. **Create a WhatsApp Sandbox** (for testing) or request a **Production WhatsApp Business Account**
4. **Connect your WhatsApp Business Account** to Twilio (requires Meta Business Platform setup)
5. **Note your Account SID and Auth Token** from the Twilio dashboard

### Step 2: WhatsApp Business Account Setup

1. **Create a Meta Business Account** at [business.facebook.com](https://business.facebook.com)
2. **Create a WhatsApp Business Account** and verify ownership of your business phone number
3. **Request Production Status** (leave sandbox if testing)
4. **Display Name** should be your business name (will show on all customer messages)
5. **Request Templates** approval from Meta (see templates section below)

### Step 3: Twilio WhatsApp Sender Configuration

1. From Twilio Console → Messaging → Settings → WhatsApp Sandbox
2. Copy your **Twilio WhatsApp From number** (starts with `whatsapp:+1...`)
3. Add your personal WhatsApp number to the sandbox for testing
4. Verify you receive the sandbox welcome message on WhatsApp

---

## WhatsApp Templates

### Template Approval Requirements

- **Content**: Must be static or use placeholder variables (`{{1}}`, `{{2}}`, etc.)
- **Quick-Reply Buttons**: Up to 3 buttons per template; used for funnel stage transitions
- **Call-to-Action Buttons**: URL buttons (not used in L2D, but available)
- **Image/Video**: Optional headers with media (not used initially)
- **Approval Time**: 1–48 hours after submission to Meta

### Required Templates for L2D

#### 1. **Welcome (Priced Variant)**

**Template Name:** `welcome_priced` (register in Twilio as `welcome_priced`)  
**Meta Category:** Marketing (transactional is not available for cold messages; use Marketing)  
**Approval Status:** Must be approved before going to production

**Template Body:**

```
Hello {{1}},

Thank you for your enquiry about {{2}}.

📦 *Product:* {{2}}
💰 *Price:* {{3}}

We're ready to help you. Tap *Confirm Order* to proceed, or let us know if you have any questions.

Best regards,
IndiaMart Team
```

**Quick-Reply Buttons:**
1. ✅ Confirm Order → `confirm_order`
2. 📞 Expect a Call → `expect_call`

**Variables:**
- `{{1}}` = Customer name
- `{{2}}` = Product name
- `{{3}}` = Formatted price (e.g., `₹12,500`)

---

#### 2. **Welcome (Unpriced Variant)**

**Template Name:** `welcome_unpriced`  
**Meta Category:** Marketing  
**Approval Status:** Must be approved before going to production

**Template Body:**

```
Hello {{1}},

Thank you for your enquiry about {{2}}.

We're currently checking availability and market rates for your order.

📧 *Next step:* A sales coordinator will call or message you within 2 hours with a custom quote.

Best regards,
IndiaMart Team
```

**Quick-Reply Buttons:**
1. 📞 Expect a Call → `expect_call`
2. ❓ Ask a Question → (free text reply)

**Variables:**
- `{{1}}` = Customer name
- `{{2}}` = Product name / enquiry

---

#### 3. **Bank Details**

**Template Name:** `bank`  
**Meta Category:** Transactional  
**Approval Status:** Must be approved before going to production

**Template Body:**

```
Hi {{1}},

Thank you for confirming your order! 🎉

Please complete payment using the details below:

🏦 *Bank Name:* Secured Engineers Bank Ltd
💳 *Account:* 9876543210
🔖 *IFSC:* SEBANK001
📱 *UPI:* securedengg@okhdfcbank

💬 *Tip:* Once you send payment, reply with your transaction reference — we'll confirm immediately.

Thank you,
IndiaMart Team
```

**Quick-Reply Buttons:**
1. ✅ Payment Done → `payment_confirmed`
2. ❓ Ask about Payment → (free text reply)

**Variables:**
- `{{1}}` = Customer name

---

#### 4. **Follow-Up (Keep in Touch)**

**Template Name:** `followup`  
**Meta Category:** Marketing  
**Approval Status:** Must be approved before going to production

**Template Body:**

```
Hi {{1}},

Hope you're enjoying your recent order! 😊

We have some *new arrivals* that might interest you:

📦 {{2}}

Would you like to place a repeat order or explore other products? Tap below or reply with your enquiry.

Best regards,
IndiaMart Team
```

**Quick-Reply Buttons:**
1. 🛒 Place Order → (leads to sales coordinator)
2. 📋 View Catalog → (free text reply)

**Variables:**
- `{{1}}` = Customer name
- `{{2}}` = New product / offer

---

#### 5. **Order Confirmation (Optional — Currently Using Bank Template)**

**Template Name:** `order_confirmed` (optional for future use)  
**Meta Category:** Transactional

**Template Body:**

```
Hi {{1}},

Your order has been confirmed! ✅

📦 *Order Details:*
• Product: {{2}}
• Quantity: {{3}}
• Total: {{4}}

We'll dispatch within 2–3 business days. You'll receive a tracking update soon.

Thank you,
IndiaMart Team
```

**Variables:**
- `{{1}}` = Customer name
- `{{2}}` = Product name
- `{{3}}` = Quantity
- `{{4}}` = Total amount

---

### Template Registration in L2D Admin

1. **Create templates in Meta** → Get **Template SID** from Twilio
2. **Admin Dashboard** → Settings → Funnel Configuration
3. **Register Template SIDs:**
   - `welcome_priced_template_sid` → Priced welcome SID
   - `welcome_unpriced_template_sid` → Unpriced welcome SID
   - `bank_template_sid` → Bank details SID
   - `followup_template_sid` → Follow-up SID
4. **Save Settings** → Templates are now live for all sends

---

## API Reference

### 1. Inbound Webhook (Twilio → Our Backend)

**Endpoint:** `POST /api/lead-funnel/whatsapp/webhook`

**No Authentication Required** — Twilio webhooks cannot send JWT tokens

**Request Body (form-encoded):**
```
From: whatsapp:+919876543210
WaId: 919876543210
ButtonText: Confirm Order
ButtonPayload: confirm_order
Body: (free-text reply if no button tapped)
```

**Response:**
```xml
<Response></Response>
```

**Behavior:**
- Validates phone number → matches to lead
- Parses button text (quick-reply) or free-text
- Records in `l2d_messages`
- Advances stage if action is recognized
- Auto-sends next template (e.g., bank template when order confirmed)

**Stage Transitions Triggered:**
- `confirm_order` button → Lead moves to `ORDER_CONFIRMED`, bank template sent
- `expect_call` button → Lead moves to `CALL_REQUESTED`
- Free-text reply (WELCOME_SENT stage) → Lead moves to `INTERESTED`

---

### 2. Send Template (Our Backend → Twilio)

**Module:** `server/lib/whatsappSend.js`

**Function:** `sendTemplate(options)`

**Parameters:**
```javascript
{
  lead: { id, sender_mobile, sender_name, opted_out },
  templateSid: "HX...", // Twilio template SID
  variables: { 1: "Ravi", 2: "Ink Cartridge", 3: "₹2,500" },
  templateLabel: "welcome_priced" // optional, for logging
}
```

**Returns:**
```javascript
{
  ok: true,
  sid: "SM..." // Twilio message SID
}
// or
{
  ok: false,
  error: "opted_out" | "no_number" | "no_template" | "twilio_unconfigured" | "<error_msg>"
}
```

**Usage in Routes:**
```javascript
const { sendTemplate } = require('../lib/whatsappSend');

const sent = await sendTemplate({
  lead,
  templateSid: getFunnelSetting('welcome_priced_template_sid'),
  templateLabel: 'welcome_priced',
  variables: { 1: lead.sender_name, 2: product, 3: fmtMoney(price) }
});

if (sent.ok) {
  recordStage(db, lead.id, 'WELCOME_SENT', req, `welcome sent: ${sent.sid}`);
} else {
  console.error('Send failed:', sent.error);
}
```

---

### 3. Lead Funnel API

**Endpoint:** `PATCH /api/lead-funnel/leads/:id/advance`

**Body:**
```json
{
  "to": "ORDER_CONFIRMED",
  "send": "welcome",
  "quoted_price": 12500,
  "matched_item_name": "Dye Sublimation Ink",
  "note": "Customer called with order confirmation"
}
```

**Send Options:**
- `"welcome"` — Sends welcome template (priced if `quoted_price > 0`, else unpriced)
- `"bank"` — Sends bank details template
- `null` — No template sent, just stage change

**Response:**
```json
{
  "message": "Lead advanced",
  "stage": "ORDER_CONFIRMED"
}
```

---

## Webhook Configuration

### Step 1: Configure Twilio Webhook URL

1. **Twilio Console** → Messaging → Settings → WhatsApp Sandbox
2. **Scroll to "Webhook Configuration"**
3. **When a message comes in:** `https://yourdomain.com/api/lead-funnel/whatsapp/webhook`
4. **Method:** POST (form-encoded)
5. **Click Save**

### Step 2: Configure Twilio Webhook in Production

For production:
1. Update WhatsApp Business Account settings (not sandbox)
2. **Phone Number** → Settings → Webhook
3. **Webhook URL:** `https://yourdomain.com/api/lead-funnel/whatsapp/webhook`
4. Verify Twilio can reach your endpoint (test with `curl` if needed)

### Step 3: Verify Webhook Signature (Security)

*Currently skipped for simplicity; add for production:*

Twilio sends an `X-Twilio-Signature` header. Verify it:

```javascript
// server/middleware/twilioSignatureVerify.js
const twilio = require('twilio');

function twilioSignatureVerify(req, res, next) {
  const signature = req.get('X-Twilio-Signature');
  const url = `https://${req.get('host')}${req.originalUrl}`;
  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );
  if (!isValid) return res.status(403).json({ error: 'Invalid Twilio signature' });
  next();
}

module.exports = twilioSignatureVerify;
```

**Add to route:**
```javascript
router.post('/whatsapp/webhook', twilioSignatureVerify, express.urlencoded({ extended: false }), async (req, res) => {
  // ... handle webhook
});
```

---

## Environment Variables

Create `.env` (git-ignored) or set in deployment:

```bash
# Twilio Credentials
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_WHATSAPP_FROM=+14155552671  # Twilio sandbox/production WhatsApp number

# L2D Funnel — Template SIDs (registered in admin UI or set here)
L2D_WELCOME_PRICED_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
L2D_WELCOME_UNPRICED_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
L2D_BANK_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
L2D_FOLLOWUP_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Webhook (if needed for signature verification)
TWILIO_WEBHOOK_URL=https://yourdomain.com/api/lead-funnel/whatsapp/webhook
```

**Load in backend:**

```javascript
// server/config/twilio.js
module.exports = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  whatsappFrom: process.env.TWILIO_WHATSAPP_FROM,
  templates: {
    welcomePriced: process.env.L2D_WELCOME_PRICED_TEMPLATE_SID,
    welcomeUnpriced: process.env.L2D_WELCOME_UNPRICED_TEMPLATE_SID,
    bank: process.env.L2D_BANK_TEMPLATE_SID,
    followup: process.env.L2D_FOLLOWUP_TEMPLATE_SID,
  }
};
```

---

## Operational Workflow

### Scenario A: Customer Inquires About a Product (Priced)

**Flow:**
1. **Lead enters** (e.g., from IndiaMart poll) → `LEAD_ENTERED`
2. **Coordinator reviews** → Sets `quoted_price=12500`, matched item
3. **Coordinator clicks "Approve & Send Welcome"** → API call to `/advance`
   - Request: `{ to: "WELCOME_SENT", send: "welcome", quoted_price: 12500 }`
   - Backend sends `welcome_priced` template with name, product, price
   - Lead → `WELCOME_SENT`
4. **Customer reads message** on WhatsApp
5. **Customer taps "Confirm Order"** → Twilio webhook fires
   - Backend receives button tap
   - Lead → `ORDER_CONFIRMED`
   - Bank template auto-sent → Lead → `BANK_SENT`
6. **Customer transfers payment** → Coordinator enters payment ref
   - Lead → `PAYMENT_CONFIRMED`
7. **Continue through procure, billing, close phases...**

---

### Scenario B: Customer Inquires About a Product (Unpriced)

**Flow:**
1. **Lead enters** → `LEAD_ENTERED`
2. **Coordinator reviews** → No price available yet
3. **Coordinator clicks "Approve & Send Welcome"** (no price field)
   - API call: `{ to: "WELCOME_SENT", send: "welcome" }`
   - Backend sends `welcome_unpriced` template
   - Message: "Checking availability... will call in 2 hours"
4. **Coordinator calls customer** (outside WhatsApp)
5. **Price agreed** → Coordinator re-enters welcome (price upgrade)
   - Sets `quoted_price=12500`
   - Taps "Resend Welcome with Price"
   - Backend sends `welcome_priced` (one-time allowed re-send)
6. **Customer taps "Confirm Order"** → Same as Scenario A

---

### Scenario C: Follow-Up (Keep in Touch)

**Flow:**
1. **Deal closes** → Lead → `KEEP_IN_TOUCH`
   - Auto-creates one follow-up 30 days out
2. **Daily cron job** checks due follow-ups
   - Sends `followup` template if opt-out not set
   - Marks `followup.sent=1`
3. **Coordinator can manually nudge** any time:
   - Clicks "Send Follow-Up" on Keep in Touch screen
   - API call: `POST /api/lead-funnel/leads/:id/followup-now`
   - Backend sends template with name + custom note
4. **Customer taps "Place Order"** or replies with enquiry
   - Coordinator assigns to sales coordinator for repeat sale

---

## Troubleshooting

### Template Not Sending

**Error:** `"status": "failed", "error": "template SID not configured"`

**Cause:** Template SID not set in database or environment.

**Fix:**
1. Check admin settings: `/api/lead-funnel/settings` (admin only)
2. Verify template exists in Twilio console
3. Copy exact SID (starts with `HX`)
4. Update database or environment variable
5. Restart backend

---

### No Response from Customer

**Possible Causes:**
1. **Message not delivered** — Check `l2d_messages` table status
2. **Customer opted out** — Check `l2d_leads.opted_out`
3. **Wrong phone number** — Check `sender_mobile` formatting
4. **Twilio account issue** — Check Twilio console for errors

**Diagnostics:**
```sql
SELECT * FROM l2d_messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 10;
```

Look for:
- `status = 'failed'` → error details in `error` column
- `status = 'sent' | 'delivered' | 'read'` → message reached customer
- `direction = 'in'` → customer replied

---

### Webhook Not Triggering

**Cause:** Twilio cannot reach your webhook URL.

**Fix:**
1. **Check URL in Twilio Console** → Messaging → Phone Number → Webhooks
2. **Test with Twilio CLI:**
   ```bash
   curl -X POST https://yourdomain.com/api/lead-funnel/whatsapp/webhook \
     -d "From=whatsapp:+919876543210&Body=test&MessageSid=SM123"
   ```
3. **Check backend logs** for errors
4. **Verify SSL certificate** if using HTTPS (required for production)
5. **Check firewall** — allow Twilio IPs

---

### Wrong Lead Matched on Inbound

**Issue:** Reply matches an old/closed lead instead of active one.

**Why:** Phone number normalization or multiple leads with similar numbers.

**Fix:** Logic in webhook prioritizes:
1. Active leads (stage not in `KEEP_IN_TOUCH` or `REJECTED`)
2. Most recent by creation time
3. Falls back to newest overall if none active

**Override if needed:**
```sql
UPDATE l2d_leads SET sender_mobile = '+919876543210' WHERE id = ?;
```

---

## Testing & Validation

### Local Testing (Sandbox)

1. **Add your phone to Twilio Sandbox:**
   - Twilio Console → Messaging → Try it out → WhatsApp Sandbox
   - Copy the join code (e.g., `join apple-monkey`)
   - Send to Twilio WhatsApp number

2. **Send test message via API:**
   ```bash
   curl -X POST http://localhost:5000/api/lead-funnel/leads/1/advance \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <your-jwt-token>" \
     -d '{
       "to": "WELCOME_SENT",
       "send": "welcome",
       "quoted_price": 12500,
       "matched_item_name": "Test Product"
     }'
   ```

3. **Check message log:**
   ```sql
   SELECT * FROM l2d_messages WHERE lead_id = 1 ORDER BY created_at DESC;
   ```

4. **Simulate customer reply in Twilio:**
   - From WhatsApp, reply to sandbox message
   - Backend webhook handler processes the reply
   - Check database for stage change

---

### Production Validation Checklist

- [ ] All 4 templates approved by Meta
- [ ] Template SIDs registered in database
- [ ] Webhook URL configured in Twilio
- [ ] Webhook signature verification enabled
- [ ] Twilio signature validation added to middleware
- [ ] Error logging to Sentry configured
- [ ] Rate limiting on webhook endpoint (prevent abuse)
- [ ] Load test: send 100 templates, verify all reach Twilio
- [ ] Monitor `l2d_messages` table for failures
- [ ] Set up Twilio alerts for send failures > 5%
- [ ] Document SLAs: 99.5% delivery for approved templates

---

### Monitoring & Alerts

**Queries for monitoring:**

```sql
-- Template send success rate (last 24 hours)
SELECT
  template,
  COUNT(*) as sends,
  SUM(CASE WHEN status IN ('sent', 'delivered', 'read') THEN 1 ELSE 0 END) as success,
  ROUND(100.0 * SUM(CASE WHEN status IN ('sent', 'delivered', 'read') THEN 1 ELSE 0 END) / COUNT(*), 2) as success_pct
FROM l2d_messages
WHERE direction = 'out' AND created_at > datetime('now', '-1 day')
GROUP BY template;

-- Failed sends (requires investigation)
SELECT id, lead_id, template, error, created_at
FROM l2d_messages
WHERE direction = 'out' AND status = 'failed'
ORDER BY created_at DESC
LIMIT 20;

-- Inbound message volume (by source)
SELECT
  DATE(created_at) as date,
  COUNT(*) as inbound_msgs,
  COUNT(DISTINCT lead_id) as unique_leads
FROM l2d_messages
WHERE direction = 'in'
GROUP BY DATE(created_at)
ORDER BY date DESC
LIMIT 30;
```

---

## Reference

### Twilio Documentation
- [WhatsApp API Overview](https://www.twilio.com/docs/whatsapp)
- [Template Management](https://www.twilio.com/docs/whatsapp/content-templates)
- [Webhook Setup](https://www.twilio.com/docs/whatsapp/incoming-messages)
- [Twilio SDKs](https://www.twilio.com/docs/libraries)

### Meta WhatsApp Business
- [WhatsApp Business API](https://developers.facebook.com/docs/whatsapp)
- [Message Templates](https://developers.facebook.com/docs/whatsapp/message-templates)
- [Approval Guidelines](https://www.facebook.com/business/help/1613159819481876)

### Code Files
- Template sending: `server/lib/whatsappSend.js`
- Phone normalization: `server/utils/whatsapp.js`
- Webhook handler: `server/routes/leadToDispatchFunnel.js` (line 64)
- Database schema: `server/db/leadToDispatchFunnelDb.js`

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-06-19 | Initial documentation + 4 required templates (welcome_priced, welcome_unpriced, bank, followup) |




I already have the full codebase context from our earlier session. Let me write a concise plan capturing the webhook flow explanation.

Here's the brief explanation:

---

## How the Twilio Webhook Works in L2D

### The single endpoint

```
POST /api/lead-funnel/whatsapp/webhook   ← no auth (Twilio can't send JWT)
```

Defined at `server/routes/leadToDispatchFunnel.js:64`, mounted **before** `authMiddleware`.

---

### Flow in 5 steps

```
1. Customer taps "Confirm Order" button (or types a reply) on WhatsApp
       ↓
2. Twilio POSTs to your webhook:
   From=whatsapp:+919876543210
   ButtonPayload=confirm_order
       ↓
3. Backend replies HTTP 200 IMMEDIATELY  ← critical: Twilio retries if no 200 in ~5s
   (real work happens after the response)
       ↓
4. parseInboundButton() extracts action → normalisePhone() matches last 10 digits
   to a lead in the DB (prefers active over closed)
       ↓
5. Branch on action:
   "confirm_order" → ORDER_CONFIRMED → auto-sends bank template → BANK_SENT
   "expect_call"   → CALL_REQUESTED
   free text       → INTERESTED (if lead was in WELCOME_SENT)
```

### Why HTTP 200 first?

Twilio marks the webhook as failed if it doesn't get a 200 within ~5 seconds, and **retries** — which would trigger a duplicate bank template send. So the webhook returns the empty TwiML `<Response></Response>` first, then does the DB writes and template send in a `try/catch`. Any error is logged, never bubbles up to Twilio.

### Two key safety guards

- **Inbound always logged** — even if phone doesn't match any lead, the message is saved to `l2d_messages` for audit
- **Idempotent bank send** — `lastGoodSend()` check in `whatsappSend.js` prevents a second bank template if the customer taps the button twice

The explanation above covers everything — this was a purely informational question, so no code changes or implementation is needed. The webhook is already fully implemented in `server/routes/leadToDispatchFunnel.js:64` and `server/lib/whatsappSend.js`. The docs I created earlier in `docs/twilio-integration.md` also capture the full webhook flow with payload examples.

Here's the complete guide — two parts: **Twilio Console setup** and **localhost dev testing**.

---

## Part 1: Twilio Console Configuration

### Step 1: Get Sandbox Access (Dev/Testing)

1. Go to [console.twilio.com](https://console.twilio.com)
2. Left sidebar → **Messaging** → **Try it out** → **Send a WhatsApp message**
3. You'll see a sandbox number like `+14155238886` and a join code like `join silver-fox`
4. **From your personal WhatsApp**, send that join code to the sandbox number
5. You'll get a confirmation: *"You are now connected to the sandbox"*

### Step 2: Set Webhook URL in Sandbox

1. In Twilio Console → **Messaging** → **Settings** → **WhatsApp Sandbox Settings**
2. Under **"When a message comes in"**:
   ```
   URL:    https://<your-ngrok-url>/api/lead-funnel/whatsapp/webhook
   Method: HTTP POST
   ```
3. Click **Save**

---

## Part 2: Localhost Dev Testing (via ngrok)

Twilio needs a **public HTTPS URL** to reach your local machine. ngrok tunnels it.

### Step 1: Install & Run ngrok

```bash
# Install ngrok (one-time)
npm install -g ngrok
# or download from https://ngrok.com/download

# Start your backend first
npm run dev   # starts on port 5000

# In a NEW terminal — expose port 5000
ngrok http 5000
```

ngrok gives you:
```
Forwarding   https://abc123.ngrok-free.app → http://localhost:5000
```

### Step 2: Paste ngrok URL into Twilio Console

Back in **WhatsApp Sandbox Settings**:
```
https://abc123.ngrok-free.app/api/lead-funnel/whatsapp/webhook
```

Save. Now Twilio → your local Express server.

> **Note:** ngrok URL changes every restart (free tier). Re-paste it each dev session.

---

## Part 3: End-to-End Test Flow

### 3a — Test sending a template (coordinator action)

First create a test lead and grab a JWT:

```bash
# 1. Get a JWT (login)
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"yourpassword"}'

# 2. Advance lead to WELCOME_SENT (replace TOKEN and LEAD_ID)
curl -X PATCH http://localhost:5000/api/lead-funnel/leads/LEAD_ID/advance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{
    "to": "WELCOME_SENT",
    "send": "welcome",
    "quoted_price": 12500,
    "matched_item_name": "Test Ink"
  }'
```

Your WhatsApp (joined sandbox) should receive the welcome template within 5 seconds.

---

### 3b — Test inbound button tap (customer action)

From **your WhatsApp**, tap the **"Confirm Order"** quick-reply button.

**Watch the backend terminal** — you'll see the webhook fire:
```
[lead-funnel] webhook received: from=919876... action=confirm_order
```

Check DB to confirm stage transitions:
```sql
SELECT stage FROM l2d_leads WHERE id = LEAD_ID;
-- should be: BANK_SENT

SELECT * FROM l2d_messages WHERE lead_id = LEAD_ID ORDER BY created_at DESC LIMIT 5;
-- should show: inbound 'Confirm Order', outbound 'bank' template
```

---

### 3c — Simulate webhook manually (no phone needed)

You can fake a Twilio POST directly to your local server:

```bash
# Simulate customer tapping "Confirm Order"
curl -X POST http://localhost:5000/api/lead-funnel/whatsapp/webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=whatsapp%3A%2B919876543210&WaId=919876543210&ButtonText=Confirm+Order&ButtonPayload=confirm_order&MessageSid=SMtest123"

# Simulate "Expect a Call"
curl -X POST http://localhost:5000/api/lead-funnel/whatsapp/webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=whatsapp%3A%2B919876543210&WaId=919876543210&ButtonText=Expect+a+Call&ButtonPayload=expect_call&MessageSid=SMtest456"

# Simulate free-text reply
curl -X POST http://localhost:5000/api/lead-funnel/whatsapp/webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=whatsapp%3A%2B919876543210&WaId=919876543210&Body=I+will+transfer+the+amount+today&MessageSid=SMtest789"
```

Expected response for all three: `<Response></Response>` with HTTP 200.

---

## Part 4: Verify Template SIDs Are Set

Before any send will work, register template SIDs in the admin UI or via curl:

```bash
curl -X PUT http://localhost:5000/api/lead-funnel/settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -d '{
    "welcome_priced_template_sid": "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "welcome_unpriced_template_sid": "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "bank_template_sid": "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "followup_template_sid": "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }'
```

You get the `HX...` SIDs from Twilio Console → **Messaging** → **Content Template Builder** after templates are approved.

---

## Quick Checklist

```
[ ] ngrok running on port 5000 → URL copied
[ ] ngrok URL pasted in Twilio Sandbox Settings webhook field
[ ] Your WhatsApp joined the sandbox (sent the join code)
[ ] .env has TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
[ ] Template SIDs saved in settings (at least welcome_priced + bank for the main flow)
[ ] Test lead exists in DB with your WhatsApp number as sender_mobile
[ ] curl /advance → WhatsApp message received ✓
[ ] Tap button → DB stage changed ✓
```