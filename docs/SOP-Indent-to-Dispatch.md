# Indent to Dispatch — Standard Operating Procedure

| | |
|---|---|
| **SOP reference** | SOP-PROC-01 |
| **Module** | Procurement → Indent to Dispatch |
| **Screen** | `/procurement` |
| **Applies to** | Site Engineers, Purchase Team, Accounts, Store, L1/L2/CRM Approvers, Admin |
| **Process owner** | Purchase Head |
| **Version** | 1.0 |

---

## 1. Purpose

To define the single authorised procedure for requesting, approving, purchasing, receiving and billing project material, so that:

- material is planned rather than bought in panic;
- no purchase is committed without competitive quotes and recorded approval;
- stock already owned is consumed before fresh material is bought;
- every rupee of shortage or over-billing is recovered from the vendor;
- the current position of any material request is visible without a phone call.

## 2. Scope

Covers all material movement for a project from the raising of an indent to the receipt, billing and payment of that material — including free-of-cost (FOC) items, returnable material (RGP), rented tools, and items outside the client BOQ.

Does **not** cover: labour payments (see Indent Labour Payment), client receivables (see Collections), or subcontractor billing.

## 3. Roles and responsibilities

| Role | Responsible for |
|---|---|
| **Site Engineer** | Raising the indent with correct site, category, item and quantity. |
| **L1 Approver** | First approval. Verifies need against stock and BOQ; adjusts approved quantity. |
| **L2 Approver** | Second approval, where the L2 gate is switched on. Final sign-off. |
| **CRM Approver** | Approves billable Extra indents (Schedule and Non-Schedule) and sets the client margin. |
| **Purchase Team** | Collecting three vendor quotes, finalising the rate, raising the Vendor PO, chasing the purchase bill. |
| **Accounts** | Clearing advance payments and old vendor dues that block despatch. |
| **Store / Site** | Recording receipt (GRN) with accurate received quantity. |
| **Admin** | Approval gate configuration, permissions, and opening an emergency indent day. |

## 4. Definitions — indent categories

Selecting the correct category is mandatory. It determines which items can be picked and which approvals apply.

| Category | Use when | Item source | Notes |
|---|---|---|---|
| **Material** | The item exists on the client BOQ. | BOQ line → sub-item from Item Master | The normal case. Covers PO and FOC items. |
| **RGP** | Material goes to site and returns (scaffolding, test equipment). | Item Master, type = RGP only | No BOQ link. Returnable Gate Pass. |
| **Extra · Schedule** | The item is on the BOQ but more quantity is needed than the BOQ allows. | BOQ line, quantity cap removed | Billable. Requires CRM approval. |
| **Extra · Non-Schedule** | The item is entirely outside the BOQ. | Item Master, free pick | Billable. Requires CRM approval and a margin %. |
| **Rental** | A tool is being rented rather than bought. | Item Master, type = RENTAL | Days × Rate/Day. Blocked if renting costs ≥ buying. |

## 5. Procedure

### 5.1 Stage 1 — Raise the indent

**Performed by:** Site Engineer · **Screen:** Raise Indent tab

1. Confirm today is an indent day. Routine indents are open on **Wednesday** (mid-week stock review) and **Saturday** (next-week lookahead) only. A green banner confirms raising is open.
2. If today is not an indent day and the material genuinely cannot wait, use **Raise Emergency Indent**, tick the emergency confirmation, and record a reason. The reason is mandatory and the indent is flagged EMERGENCY through the whole approval chain.
3. Click **Raise Indent**.
4. Select the **Site**. Sites are sourced from Business Book. Confirm the helper line reports BOQ items available; if it reports zero, the Client PO has not been uploaded — stop and get it uploaded first.
5. Confirm **Raised By**. This is locked to the logged-in user and cannot be changed.
6. Select the **Category** per section 4.
7. Add items:
   - Material / RGP / Extra · Schedule — select the BOQ line, then the sub-item from Item Master.
   - Extra · Non-Schedule / Rental — select directly from Item Master.
   - For Rental, enter Days and Rate per Day on each line.
8. Check the summary chips (BOQ items, sub-items, Chargeable, FOC, POs expected) against what was intended.
9. Submit. The indent is created with status SUBMITTED and enters the approval queue.

> **Control:** An indent cannot be backdated. The date and time are recorded automatically on creation.

### 5.2 Stage 2 — Approval

**Performed by:** L1 Approver, then L2 Approver where enabled. CRM Approver acts first on Extra indents. · **Screen:** Raise Indent tab → Approve

1. Open the indent and click **Approve**. The approval screen opens — do not treat this as a simple yes/no.
2. Read the **Stock check** banner. It reports how many lines are already covered by existing stock.
3. Review each line against the **Office Stock** and **Site Stock** columns.
4. Set the **Approved Qty** per line. This may be reduced below the requested quantity. Entering **0** approves the indent while rejecting that single line.
5. Where stock is to be issued rather than purchased, enter the quantity in **From Store**. The balance moves automatically to **To Procure**.
   - From Store is deliberately not pre-filled. Judge each case — transport from a distant store may cost more than fresh purchase, and stock may be reserved or of unusable quality.
6. For Extra indents, the CRM Approver enters the **Client quotation margin %** to be added on top of cost for the client's billable line.
7. Verify the **Approved Budget Total** and the From Store / To Procure split totals.
8. Click **Approve Indent**.

To reject: click **Reject** and record a reason. **The reason is mandatory** and is visible to the person who raised the indent.

> **Control:** Where the L2 gate is switched on, L1 and L2 must be different people. L1 approval alone does not release the indent.

**Result:** On approval, any From Store quantity generates a **Store Issue Challan** automatically. The remaining quantity becomes available in Vendor Rates.

### 5.3 Stage 3 — Collect vendor rates and finalise

**Performed by:** Purchase Team · **Screen:** Vendor Rates tab

1. Only indents that have cleared approval appear here. If an item is missing, it is not yet approved.
2. For each item, enter **three vendor quotes** — Name, Rate and Terms (Advance or Credit; Credit requires credit days).
   - Use the **Bulk fill** bar where one vendor quotes many items: tick the rows, select the vendor slot, pick the vendor and terms, and apply. Rates remain per item.
3. Use **PP Rate** (planning BOQ purchase price) and **Mktg Rate** (estimated minimum market rate) as reference only. They do not alter the entered quotes.
4. Click **Finalize** and confirm the selected vendor, rate and terms. The lowest quote is pre-selected; overriding it is permitted but must be a deliberate decision.

> **Control — no exception:** All three vendor quotes (name and rate) must be present before a rate can be finalised. This is enforced by the server and applies to Admin users as well.

### 5.4 Stage 4 — Raise the Vendor PO

**Performed by:** Purchase Team · **Screen:** Vendor PO tab

1. Work from the **Pending for Vendor PO** sub-tab — finalised rates with no PO yet.
2. Click **Create Vendor PO** and complete:

| Field | Instruction |
|---|---|
| PO Number | Read-only. Issued automatically as `VPO/YYYY/####` on save. |
| PO Date | Date of issue. |
| Link to Indent | Mandatory in practice — auto-fills the vendor and loads indent items. Without it, the Pending list will not clear. |
| Vendor | Auto-filled from the finalised rates where all items agree. |
| Expected Receipt Date | Date goods are due. Drives bill follow-up order and all delay reporting. Enter realistically. |
| Freight Terms | Ex-Works (we arrange transport) or FOR (vendor delivers to site). |
| Freight Amount | Added to the PO total and printed on the PO. |
| GST % | Defaults to 18. Change where the material attracts a different slab. |

3. Save. The PO prints in company format.
4. The PO requires **L1 approval followed by L2 approval**. It is not live and must not be issued to the vendor until L2 approval is recorded.

### 5.5 Stage 5 — Clear blocking payment

**Performed by:** Accounts · **Screen:** Payment tab

1. POs requiring an advance, or held against old vendor dues, appear under **Payment Urgent**. The vendor will not despatch until these are cleared.
2. Clear the payment and mark the PO cleared, recording a note.
3. The PO moves to **Recently Cleared** and becomes visible to the Purchase Team in Purchase Bills.

> **Control:** POs pending payment clearance are hidden from Purchase Bills. Purchase must not chase a bill on a PO the vendor is holding. A banner in Purchase Bills reports how many POs are hidden for this reason.

Where a PO carries no advance and no old-dues hold, it bypasses this stage entirely.

### 5.6 Stage 6 — Book the purchase bill

**Performed by:** Purchase Team · **Screen:** Purchase Bills tab

1. Work from the **Follow-up** sub-tab, which lists POs awaiting a vendor bill sorted by Expected Receipt Date, oldest first. Chase from the top.
2. Click **Upload Bill** against the PO.
3. Verify the per-item **PO Qty / Received / Short** table and correct the received quantity where the delivery was short. The bill amount recalculates.
4. Enter the bill number, bill date, and GST. Attach the bill file.
5. Save.

**Result:** A challan is generated automatically on saving a purchase bill. Do not raise one separately. The **Debit / Net Pay** column shows the amount payable after any debit notes.

### 5.7 Stage 7 — Despatch to site

**Performed by:** Purchase Team · **Screen:** Dispatch & Receiving tab

1. Work from **Ready to Dispatch** — billed POs with no client Sales Bill yet.
2. Select the document type:
   - **Sales Bill** — a tax invoice to the client. Requires the complete Bill To block: client name, address, GSTIN, state and state code, drawn from Business Book. GST splits automatically (CGST/SGST within Punjab, IGST outside). Missing fields are flagged and must be corrected in Business Book.
   - **Delivery Note / Challan** — for FOC, RGP and receipt-only movement. No client billing.
3. Where only a delivery note is required, use **Open Auto-Generated DN**, which is pre-filled from the PO with vendor, client, site, items and HSN.
4. Save and issue.

### 5.8 Stage 8 — Record receipt (GRN)

**Performed by:** Store / Site · **Screen:** Dispatch & Receiving tab → Mark Received

1. Open **Mark Received** against the PO or delivery note.
2. For every line, confirm the **Received** quantity against **Ordered**.
3. Where the received quantity is lower, record a **short reason** on that line.
4. Confirm the header indicator reads either "Full delivery" or the correct count of short lines.
5. Save.

**Result — three actions occur automatically:**

- Stock is increased by the **received** quantity, never the ordered quantity.
- Where material is short, a **short-supply Debit Note** is raised against the vendor.
- Where applicable, a **draft Sales Bill** is generated for completion.

> **Control:** The accuracy of stock, vendor recovery and client billing all depend on this stage. An inaccurate GRN silently under-recovers money from the vendor.

### 5.9 Stage 9 — Debit notes

**Performed by:** System (automatic); Purchase Team for discretionary cases · **Screen:** Debit Notes tab

Debit notes are raised automatically on variance:

| Type | Trigger |
|---|---|
| **Extra Rate** | Vendor bill exceeds the PO rate. |
| **Short Supply** | Received quantity is less than ordered. |
| **Rejected** | Material rejected at GRN. |

Use **Manual Debit Note** only for a discretionary claim outside these three. Each note prints in company format and its value is deducted in the Net Pay on the purchase bill.

### 5.10 Stage 10 — Track and report

**Performed by:** All · **Screen:** PO Pipeline tab

1. Each PO shows eight stages: Requested, Approved, Ordered, Dispatched, Received, Issued, Purchase Bill, Paid.
2. Delivery status is shown against the Expected Receipt Date:

| Indicator | Meaning |
|---|---|
| ETA *(date)* | On track, not yet due. |
| LATE *n*d | Overdue and not yet received. |
| on time | Received on or before the expected date. |
| was late *n*d | Received after the expected date. |
| no ETA set | Expected Receipt Date was not entered on the PO. |

3. Where a PO is late, the responsible person must **log a delay reason**. The reason is visible to everyone.

## 6. Mandatory controls

These are enforced by the system and cannot be bypassed by any user, including Admin.

| # | Control |
|---|---|
| 1 | Routine indents may be raised on Wednesday and Saturday only. Any other day requires an Emergency indent with a recorded reason. |
| 2 | All three vendor quotes (name and rate) must be present before a rate can be finalised. |
| 3 | A rental indent is blocked where the rental cost is equal to or greater than the cost of outright purchase. |
| 4 | A rejection cannot be saved without a reason. |
| 5 | PO numbers are issued by the system as `VPO/YYYY/####` and cannot be entered manually. |
| 6 | A Vendor PO requires both L1 and L2 approval before it is live. |
| 7 | POs blocked on payment are withheld from Purchase Bills until Accounts clears them. |
| 8 | Stock is increased by the received quantity, never the ordered quantity. |
| 9 | Where the L2 indent gate is enabled, L1 and L2 must be different people. |

## 7. Documents generated automatically

Do not raise any of the following manually.

| Document | Generated when |
|---|---|
| Store Issue Challan | An indent is approved with a From Store quantity. |
| Challan | A purchase bill is uploaded. |
| Debit Note — Short Supply | A GRN records a short receipt. |
| Debit Note — Extra Rate | A purchase bill exceeds its PO. |
| Draft Sales Bill | Material is received, where a client bill is due. |
| Quotation | An Extra · Schedule indent is raised. |

## 8. Master data — correct at source

The following cannot be corrected on this screen and must be fixed where the data originates.

| Symptom | Correct at |
|---|---|
| Site not listed when raising an indent | Business Book |
| No BOQ items load for the selected site | Upload the Client PO |
| Client GSTIN, address or state missing on a Sales Bill | Business Book |
| Item not available, or its rate is wrong | Item Master |
| A user cannot see a tab | Admin → Roles & Permissions |

## 9. Access

Visible tabs depend on the user's permissions for the `procurement` module:

| Permission | Sees |
|---|---|
| Create | Raise Indent only |
| Approve | All tabs — Vendor Rates, Vendor PO, Payment, Purchase Bills, Dispatch & Receiving, Debit Notes, PO Pipeline, Responsible |
| Admin | All tabs, plus Workflow Settings and emergency day control |

Approval gates are configured under **⚙ Workflow Settings** (Indent L1, Indent L2 with on/off switch, CRM, Vendor PO L1 and L2). Per-record RACI and SLA tracking is reported under **⚙ Responsible**. These are separate: Workflow Settings controls who may act; Responsible reports what happened.

## 10. Performance measures

| Measure | Target |
|---|---|
| Emergency indents as a share of total indents | Below 5% |
| POs received on or before Expected Receipt Date | Monitored on PO Pipeline |
| Late POs carrying a logged delay reason | 100% |
| Indent lines approved without checking stock coverage | Nil |

## 11. Exceptions and escalation

| Situation | Action |
|---|---|
| Material required on a non-indent day | Raise an Emergency indent with reason. For a site-wide emergency, Admin may open the full day. |
| Only one or two vendors will quote | The rate cannot be finalised. Obtain the third quote, or escalate to the Purchase Head for a documented decision. |
| Vendor holding despatch against old dues | Escalate to Accounts through the Payment tab. Do not chase the bill. |
| Client PO / BOQ not uploaded | Escalate to the CRM owner. The indent cannot proceed correctly without it. |
| Received material rejected on quality | Record the correct received quantity at GRN with the reason. A debit note is raised automatically. |
