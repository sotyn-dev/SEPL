# Twilio WhatsApp Setup Checklist — L2D IndiaMart Funnel

**Status:** Pre-Production Ready  
**Created:** 2026-06-19  
**Owner:** Project Engineering Team  

---

## Phase 1: Account & Infrastructure Setup

### Twilio Account

- [ ] Create Twilio account at [twilio.com](https://twilio.com)
- [ ] Verify phone number (for SMS testing if needed)
- [ ] Locate and securely store:
  - [ ] Account SID
  - [ ] Auth Token
  - [ ] Twilio WhatsApp From number (e.g., `+14155552671`)
- [ ] Create `.env` file with credentials:
  ```
  TWILIO_ACCOUNT_SID=ACxxxxxxxx...
  TWILIO_AUTH_TOKEN=your_token_here
  TWILIO_WHATSAPP_FROM=+14155552671
  ```
- [ ] **DO NOT commit `.env`** — add to `.gitignore`

### Meta Business & WhatsApp Account

- [ ] Create Meta Business Account at [business.facebook.com](https://business.facebook.com)
- [ ] Add business information & verify ownership
- [ ] Create WhatsApp Business Account:
  - [ ] Verify business phone number (where messages will come from)
  - [ ] Set display name (e.g., "IndiaMart — Secured Engineers")
  - [ ] Add profile picture
- [ ] Connect WhatsApp Business Account to Twilio:
  - [ ] In Meta Business, add Twilio as an authorized partner
  - [ ] In Twilio Console, verify WhatsApp connection status

### Network & Webhook Infrastructure

- [ ] Ensure backend is accessible at `https://yourdomain.com` (HTTPS required for production)
- [ ] Add Twilio IP addresses to firewall allowlist (if restricted)
- [ ] Test webhook endpoint manually:
  ```bash
  curl -X POST https://yourdomain.com/api/lead-funnel/whatsapp/webhook \
    -d "From=whatsapp:+919876543210&Body=test"
  ```
  Should return HTTP 200 with `<Response></Response>`

---

## Phase 2: Template Creation & Meta Approval

### Priced Welcome Template

- [ ] **Name in system:** `welcome_priced`
- [ ] **Create in Meta Business Manager:**
  - Template category: **Marketing**
  - Language: **English**
  - Body text (copy-paste):
    ```
    Hello {{1}},

    Thank you for your enquiry about {{2}}.

    📦 *Product:* {{2}}
    💰 *Price:* {{3}}

    We're ready to help you. Tap *Confirm Order* to proceed, or let us know if you have any questions.

    Best regards,
    IndiaMart Team
    ```
  - Quick-Reply Buttons:
    - Button 1: Text = "✅ Confirm Order", Payload = `confirm_order`
    - Button 2: Text = "📞 Expect a Call", Payload = `expect_call`
- [ ] **Submit for Meta approval**
- [ ] **Copy Twilio Content SID** once approved (format: `HX...`)
- [ ] **Store SID** in database or `.env` as `L2D_WELCOME_PRICED_TEMPLATE_SID`

### Unpriced Welcome Template

- [ ] **Name in system:** `welcome_unpriced`
- [ ] **Create in Meta Business Manager:**
  - Template category: **Marketing**
  - Language: **English**
  - Body text (copy-paste):
    ```
    Hello {{1}},

    Thank you for your enquiry about {{2}}.

    We're currently checking availability and market rates for your order.

    📧 *Next step:* A sales coordinator will call or message you within 2 hours with a custom quote.

    Best regards,
    IndiaMart Team
    ```
  - Quick-Reply Buttons:
    - Button 1: Text = "📞 Expect a Call", Payload = `expect_call`
- [ ] **Submit for Meta approval**
- [ ] **Copy Twilio Content SID** once approved
- [ ] **Store SID** as `L2D_WELCOME_UNPRICED_TEMPLATE_SID`

### Bank Details Template

- [ ] **Name in system:** `bank`
- [ ] **Create in Meta Business Manager:**
  - Template category: **Transactional** (preferred for payment info)
  - Language: **English**
  - Body text (copy-paste — update bank details):
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
  - Quick-Reply Buttons:
    - Button 1: Text = "✅ Payment Done", Payload = `payment_confirmed`
- [ ] **Submit for Meta approval**
- [ ] **Copy Twilio Content SID** once approved
- [ ] **Store SID** as `L2D_BANK_TEMPLATE_SID`

### Follow-Up Template (30-Day Nurture)

- [ ] **Name in system:** `followup`
- [ ] **Create in Meta Business Manager:**
  - Template category: **Marketing**
  - Language: **English**
  - Body text (copy-paste):
    ```
    Hi {{1}},

    Hope you're enjoying your recent order! 😊

    We have some *new arrivals* that might interest you:

    📦 {{2}}

    Would you like to place a repeat order or explore other products? Tap below or reply with your enquiry.

    Best regards,
    IndiaMart Team
    ```
  - Quick-Reply Buttons:
    - Button 1: Text = "🛒 Place Order", Payload = `new_order`
- [ ] **Submit for Meta approval**
- [ ] **Copy Twilio Content SID** once approved
- [ ] **Store SID** as `L2D_FOLLOWUP_TEMPLATE_SID`

### Approval Tracking

- [ ] Create spreadsheet to track template approvals:

| Template | SID | Submitted | Approved | Status | Notes |
|----------|-----|-----------|----------|--------|-------|
| welcome_priced | HX... | 2026-06-20 | 2026-06-21 | ✅ Live | - |
| welcome_unpriced | HX... | 2026-06-20 | TBD | ⏳ Pending | - |
| bank | HX... | 2026-06-20 | TBD | ⏳ Pending | - |
| followup | HX... | 2026-06-20 | TBD | ⏳ Pending | - |

---

## Phase 3: Backend Integration

### Code Review & Verification

- [ ] Review `server/lib/whatsappSend.js`:
  - [ ] `sendTemplate()` function handles opt-out logic ✓
  - [ ] Variables mapped correctly (1, 2, 3 placeholders)
  - [ ] Error logging to `l2d_messages` table ✓
  - [ ] No error thrown; failures logged gracefully ✓

- [ ] Review `server/routes/leadToDispatchFunnel.js`:
  - [ ] Webhook endpoint at `POST /api/lead-funnel/whatsapp/webhook` ✓
  - [ ] `parseInboundButton()` recognizes "confirm_order" and "expect_call" ✓
  - [ ] Stage transitions documented ✓
  - [ ] Auto-send bank template on ORDER_CONFIRMED ✓
  - [ ] Idempotency check prevents duplicate welcome sends ✓

- [ ] Review database schema `server/db/leadToDispatchFunnelDb.js`:
  - [ ] `l2d_messages` table has columns: `id, lead_id, direction, channel, template, body, twilio_sid, status, error, created_at` ✓
  - [ ] `l2d_leads` table has columns: `id, sender_mobile, sender_name, opted_out, stage, ...` ✓
  - [ ] Indexes on `lead_id`, `created_at` for query performance

### Environment Variables Setup

- [ ] Create `.env` file in project root (never commit):
  ```bash
  TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  TWILIO_AUTH_TOKEN=your_very_long_auth_token_here
  TWILIO_WHATSAPP_FROM=+14155552671
  L2D_WELCOME_PRICED_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  L2D_WELCOME_UNPRICED_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  L2D_BANK_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  L2D_FOLLOWUP_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  ```

- [ ] Add to `.env.example` (committed, without secrets):
  ```bash
  TWILIO_ACCOUNT_SID=AC... # Twilio Account SID
  TWILIO_AUTH_TOKEN=... # Twilio Auth Token (get from Twilio Console)
  TWILIO_WHATSAPP_FROM=+14155552671 # Twilio WhatsApp number
  L2D_WELCOME_PRICED_TEMPLATE_SID=HX... # Template SID
  L2D_WELCOME_UNPRICED_TEMPLATE_SID=HX... # Template SID
  L2D_BANK_TEMPLATE_SID=HX... # Template SID
  L2D_FOLLOWUP_TEMPLATE_SID=HX... # Template SID
  ```

- [ ] Verify backend reads from `process.env`:
  ```bash
  cd server && npm run dev
  # Should not crash if missing Twilio vars (graceful degradation)
  ```

### Testing Locally

- [ ] Install dependencies:
  ```bash
  npm install twilio  # if not already installed
  ```

- [ ] Start backend: `npm run dev` (both client + server start)

- [ ] Create test lead in database:
  ```sql
  INSERT INTO l2d_leads (
    sender_mobile, sender_name, query_product_name, quoted_price, stage
  ) VALUES (
    '+919876543210', 'Test Customer', 'Test Product', 12500, 'LEAD_ENTERED'
  );
  ```

- [ ] Call API to advance lead (replace `YOUR_JWT_TOKEN` with valid JWT):
  ```bash
  curl -X PATCH http://localhost:5000/api/lead-funnel/leads/1/advance \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_JWT_TOKEN" \
    -d '{
      "to": "WELCOME_SENT",
      "send": "welcome",
      "quoted_price": 12500,
      "matched_item_name": "Test Product"
    }'
  ```

- [ ] Check console for errors; verify `l2d_messages` table has new entry:
  ```sql
  SELECT * FROM l2d_messages WHERE lead_id = 1 ORDER BY created_at DESC LIMIT 1;
  ```

---

## Phase 4: Sandbox Testing (Twilio)

### Join Twilio Sandbox

- [ ] Go to Twilio Console → Messaging → Try it out → WhatsApp Sandbox
- [ ] Note the **join code** (e.g., `join apple-monkey`)
- [ ] Save your personal WhatsApp number for testing
- [ ] Send join code to Twilio sandbox number via WhatsApp
- [ ] Receive welcome message confirming sandbox access

### Send Test Message from Sandbox

- [ ] Coordinator API: advance a test lead to WELCOME_SENT
- [ ] You should receive template message on WhatsApp within 5 seconds
- [ ] Verify message includes:
  - [ ] Correct customer name
  - [ ] Correct product name
  - [ ] Correct price (formatted as ₹X,XXX)
  - [ ] Two quick-reply buttons visible

### Test Inbound Reply

- [ ] From WhatsApp, tap the "Confirm Order" button
- [ ] Check backend logs for webhook trigger
- [ ] Verify database: lead should move to ORDER_CONFIRMED
- [ ] Verify bank template auto-sent
- [ ] You should receive bank template message within 5 seconds

### Test Free-Text Reply

- [ ] From WhatsApp, reply with custom text (e.g., "Can you call me?")
- [ ] Check `l2d_messages` table: inbound message should be logged
- [ ] If in WELCOME_SENT stage, lead should move to INTERESTED

---

## Phase 5: Production Deployment

### Pre-Production Verification

- [ ] All 4 templates Meta-approved (status = "approved" in Meta Business)
- [ ] Webhook URL updated in Twilio Console (not sandbox):
  - [ ] Set to production domain: `https://yourdomain.com/api/lead-funnel/whatsapp/webhook`
  - [ ] Method: POST
  - [ ] Saved ✓

- [ ] Environment variables loaded in production:
  - [ ] `TWILIO_ACCOUNT_SID` (production account, not sandbox)
  - [ ] `TWILIO_AUTH_TOKEN` (production token)
  - [ ] `TWILIO_WHATSAPP_FROM` (production WhatsApp number from business account)
  - [ ] All 4 template SIDs populated

- [ ] Webhook signature verification enabled (optional for early prod, required for compliance):
  - [ ] Middleware added to validate `X-Twilio-Signature` header
  - [ ] Auth token used for HMAC validation

- [ ] Error logging configured:
  - [ ] Sentry integration for failed sends
  - [ ] Email alert if send failure rate > 5%
  - [ ] Daily digest of template performance

### Monitoring Setup

- [ ] Create dashboard to track:
  ```sql
  -- Query 1: Template send success rate (last 24h)
  SELECT template, COUNT(*) as sends,
    SUM(CASE WHEN status IN ('sent', 'delivered', 'read') THEN 1 ELSE 0 END) as success
  FROM l2d_messages
  WHERE direction='out' AND created_at > datetime('now', '-1 day')
  GROUP BY template;
  ```

- [ ] Set up alerts:
  - [ ] If `welcome_priced` send fails 10+ times → alert Slack #l2d-alerts
  - [ ] If webhook down > 5 min → page oncall
  - [ ] Weekly report: template performance, inbound reply rate

- [ ] Document runbooks:
  - [ ] What to do if webhook down?
  - [ ] How to disable a failing template?
  - [ ] How to bulk re-send failed messages?

### Production Cutover

- [ ] Schedule cutover during low-traffic window (e.g., Sunday 9 PM)
- [ ] Notify coordinator: "WhatsApp templates now live"
- [ ] Create test lead; verify end-to-end send → reply
- [ ] Monitor logs for 1 hour post-deployment
- [ ] Celebrate! 🎉

---

## Phase 6: Ongoing Operations

### Weekly

- [ ] Run success rate query; compare to baseline
- [ ] Review failed sends; fix any issues (usually opt-out or phone normalization)
- [ ] Check Twilio billing; verify expected usage

### Monthly

- [ ] Review template performance with coordinator
- [ ] Gather customer feedback: are templates clear? useful?
- [ ] Propose template tweaks based on feedback
- [ ] Measure impact on funnel conversion (orders from WhatsApp vs other channels)

### Quarterly

- [ ] Review template compliance with Meta policies (re-read if rules updated)
- [ ] Plan new templates (e.g., for new funnel phases)
- [ ] Capacity planning: if volume grows 10x, will Twilio handle it?

---

## Support & Escalation

### Common Issues & Quick Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| Template not sending | SID not set | Check admin settings; copy exact SID |
| Message says "failed" | Phone number invalid | Check `normalisePhone()` logic; verify lead's `sender_mobile` |
| Webhook not triggered | URL wrong | Verify in Twilio Console; test with `curl` |
| Duplicate messages sent | Race condition in code | Check idempotency guard in `lastGoodSend()` |
| Customer opted out | Lead marked `opted_out=1` | Check why; un-opt if valid |

### Escalation Path

1. **Coordinator notices issue** → Slack #l2d
2. **PM/DevOps checks dashboard** → If <5% failure, continue monitoring
3. **If >5% failure** → Page on-call engineer
4. **Engineer debugs:**
   - Check `l2d_messages` table for error details
   - Check Twilio error logs
   - Check backend logs (Sentry)
5. **Mitigation:**
   - Disable failing template (set SID to null)
   - Notify coordinator of workaround (manual sends, retry later)
6. **Root cause analysis + fix** → Deploy + test

### Contacts

- **Twilio Support:** https://support.twilio.com (login with account)
- **Meta Business Support:** https://business.facebook.com/help/center
- **On-Call Engineer:** (defined in team runbook)
- **Product Manager:** dme@securedengineers.com

---

## Sign-Off

| Role | Name | Date | Status |
|------|------|------|--------|
| Project Lead | — | — | ☐ Reviewed |
| Engineering Lead | — | — | ☐ Approved |
| DevOps/Infra | — | — | ☐ Deployment Ready |
| QA | — | — | ☐ Test Plan Verified |

---

## Appendix: Template Payload Examples

### Example 1: Send Welcome (Priced)

**Request:**
```bash
curl -X PATCH https://yourdomain.com/api/lead-funnel/leads/42/advance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGc..." \
  -d '{
    "to": "WELCOME_SENT",
    "send": "welcome",
    "quoted_price": 25000,
    "matched_item_name": "Dye Sublimation Ink",
    "note": "Coordinator approved"
  }'
```

**Expected Response:**
```json
{
  "message": "Lead advanced",
  "stage": "WELCOME_SENT"
}
```

**Backend Action:**
- Calls `sendTemplate()` with:
  - `templateSid`: SID for welcome_priced
  - `variables`: { 1: "Customer Name", 2: "Dye Sublimation Ink", 3: "₹25,000" }
- Logs to `l2d_messages`: status = "queued" or "sent"
- Lead stage = "WELCOME_SENT"

**Customer Receives:**
```
Hello Customer Name,

Thank you for your enquiry about Dye Sublimation Ink.

📦 *Product:* Dye Sublimation Ink
💰 *Price:* ₹25,000

We're ready to help you. Tap *Confirm Order* to proceed, or let us know if you have any questions.

Best regards,
IndiaMart Team

[✅ Confirm Order] [📞 Expect a Call]
```

---

### Example 2: Inbound Button Tap

**Twilio Webhook POST to our backend:**
```
From: whatsapp:+919876543210
WaId: 919876543210
ButtonText: Confirm Order
ButtonPayload: confirm_order
MessageSid: SM1234567890abcdef
```

**Backend Processing:**
1. `parseInboundButton()` extracts: `{ from: "919876543210", action: "confirm_order", text: "Confirm Order" }`
2. Matches to active lead with number ending in `9876543210`
3. Records inbound in `l2d_messages`: direction='in', body="Confirm Order"
4. Triggers `ORDER_CONFIRMED` transition
5. Auto-sends bank template:
   - Variables: { 1: "Customer Name" }
   - Status: "queued" then "sent"
6. Lead stage advances: WELCOME_SENT → ORDER_CONFIRMED → BANK_SENT

**Customer Receives:**
```
Hi Customer Name,

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

---

## Related Documentation

- **Main Integration Guide:** [twilio-integration.md](./twilio-integration.md)
- **Lead-to-Dispatch Funnel Architecture:** See commit logs for feature/lead-to-dispatch-funnel
- **Frontend UI Components:** `client/src/components/funnel/`
- **Database Schema:** `server/db/leadToDispatchFunnelDb.js`
