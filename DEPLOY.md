# Put the Lead Tracker online (Vercel + Supabase)

When you finish, the tracker opens from any phone at your own web address. Your leads live in your Supabase database.
Your tracker on this computer is not touched. You can keep using it the whole time.

You do these steps yourself. Nobody else needs your passwords or keys. Do not paste them into chats or emails.

## What you need first

- A GitHub account (you have one).
- A Supabase project (any project works, a new one is fine).
- A Vercel account.
- Node on this computer (only for step 7).

## Step 1. Put this folder on GitHub

1. On GitHub make a new repository. Name it `Lead-Tracker-Cloud`. Choose **Private**.
2. Put the contents of the `Lead Tracker Cloud` folder in it. Do not upload the `node_modules` folder (the `.gitignore` file already skips it).

## Step 2. Get your database address from Supabase

1. Open your project in Supabase.
2. Go to **Project Settings**, then **Database**, then **Connection string**.
3. Pick **Transaction pooler**. It uses port **6543**.
4. Copy it. It has `[YOUR-PASSWORD]` in it. Replace that part with your real database password.
5. If your password has symbols, change them like this: `@` becomes `%40`, `#` becomes `%23`, `/` becomes `%2F`, `:` becomes `%3A`, `?` becomes `%3F`.
6. Write down which **region** your project is in (Project Settings, General). You need it in step 4.

You do not need to make any tables. The tracker makes them by itself the first time it opens. It also turns on Row Level Security for every table, with no rules. That means the public Supabase key cannot read anything.

## Step 3. Make three secret words

You need three more values. Each is any long random text.

| Name | What it is | How long |
|---|---|---|
| `APP_SECRET` | Locks your saved Zapmail key. Never change it later. | 40 or more characters |
| `SETUP_TOKEN` | A code you type once, when you set your password. | 8 or more characters |
| `CRON_SECRET` | Lets the daily Zapmail refresh in. | 16 or more characters |

To make a random one, open PowerShell and run this. Run it three times, one for each name.

```
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
```

Save all four values (these three and the database address) in your password manager.

## Step 4. Make the Vercel project

1. In Vercel press **Add New**, then **Project**.
2. Pick your `Lead-Tracker-Cloud` repository and press **Import**.
3. Set these:
   - **Framework Preset:** Other
   - **Root Directory:** leave it empty. (If the tracker sits inside a bigger repo, choose its folder here.)
   - **Build Command** and **Output Directory:** leave them alone. The file `vercel.json` already sets them.
4. Open **Environment Variables** and add these four. Paste the value exactly, with no spaces around it.
   - `DATABASE_URL`
   - `APP_SECRET`
   - `SETUP_TOKEN`
   - `CRON_SECRET`
5. Press **Deploy**.
6. After it is live, go to **Settings**, then **Functions**, then **Function Region**. Pick the region closest to your Supabase project. Then press **Redeploy** on the latest deployment. Same region means a faster tracker.

If you ever change an environment variable, press **Redeploy** afterwards. Vercel only reads them when it deploys.

## Step 5. Set your password (first time only)

1. Open your Vercel web address (it ends in `.vercel.app`).
2. You see **Set a password**. Type your `SETUP_TOKEN` in **Setup code**, and pick a password with 8 or more characters.
3. Press **Set password**.

After this, the setup step is closed for good. Nobody can use it again, even with the code.
Too many wrong tries locks that screen for 10 minutes.

## Step 6. Use it on your phone

1. Open the same web address on your phone and sign in.
2. Add it to your home screen. On iPhone: Share, then **Add to Home Screen**. On Android: the menu, then **Add to Home screen**.

## Step 7. Bring your 71 leads over

Pick **A or B**. Do not do both. The cloud tracker must be empty when you start.

### A. Quick way (lead details only)

1. In your tracker on this computer open **Settings**, then **Export**, then download `leads.csv`.
2. In the cloud tracker open **Leads**, then **Import**. Choose that file.
3. Check the preview and press **Import**.

This brings over names, phones, emails, websites, cities and notes only. These do NOT come over:

- Status and follow-up dates (every lead starts as New).
- Calls and messages you logged.
- Deals and money numbers.
- **Opt-outs.** A lead who asked you to stop comes in as a normal lead. Open each opted-out lead afterwards and mark it opted out again, or use way B.

### B. Full copy (everything, recommended)

This copies leads, every logged call and message, deals, opt-outs, daily counters and your targets.

1. In your tracker on this computer open **Settings** and press **Back up now**. This makes a plain copy of your data in its `data\backups` folder.
2. Open PowerShell in the `Lead Tracker Cloud` folder and run these one at a time. Use your real database address from step 2.

```
npm install
$env:DATABASE_URL = "paste your database address here"
node --no-warnings scripts/migrate-from-local.js "C:\path\to\Lead Tracker\data\backups\tracker-NEWEST.db"
```

3. That is a preview. It writes nothing and shows how many rows it will copy. If the numbers look right, run it again with `--commit` at the end:

```
node --no-warnings scripts/migrate-from-local.js "C:\path\to\Lead Tracker\data\backups\tracker-NEWEST.db" --commit
```

4. Close the PowerShell window when you are done.

The script only reads your old file. It stops if the cloud tracker already has leads.
Your old password and sessions are not copied (you set a new password in step 5).

### Your Zapmail key

The key is not copied, on purpose. In the cloud tracker open **Email** and paste the key again. It is saved locked with your `APP_SECRET`.

## How the Zapmail numbers refresh

- Every time you open the Email page, if the numbers are more than 5 minutes old.
- Every 5 minutes while the Email page stays open.
- When you press **Refresh now**.
- Once a day by itself, around 04:00 UTC (06:00 in South Africa). Vercel's free plan only allows one automatic run a day, so there is no refresh every 3 hours any more.

## Backups

- Supabase keeps its own backups. How many days depends on your Supabase plan. Look in Supabase under **Database**, then **Backups**.
- The tracker no longer makes backup files. Use **Settings**, then **Export** to download a zip of your data now and then. Keep it somewhere safe.

## How to go back (roll back)

Your tracker on this computer was never changed. To go back, just keep using it as before.

- To switch the cloud tracker off: in Vercel open the project, then **Settings**, then **Delete Project**. Your data stays in Supabase until you delete it there.
- Work you did in the cloud tracker does not flow back by itself. Before you switch back, download the zip from **Settings**, **Export** and keep it.

## If something looks wrong

| You see | What to do |
|---|---|
| "Cannot reach the database" | `DATABASE_URL` is wrong. Check the password, the `%40` style symbols, and that it is the **Transaction pooler** (port 6543). Fix it, then Redeploy. |
| "DATABASE_URL is not set" | You did not add it in Vercel. Add it, then Redeploy. |
| "SETUP_TOKEN is not set" | Add `SETUP_TOKEN` in Vercel (8 or more characters), then Redeploy. |
| "That setup code is not right" | Type the exact `SETUP_TOKEN` from Vercel. |
| "APP_SECRET is not set" | Add `APP_SECRET` (16 or more characters, use 40), then Redeploy. |
| "The saved Zapmail key cannot be read" | `APP_SECRET` was changed. Press Disconnect on the Email page and paste the key again. |
| "That file is too big" | Vercel allows about 4.5 MB per upload. Split a very big CSV in two and import each part. |
| Anything else | In Vercel open the project, then **Logs**. The error is written there. |

## Good to know

- Opening the tracker after a quiet spell can take a second or two longer. That is normal for Vercel.
- The tracker is private. Every page and every number needs your password. It also tells search engines not to list it.
- Your cookie lasts 30 days. After that you sign in again.
