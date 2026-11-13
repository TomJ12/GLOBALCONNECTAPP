# Putting the Global Connect demo on the internet (Fly.io, London)

This guide puts the **demo** on a private web address so you can show it to someone
without your laptop: the client app, the API and the ops console, from one small server
in London.

> **It is a demo. Do not put real client data in it.** See
> ["This is a demo"](#this-is-a-demo-do-not-put-real-client-data-in-it) before you start.

What you get:

- an address like `https://your-name-here.fly.dev` (and, if you want, `https://demo.yourdomain.co.uk`);
- a **demo password** in front of everything: nobody sees anything until they type it;
- the same sample companies and people as `npm run demo`, kept between restarts.

What it is not: a live service. The providers are mocks, the "emails" are lines in a log,
and the server will not run in its real (strict) mode at all yet.

Everything below was written from Fly.io's documentation as it stood on
**13 November 2026**, and the Docker image was built and run locally. **Nobody has run
these commands against a real Fly.io account** (it needs yours). Where a step might
not behave exactly as described, it says so. If something differs, stop and ask rather
than guess.

---

## 0. What you need

- A **Fly.io account with a payment card.** There is no free tier. New accounts get a
  short trial (2 hours of running time or 7 days, whichever ends first, and trial
  machines switch themselves off after 5 minutes), which is not enough to keep a demo
  up, so expect to add a card. See "What it costs" below: roughly **US$7 to $9 a month**
  left running.
- A terminal. **Use the GitHub Codespace you already use for this project**: it has
  everything needed (`git`, `openssl`), and the commands below are written for it. A
  macOS Terminal works the same way.
- About 30 minutes.
- A password manager, to keep four values this guide generates. **One of them (the
  data encryption key) cannot be recovered if lost.**

Open the Codespace, open its terminal, and make sure you are in the project folder and
up to date:

```bash
git pull
```

## 1. Install the Fly command (`fly`)

```bash
curl -L https://fly.io/install.sh | sh
```

It ends by printing two `export` lines. Copy them, paste them into the terminal and
press Enter (they tell the terminal where `fly` was put). Then check:

```bash
fly version
```

You should see a version number. (Other ways to install: <https://fly.io/docs/flyctl/install/>.)

## 2. Create the account and sign in

```bash
fly auth signup
```

It prints a web address: open it in your browser, create the account, add the payment
card when asked, and come back to the terminal. If you already have an account, use
`fly auth login` instead. Check with:

```bash
fly auth whoami
```

It should print your email address.

## 3. Choose a name and create the app (nothing runs yet)

The name becomes the address, so it must be unique across all of Fly.io. Pick something
like `globalconnect-demo-tj` (lower-case letters, numbers and dashes).

```bash
fly launch --copy-config --no-deploy --ha=false --name globalconnect-demo-tj --region lhr
```

- `--copy-config` uses the settings in this project's `fly.toml`.
- `--no-deploy` creates the app but starts nothing yet (the secrets come first).
- `--ha=false` means **one** machine. This matters: see "One machine only" below.
- `--region lhr` is London.

If it asks **"Do you want to tweak these settings before proceeding?"** answer **N**.
If it says the name is taken, run it again with another name. When it finishes, the
file `fly.toml` has your app's name on its `app = ` line. From here on, wherever this
guide writes `globalconnect-demo-tj`, use your own name.

## 4. Create the disk for the database, in London

```bash
fly volumes create gc_data --region lhr --size 1 --yes
```

This is a 1 GB disk called `gc_data`. Fly will warn that a single volume is not
redundant; that is expected for this demo (see "Backing up"). Check it:

```bash
fly volumes list
```

You should see one volume, `gc_data`, region `lhr`, size 1 GB.

## 5. Set the secrets

Four random values and one password you choose. They are stored encrypted by Fly and
given to the server when it starts; they are never in this repository or in the image.

**5a. The demo password.** This is what you give to the people you show the demo to.
At least 12 characters, nothing you use anywhere else. Replace the words in quotes:

```bash
fly secrets set DEMO_ACCESS_PASSWORD='choose-your-own-long-phrase'
```

**5b. The data encryption key.** It encrypts the authenticator keys in the database.
Generate it, **look at it, and save it in your password manager now** (name it
"Global Connect demo: DATA_ENCRYPTION_KEY"). Without it a backup of the database
cannot be fully read.

```bash
KEY="$(openssl rand -base64 32)"; echo "$KEY"
fly secrets set DATA_ENCRYPTION_KEY="$KEY"
```

**5c. The other two**, which nobody needs to know (they can be replaced at any time;
replacing `SERVER_SECRET` just signs everyone out of the gate):

```bash
fly secrets set SERVER_SECRET="$(openssl rand -base64 32)" ADMIN_TOKEN="$(openssl rand -base64 32)"
```

**5d. For the first start only**, ask the server to print the activation links for the
sample accounts (you will remove this again in step 8):

```bash
fly secrets set DEMO_SETUP_CODES=1
```

After each command Fly may say there are no machines to update yet. That is expected:
nothing is running. Check that all five are there (only names are shown, never values):

```bash
fly secrets list
```

You should see `ADMIN_TOKEN`, `DATA_ENCRYPTION_KEY`, `DEMO_ACCESS_PASSWORD`,
`DEMO_SETUP_CODES` and `SERVER_SECRET`.

## 6. Deploy

```bash
fly deploy --ha=false
```

This builds the app on Fly's builders and starts one machine. It takes five to ten
minutes the first time (most of it is building the web app). It should end with a line
saying the app is deployed and give the address. Then:

```bash
fly status
```

You should see **one** machine, in `lhr`, state `started`, with its health check
passing (`1 total, 1 passing`). If there are two machines, see "One machine only".

If the deploy fails or the machine keeps restarting, look at the log (step 7): the
server says in plain words what it refuses to start without.

## 7. Get the first activation links

```bash
fly logs --no-tail
```

(or just `fly logs`, which keeps showing new lines until you press Ctrl+C.)

Look for the block that begins `DEVELOPMENT MODE` and lists six accounts, each with a
code and a link starting with your address:

- three sample clients: `amira@northfield.example`, `ben@castlebrook.example`,
  `dana@adviser.example` (links ending `/activate#code=…`);
- three demo staff: `ops.admin@…`, `ops.admin2@…` (ops admins) and `ops.second@…`
  (an ops user) (links ending `/ops/activate#code=…`).

**Copy the six lines somewhere private now.** The codes are valid for 72 hours and
each works once. Then:

1. Open `https://globalconnect-demo-tj.fly.dev` (your name). You get the page
   **"Global Connect demo: sample data only"**. Type the demo password.
2. Open one of the client links and activate it exactly as in the README's walkthrough
   (password, authenticator app, recovery codes). Remember that a payment needs **two**
   activated people in the same company (Amira and Dana, for instance).
3. Open a staff link (`…/ops/activate#code=…`) and activate it the same way, then sign
   in at `https://globalconnect-demo-tj.fly.dev/ops`.

## 8. Switch the link printing off again

```bash
fly secrets unset DEMO_SETUP_CODES
```

This restarts the machine (about ten seconds). From now on the server prints no
activation codes when it starts. The codes you copied stay valid.

**How people get links after that**

- From the ops console, as in the README: create the client user, request an
  activation link, a second staff member approves it. "Emailing" the link means
  **printing the whole email in the server's log**: run `fly logs` and look for
  `DEVELOPMENT OUTBOX`. There is no real email in the demo.
- For a sample client whose code ran out, from your terminal:

  ```bash
  fly ssh console -C "gc invite amira@northfield.example"
  fly logs --no-tail
  ```

- For an ops admin when fewer than two exist (for example after the 72 hours ran out
  before you activated them):

  ```bash
  fly ssh console -C 'gc create-ops-admin you@globalconnect.example "Your Name"'
  fly logs --no-tail
  ```

  The address must be at `globalconnect.example` in the demo (the staff domain it is
  set up with). Or simply repeat steps 5d, wait for the restart, read the log, and do
  step 8 again: accounts that are not yet activated get fresh codes once their old
  ones have expired.

Because the links are in the log, **treat `fly logs` as private**: anyone with access
to your Fly account can read them. That is acceptable for sample accounts and is one
of the reasons this must stay a demo.

---

## One machine only

The database is a single file on one machine's disk. A second machine would have its
own, empty database, and visitors would land on one or the other at random. So:

- always deploy with `fly deploy --ha=false`;
- **never** run `fly scale count 2` (or more), and do not add regions;
- `fly status` should always show exactly one machine. If it ever shows two, remove
  the extra one: `fly machine list`, then `fly machine destroy <id of the newer one> --force`.

It also means that if Fly's hardware under that machine fails, the demo is down until
you redeploy, and what was on the disk may be lost. Hence backups.

## Redeploying after a change

When the project has been updated:

```bash
git pull
fly deploy --ha=false
```

The accounts, sessions and audit log are kept (they are on the volume). The mock
providers' own data (balances, payees you added, payments) starts again from the
samples on every restart: see "Known oddities".

## Viewing the log

```bash
fly logs            # live; Ctrl+C to stop
fly logs --no-tail  # what is there now, then stop
```

## Backing up

Take a consistent copy of the database and download it. Use today's date in the name:

```bash
fly ssh console -C "gc backup /data/backup-2026-11-13.sqlite"
fly ssh sftp get /data/backup-2026-11-13.sqlite ./backup-2026-11-13.sqlite
fly ssh console -C "rm /data/backup-2026-11-13.sqlite"
```

The first line makes the copy on the server (it is safe while the server is running),
the second downloads it to the folder you are in, the third removes the copy from the
server's disk. **Do not commit the downloaded file to git, and do not leave it in the
Codespace**: download it to your own computer (right-click the file in the Codespace's
file list, Download) and delete it there. It contains the password hashes and audit log
of the demo. To read the authenticator keys inside it you also need the
`DATA_ENCRYPTION_KEY` you saved in step 5b; keep the two apart.

To check the audit log has not been altered:

```bash
fly ssh console -C "gc audit-verify"
```

**Fly's own snapshots.** Separately, Fly takes a snapshot of the whole volume every
day and keeps five days of them (`snapshot_retention` in `fly.toml`). They are a
second safety net, not a replacement for the download above: they live in the same
Fly account, and restoring one means creating a new volume from it
(`fly volumes snapshots list <volume id>`, then
`fly volumes create gc_data --snapshot-id <id> --region lhr`). Snapshots are charged
for by size (see costs); at this size they fall inside the free allowance.

## A custom domain (optional), for example `demo.yourdomain.co.uk`

1. Tell Fly the name:

   ```bash
   fly certs add demo.yourdomain.co.uk
   ```

   It prints the DNS records it wants. You can see them again at any time with
   `fly certs setup demo.yourdomain.co.uk`.

2. Ask whoever manages your domain's DNS to add this record (send them exactly this):

   | Type | Name (host) | Value (points to) | TTL |
   |---|---|---|---|
   | `CNAME` | `demo` | `globalconnect-demo-tj.fly.dev` | 3600 (or "automatic") |

   If `fly certs add` also printed an `_acme-challenge` record, ask for that one too,
   exactly as printed; it lets the certificate be issued before the name is switched
   over. **Use the values Fly printed if they differ from this table.** If the domain
   is on Cloudflare, the record must be "DNS only" (grey cloud), not proxied.

3. Wait for DNS (minutes to an hour), then:

   ```bash
   fly certs check demo.yourdomain.co.uk
   ```

   When it says the certificate has been issued, Fly has obtained a free certificate
   from Let's Encrypt and will renew it by itself. Nothing else to do for https.

4. Tell the server its new address, so the links it "emails" and its cookies use it:

   ```bash
   fly secrets set APP_URL=https://demo.yourdomain.co.uk
   ```

   The machine restarts. From then on **use only the new address**; give that one out,
   not the `fly.dev` one. (The old address still answers, but links in "emails" point
   at the new one.)

## Stopping it, and what it costs

**What it costs to leave running.** Fly charges by the second for what exists. For
this demo, with prices as published on 13 November 2026:

| Item | Price | A month |
|---|---|---|
| One `shared-cpu-1x` machine with 1 GB of memory, running all month | published as about $5.70 to $6.70 in Fly's cheapest regions; other regions cost more (Frankfurt was shown as $7.73); **London's exact figure was not on the page** | about **$6 to $8** |
| 1 GB volume | $0.15 per GB per month | $0.15 |
| Daily volume snapshots | $0.08 per GB per month, first 10 GB free | $0 |
| Address and certificate | shared IPv4 and IPv6 free; first 10 single-name certificates free | $0 |
| Data sent to visitors | $0.02 per GB (Europe) | pennies |

So **roughly US$7 to $9 a month**, plus VAT if it applies to you. Prices change and
Fly's pages disagreed slightly with each other on the day; look at the calculator on
<https://fly.io/pricing/> with region London, and at your own bill under **Billing** in
the Fly dashboard after the first few days. Pages checked: <https://fly.io/docs/about/pricing/>,
<https://fly.io/pricing/>, <https://fly.io/docs/about/free-trial/>.

**To pay less while nobody is using it**, either:

- **Stop it between demos** (keeps the disk and all accounts; you pay about $0.15 a
  month for the disk plus a few cents for the stopped machine's image):

  ```bash
  fly machine list                 # note the machine's id
  fly machine stop <id>
  ```

  With the settings in `fly.toml` the next visit to the address starts it again by
  itself (it takes a few seconds), so to keep it stopped, do not open the address. To
  start it on purpose: `fly machine start <id>`.

- or let Fly stop it whenever it has been idle for a few minutes: in `fly.toml` change
  `auto_stop_machines = "off"` to `"stop"` and run `fly deploy --ha=false`. Read
  "Known oddities" first: every stop resets the mock providers' data.

**To delete everything** (machine, disk, snapshots, certificates, secrets; this cannot
be undone, and billing for it stops):

```bash
fly apps destroy globalconnect-demo-tj
```

Then check **Billing** in the dashboard a day later, and delete any backup files you
downloaded.

## Known oddities of the demo on a server

- **The mock providers forget on every restart.** Accounts, sessions, held payments
  and the audit log are in the database and survive. Balances, payees you added and
  payments that reached a "provider" are in the server's memory and go back to the
  samples whenever the machine restarts (a deploy, a secret change, a stop). A held
  payment to a payee you added before a restart is then refused as "payee changed",
  which is the server doing its job with a provider that lost its data. For a clean
  showing, use the seeded payees on Northfield, or add the payee again.
- **First visit after a stop is slow** (a few seconds) while the machine starts.
- **Signing in takes about a second.** Password checks are deliberately expensive; the
  machine size was chosen for them (see below).

## What the settings are, and why

- **Region `lhr` (London)**, one `shared-cpu-1x` machine with **1 GB** of memory.
  Checking a password uses 128 MB (scrypt with N = 2^17) and the server allows at most
  four checks at once (two client, one staff, one decoy). Measured: about 590 MB at the
  peak, plus about 90 MB for the server itself. 512 MB is too little; 1 GB leaves about
  a third spare. More simultaneous sign-ins than that wait in a short queue.
- **The demo gate.** With `DEMO_ACCESS_PASSWORD` set, everything except `/healthz`
  (which answers `{"ok":true}` and nothing else, for Fly's health check) requires the
  gate first: a signed, HttpOnly, Secure cookie, valid 12 hours, five password
  attempts a minute per visitor. It is a door in front of the demo, not a replacement
  for anything: clients still sign in with password and authenticator code, staff
  likewise.
- **The server refuses to start** in demo (development) mode on Fly, or on any address
  that is not your own machine or a Codespace, unless the demo password,
  `SERVER_SECRET`, `ADMIN_TOKEN`, `DATA_ENCRYPTION_KEY` and a database path are all
  set and the address is https. No key file is written beside the database there.
- **https everywhere.** Fly terminates https and redirects http (`force_https`). The
  server knows its address is https, so its cookies are `Secure` (the staff cookie and
  the gate cookie are bound to the exact host) and every response tells browsers to
  use https only (HSTS).
- **Visitors' addresses** (for rate limits and the audit log). Fly's documentation says
  the `X-Forwarded-For` header it passes on ends with the app's own Fly address, with
  the visitor's address before it; the connection itself comes from Fly's proxy. So
  two hops are Fly's: `TRUST_PROXY = "2"`. **Check this once after the first deploy:**
  sign in to the ops console, open **Audit log**, and look at the *source* column of
  your own sign-in. It should be your own public IP address (search the web for "what
  is my IP"). If it shows the same address for everyone, or an address that is not
  yours, tell your engineer: the setting needs adjusting before the rate limits can be
  relied on.
- **Stops and restarts.** Fly sends the server an interrupt signal; it finishes what it
  is doing and closes the database cleanly.

## This is a demo: do not put real client data in it

- **Sample data only.** Every company, person, balance and payment is made up. Do not
  create client users with real names, real email addresses or real bank details, and
  do not type real payment details in to "see what happens".
- **It is not secure enough for real data, by design.** Activation "emails" are printed
  in a log; the providers are mocks; one shared password guards the door; there is one
  machine with one disk; nobody is monitoring it. The server's real mode refuses to
  start at all until there is a live provider connection and a real mailer, and this
  demo deliberately does not change that.
- **Fly.io is a company based in the United States.** The machine and its disk are in
  London, but the account, the logs, the builders that make the image and Fly's staff
  access are governed by a US company's terms. That is fine for made-up data. It is
  **not** a decision about where real client data may be processed.
- **A live deployment needs its own data-protection review** before any real client's
  data goes near it: who the processor and sub-processors are, where data and logs are
  stored and for how long, international transfers, access by the hosting company,
  backups and deletion, breach handling, and what your regulated providers and your
  own obligations (UK GDPR, your contracts) require. None of that has been done for
  this demo, and choosing Fly.io for the demo does not mean it is the right choice for
  the real thing.
- If the demo password gets out, change it (`fly secrets set DEMO_ACCESS_PASSWORD='…'`;
  everyone is asked for the new one at once). When you no longer need the demo,
  delete it.
