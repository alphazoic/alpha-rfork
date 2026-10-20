# Multi-domain catch-all inbox

M3 combines mail for many domains and mail connections in one inbox. Domains in
the same Cloudflare account can share one mail Worker and D1 database. There is
no hardcoded domain count in M3. Cloudflare execution, storage, and account
quotas still apply; additional mail connections let you split storage and traffic.

The inbox receives mail and can supply confirmation emails to automated MEGA
signup when Cloudflare domains are selected in Settings. It does not buy domains,
modify Cloudflare DNS or routing automatically, or send email.

## New setup: one connection for your domains

1. Connect the domains to your Cloudflare account and wait for their nameservers
   to become active. Preserve existing website/email DNS records when moving a
   domain already in use. Registration and renewal remain with your registrar.
2. In M3, open **Inbox → Manage domains → Export Worker setup**. Open **SETUP.md** in
   the exported folder. The files include both database migrations.
3. Open a terminal in that exported folder. With Node.js 22.13 or newer and npm:

~~~sh
npm ci
npx wrangler login
npx wrangler d1 create m3-mail-inbox
~~~

Put the returned database ID in **wrangler.jsonc**, replacing
REPLACE_WITH_DATABASE_ID. Use the Cloudflare account that owns your domains.
For a new multi-domain setup, leave MAIL_DOMAIN empty: domain registrations
will be stored in the database, not in the deployment configuration.

~~~sh
npx wrangler d1 migrations apply m3-mail-inbox --remote
npx wrangler deploy
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put INBOX_TOKEN
~~~

Keep the generated token and paste it when prompted by secret put. It must
contain 32–256 letters, digits, underscores or hyphens. Keep it out of source
control and URLs. Anyone with it can read mail and manage the domain registry.

4. In M3's **Mail connections** form, enter a name, the deployed HTTPS
   workers.dev URL, and that token. Select **Save & test** once.
5. In **Add domains**, paste your domain names, one per line or separated by
   commas. Each name is validated independently. Duplicates and invalid entries
   are reported individually; valid names can still be added. Large lists are
   submitted in batches of ten to respect D1's per-invocation query limits.
6. In Cloudflare, enable Email Routing for each domain and approve its required
   mail DNS records. Set each domain's catch-all rule to **Send to a Worker** and
   select this mail Worker. No external forwarding inbox is required.

Registering a domain in M3 does not configure its Cloudflare routing. MX changes
replace that domain's incoming mail destination, so check any existing mail
service before enabling routing.

Cloudflare guides: [domain setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/),
[email setup](https://developers.cloudflare.com/email-service/get-started/route-emails/),
[catch-all routing](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/).

## Confirm delivery for each domain

Select a domain in the inbox sidebar and choose **Test delivery**. M3 displays
a unique test address. Send any message to it from another email provider, then
refresh M3. The domain changes to **Receiving confirmed** only after its Worker
actually receives that test message.

- **Setup incomplete:** domain registered, with no received mail or requested test.
- **Awaiting test email:** delivery has not yet been confirmed by the current test.
- **Receiving confirmed:** the current test address received a message.
- **Connection error:** M3 cannot sync this connection; cached headers remain.
- **Receiving disabled:** the Worker rejects new mail for this domain.

These statuses do not claim to inspect Cloudflare DNS or routing. **Save & test**
checks the Worker/API/database connection, not SMTP delivery.

Choose **Disable receiving** only when you want the Worker to reject new mail.
Existing messages stay until their normal expiry. **Disconnect from M3** removes
that connection's local settings and cache, without changing Cloudflare routing
or deleting its remote messages.

## Reading and managing mail

The default **All domains** view combines all connections. Select a domain to
filter mail; recipient and subject/sender/recipient search apply within that
selection. Use the connection selector to restrict the sidebar and inbox to one
backend. Domain search and paginated domain lists keep large collections usable.

The inbox loads 40 message summaries at a time and fetches a body when selected.
Load older messages as needed. Refreshing preserves already loaded older messages,
the selected message, and scroll position. New arrivals merge into that view.

One connection is refreshed for all its domains together. After an initial
snapshot, version 2 Workers send incremental changes. Checkpoints and headers
are stored in **mail-inbox-cache.sqlite** in M3's user-data folder. Updates and
checkpoints are committed together. Initial or expired-checkpoint snapshots
continue in bounded pages, so large collections sync over multiple passes.
If an individual backend is unavailable, others continue updating. Automatic
retries back off; **Refresh** allows an immediate retry.

M3 supports multiple mail connections with different Worker URLs and credentials.
Use **New connection…** to add another. Connect each database only once, even if
more than one Worker URL points to it. Connection IDs are part of message
identities, so identical numeric IDs from different databases cannot collide.

## Upgrade an existing single-domain setup

The desktop app automatically converts the existing connection settings to the
new format, retaining a **mail-inbox.v1-backup.json** copy of the original file.
Your existing token storage method remains supported.

Old version 1 Workers remain readable, including historical paging, while you
prepare the upgrade. They show **Legacy Worker** and cannot accept additional
domain registrations through M3 until upgraded.

To upgrade the Worker:

1. Export the new setup files, keep the existing Worker name and D1 database ID,
   and retain your old MAIL_DOMAIN value in **wrangler.jsonc** for the upgrade.
   This bootstraps the old domain even if its inbox is empty, and preserves
   domain-restricted version 1 API access for older desktop clients.
2. Back up the existing D1 database before applying migrations. For example:

~~~sh
npx wrangler d1 export m3-mail-inbox --remote --output before-multi-domain.sql
npx wrangler d1 migrations apply m3-mail-inbox --remote
npx wrangler deploy
~~~

The new **0002_multiple_domains.sql** migration adds the domain registry and sync
change stream. It preserves message IDs and bodies and assigns existing messages
to their recipient domains. Use Wrangler's migrations command; do not manually
re-run previously applied SQL files.

3. Keep the existing INBOX_TOKEN secret. The deployment does not require token
   rotation or new DNS/catch-all rules for the old domain.
4. Refresh M3, then add further domains and configure their catch-all rules.

The new API checks backend identity and rebuilds its local index if the remote
database is replaced. A database replacement is not a remote-mail backup:
only messages present in that database can be recovered.

## Token storage

M3 saves connections in **mail-inbox.json** in Electron's user-data folder,
separate from ordinary settings. It uses OS-protected encryption when available.
If secure storage is unavailable (including Linux basic_text) or encryption
fails, it saves the token as plain text in that file. Both formats persist across
normal restarts. The connection panel shows which method was used.

Settings are replaced atomically with owner-only permissions where supported.
The local metadata index does not store tokens or message bodies. A local token
loads regardless of keyring availability; its storage method changes only on
an explicit save. An inaccessible encrypted token must be entered once again
if no readable local copy exists. To rotate a token, update the Worker secret
and save the new token in its M3 connection.

## Retention and practical limits

Cloudflare receives mail while M3 is closed. Messages expire after seven days;
an hourly job deletes expired messages and old sync changes. A client with an
expired checkpoint rebuilds its index, including all still-retained mail and the
domain registry. Domains do not expire with their messages.

Previews parse messages up to 1 MiB and cap message text at 128 KiB. Larger or
unparseable messages get a metadata entry explaining the missing preview.
Attachment names are listed for parsed messages; contents are not stored.
HTML is converted to inert text. Scripts and remote images never run.

One shared backend avoids a separate Worker, scheduled job, and polling loop for
every domain. Storage and throughput remain finite. Add additional connections
or upgrade capacity when needed; M3 imposes no fixed domain maximum. Both normal
mail and catch-all spam consume Cloudflare resources.

Cloudflare documentation: [Email limits](https://developers.cloudflare.com/email-service/platform/limits/),
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Development checks

With Node.js 22.13 or newer:

~~~sh
npm --prefix cloudflare/mail-worker ci
npm run test:inbox
npm run test:signup-mail
npm run test:signup-mail-ui
npm run test:inbox-ui
~~~

Tests use real MIME parsing, SQLite fixtures, two mail backends, and an isolated
Electron profile. They cover migration, credential fallback, bulk domains,
delivery tests, pagination, incremental sync, failure isolation, restarts, and
large domain collections. They do not contact Cloudflare or MEGA.

## Automated signup email

After confirming delivery, open **Settings → Signup email**, select **Cloudflare domains**, and save settings. **Temp mail** remains the default and keeps the existing temporary-email providers.

With Cloudflare selected, every account created by Upload or Bulk Import uses an enabled domain from your connected inbox Workers. Domains are shuffled, used once each, and reshuffled after the deck is exhausted. Each attempted registration consumes a turn, including failures. The remaining deck is saved across restarts in `mail-signup-rotation.json` in M3’s user-data folder. Changes to the enabled domains are picked up before the next attempt.

Addresses use readable word combinations and a numeric suffix, such as `maple.river4821@example.com`. Passwords, MEGA display names, tool preference, and account logging work as before. Confirmation emails are checked in the background for up to two minutes per attempt; the Inbox tab does not need to be open. Failed attempts proceed through the existing tool fallback using Cloudflare domains only; M3 does not silently switch to temporary mail.
