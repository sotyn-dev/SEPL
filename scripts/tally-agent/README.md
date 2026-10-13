# SEPL Tally to ERP Sync Agent

This folder contains the lightweight background agent that runs on the **Main Tally Host PC / Server** in your office. It reads newly created Purchase and Payment vouchers from TallyPrime and automatically pushes them into your SEPL Cloud ERP.

---

## 1. Setup in TallyPrime (One-Time)

1. Open **TallyPrime** on the main host computer.
2. Press **F12** (Configure) &rarr; **Advanced Configuration**.
3. Under **Client/Server Configuration**:
   * Set **"Tally is acting as"** to: `Both` (or `Server`).
   * Set **"Enable ODBC"** to: `Yes`.
   * Set **"Port"** to: `9000`.
4. Press `Ctrl + A` to save and restart TallyPrime.
5. Keep your company open in Tally.

---

## 2. Setup the Agent on the Tally PC

1. Copy this entire `tally-agent` folder to any location on the Tally computer (e.g. `C:\SEPL-Tally-Sync`).
2. Make sure **Node.js** (v18 or higher) is installed on the computer. (Download from [nodejs.org](https://nodejs.org) if not installed).
3. Open Command Prompt or PowerShell in `C:\SEPL-Tally-Sync` and install dependencies:
   ```cmd
   npm install
   ```
4. Open `config.json` in Notepad:
   ```json
   {
     "tallyUrl": "http://localhost:9000",
     "erpBaseUrl": "https://securederp.in/api/tally-sync",
     "apiToken": "PASTE_YOUR_SYNC_TOKEN_HERE",
     "companyName": "SEPL",
     "syncIntervalSeconds": 120
   }
   ```
   * Replace `apiToken` with the token shown in your ERP under **Tally Bills &rarr; Tally Sync**.
   * Replace `erpBaseUrl` with your ERP domain (e.g. `https://securederp.in/api/tally-sync` or `http://localhost:5000/api/tally-sync` for testing).

---

## 3. Running the Agent

* **Manual run / Test**: Double-click `start.bat`.
* **Automatic on Windows Boot**:
  * Press `Win + R`, type `shell:startup` and hit Enter.
  * Right-click `start.bat` &rarr; **Create shortcut**.
  * Paste the shortcut into the Windows Startup folder.
  * *Result*: Every time the Tally computer starts, the sync agent will automatically start syncing in the background.

---

## 4. How It Works

* Every 2 minutes, the script checks Tally for new vouchers with `ALTERID > last_known_id`.
* **Purchase Vouchers**: Flow into the ERP **Tally Bills** register in `Pending Task Creation` state.
* **Payment Vouchers**: Automatically attach to the matching bill, record the payment amount and UTR, and mark the bill as `Closed` once fully paid.
